// Browser regressions for restored manual payments; responses are simulated.
// These checks never create a Mercado Pago charge and do not replace Preview tests.
// Run: npm ci && npm run test:browser. Uses /usr/bin/chromium when available;
// otherwise install Playwright Chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const config = require('../../vercel.json');
const id = 'a'.repeat(64);
const createdAt = new Date().toISOString();
let browser, server, base;

before(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    if(pathname === '/' || pathname === '/mesa.html') {
      for(const rule of config.headers || []) if(rule.source === '/(.*)' || rule.source === '/') {
        for(const header of rule.headers) res.setHeader(header.key, header.value);
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(fs.readFileSync(path.join(root, pathname === '/mesa.html' ? 'mesa.html' : 'index.html')));
    }
    if(/^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname)) {
      const file = path.join(root, pathname);
      if(fs.existsSync(file)) {
        res.setHeader('Content-Type', pathname.endsWith('.js')?'text/javascript':'image/webp');
        return res.end(fs.readFileSync(file));
      }
    }
    res.statusCode = 404; res.end('Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
});
after(async () => {
  if(browser) await browser.close();
  if(server) await new Promise(resolve => server.close(resolve));
});

async function harness() {
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  page.setDefaultTimeout(8000);
  const bodies=[],errors=[],online=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.href.includes('mercadopago') || url.pathname.startsWith('/api/mp-')) online.push(url.href);
    if(url.origin!==base)return route.abort();
    const json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/api/disponibilidade')return json({ingredientes:{},produtos:{},operacao:{modoLoja:'aberto',canaisAtendimento:{entrega:true,retirada:true}}});
    if(url.pathname==='/api/estimativa')return json({estimativaMinutos:{minimo:45,maximo:60}});
    if(url.pathname==='/api/pedidos'){
      bodies.push(route.request().postDataJSON());
      return json({pedido:{id,numero:'42',referencia:'TESTE',status:'pendente',criadoEm:createdAt},impressaoAtiva:true});
    }
    return route.continue();
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  return {context,page,bodies,errors,online};
}
for(const method of ['pix','dinheiro','debito','credito'])test('confirma pedido manual: '+method,async()=>{
  const h=await harness();
  try{
    await h.page.locator('.qty-stepper[data-name="Dog Simples"] .plus').click();
    await h.page.locator('#waTabbarBtn').click();
    await h.page.locator('#btnRetirada').click();
    await h.page.locator('#clienteNome').fill('Cliente Teste');
    await h.page.locator('#clienteTelefone').fill('43999999999');
    assert.deepEqual(await h.page.locator('input[name="payment"]').evaluateAll(ns=>ns.map(n=>n.value)),['pix','dinheiro','debito','credito']);
    await h.page.locator('input[name="payment"][value="'+method+'"]').check();
    if(method==='pix')assert.equal(await h.page.locator('#copiarChavePix').isVisible(),true);
    await h.page.locator('#btnEnviarPedido').click();
    await h.page.locator('#checkoutConfirm').waitFor({state:'visible'});
    assert.equal(h.bodies.length,1);
    assert.equal(h.bodies[0].pagamento.metodo,method);
    assert.notEqual(h.bodies[0].pagamento.fluxo,'mercadopago');
    assert.match(await h.page.locator('#checkoutConfirm').innerText(),/confirmada no sistema/);
    assert.deepEqual(h.online,[]);
    assert.deepEqual(h.errors,[]);
  } finally {await h.context.close();}
});
