// Real Chromium/DOM checks with a simulated Mercado Pago SDK and HTTP responses.
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
const pendingKey = 'ferracini-pagamento-pendente-v1';
const createdAt = new Date().toISOString();
const confirmed = { id, referencia: 'TESTE12345', numero: '42', criadoEm: createdAt,
  status: 'pendente', pagamento: { fluxo: 'mercadopago', status: 'approved', verified: true,mpOrderId:'ORDER-test-123456' } };
let browser, server, base;

const mockSDK = `window.MercadoPago = class {
  bricks() { return {create: async (kind, target, settings) => {
    window.__mockBrickSettings = settings;
    const button = document.createElement('button');
    button.id = 'mockProviderPay'; button.textContent = 'Pagar no provedor simulado';
    button.onclick = async () => {
      try { await settings.callbacks.onSubmit({
        token:'mock-card-token-1234567890',payment_method_id:'master',installments:1,
        payer:{email:'customer@example.test',identification:{type:'CPF',number:'12345678901'}}
      },{paymentTypeId:window.__mockPaymentType || 'credit_card'}); }
      catch(error) { window.__mockSubmitError = error.message; }
    };
    document.getElementById(target).appendChild(button);
    settings.callbacks.onReady();
    return {unmount() { button.remove(); }};
  }}; }
};`;

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

async function harness({ enabled = true, requested = enabled, payment = { status: 'approved', pedido: confirmed }, paymentCode = 200, status = { status: 'pending' }, sdkFailure = false, pagePath = '/' } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const counts = { reservation: 0, payment: 0, status: 0, sdk: 0 };
  const errors = [];
  const dialogs = [];
  const state = { status, payment, paymentCode, reservationBodies: [], paymentBodies: [] };
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.message()); return dialog.dismiss(); });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if(url.href === 'https://sdk.mercadopago.com/js/v2') {
      counts.sdk++;
      return sdkFailure ? route.abort('failed') : route.fulfill({ contentType: 'text/javascript', body: mockSDK });
    }
    if(url.origin !== base) return route.abort('blockedbyclient');
    const json = (body, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
    if(url.pathname === '/api/mp-config') return json({ enabled, requested, publicKey: enabled ? 'TEST-public-key' : null });
    if(url.pathname === '/api/disponibilidade') return json({ ingredientes: {}, produtos: {}, operacao: { modoLoja: 'aberto', canaisAtendimento: { entrega: true, retirada: true } } });
    if(url.pathname === '/api/pedidos') {
      counts.reservation++;
      state.reservationBodies.push(request.postDataJSON());
      const body=state.reservationBodies.at(-1);
      const online=body.atendimento.tipo!=='mesa';
      if(online && !enabled)return json({error:'Pagamento online indisponível.'},503);
      if(online && !['credito','debito'].includes(body.pagamento?.metodo))return json({error:'Pagamento pelo site obrigatório.'},400);
      const total=body.itens.reduce((sum,item)=>sum+item.quantidade*(item.precoUnitarioCentavos+(item.adicionais||[]).reduce((n,a)=>n+a.precoCentavos,0)),0)+(body.atendimento.taxaEntregaCentavos||0)+(body.atendimento.taxaServicoCentavos||0);
      return json(online ? { pagamentoObrigatorio: true, impressaoAtiva: false, pedido: {
        id, referencia: 'TESTE12345', criadoEm: createdAt, totalCentavos: total,
        status: 'aguardando_pagamento', pagamento: { metodo: state.reservationBodies.at(-1).pagamento.metodo }
      } } : { pedido: {...confirmed,pagamento:{metodo:body.pagamento?.metodo}} }, 201);
    }
    if(url.pathname === '/api/distancia') return json({distanciaKm:5,cotacaoFrete:'signed-quote-fixture'});
    if(url.pathname === '/api/estimativa') return json({estimativaMinutos:{minimo:45,maximo:60}});
    if(url.pathname === '/api/mp-pagamento') {
      counts.payment++; state.paymentBodies.push(request.postDataJSON());
      return json(state.payment, state.paymentCode);
    }
    if(url.pathname === '/api/mp-status') { counts.status++; return json(state.status); }
    if(url.pathname === '/api/mp-diagnostico') return route.fulfill({ status: 204 });
    return route.continue();
  });
  await page.goto(base + pagePath, { waitUntil: 'domcontentloaded' });
  await page.locator('.qty-stepper[data-name="Dog Simples"] .plus').waitFor();
  await assertNoWhatsappContact(page);
  return { context, page, counts, state, errors, dialogs };
}

async function assertNoWhatsappContact(page){
  const contactTargets=await page.locator('a[href]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')).filter(href=>/wa\.me|whatsapp\.com|whatsapp:/i.test(href)));
  assert.deepEqual(contactTargets,[],'no WhatsApp contact URL may remain');
  const contactLabels=await page.locator('a,button').evaluateAll(nodes=>nodes.map(node=>node.textContent).filter(label=>/whatsapp/i.test(label)));
  assert.deepEqual(contactLabels,[],'no WhatsApp contact or copy action may remain');
  assert.equal(await page.locator('#linkWhatsappCopia').count(),0);
}

async function openCheckout(h,{product='Dog Simples',burger,delivery='retirada'}={}) {
  if(burger)await h.page.locator('.product-card[data-name="'+product+'"] input.burger-type[value="'+burger+'"]').check();
  await h.page.locator('.qty-stepper[data-name="'+product+'"] .plus').click();
  await h.page.locator('#orderTabbarBtn').click();
  await h.page.locator('#checkoutOverlay.open').waitFor();
  await h.page.locator(delivery==='entrega'?'#btnEntrega':'#btnRetirada').click();
  await h.page.locator('#clienteNome').fill('Cliente de Teste');
  await h.page.locator('#clienteTelefone').fill('43999999999');
}
async function reserve(h, method = 'credito') {
  await openCheckout(h);
  assert.deepEqual(await h.page.locator('input[name="payment"]').evaluateAll(nodes => nodes.map(node => node.value)), ['credito', 'debito']);
  await h.page.locator('input[name="payment"][value="' + method + '"]').check();
  assert.equal(await h.page.locator('input[name="paymentFlow"]').count(),0);
  await h.page.locator('#btnEnviarPedido').click();
  await h.page.locator('#mockProviderPay').waitFor();
  assert.equal(await h.page.locator('#checkoutConfirm').isVisible(), false);
  assert.equal(h.counts.reservation, 1);
  assert.equal(h.counts.payment, 0);
  assert.equal(h.state.reservationBodies[0].pagamento.fluxo,'mercadopago');
}

test('flag desativada bloqueia entrega e retirada sem criar reserva ou cobrança', async () => {
  const h = await harness({ enabled: false });
  try {
    await openCheckout(h);
    assert.deepEqual(await h.page.locator('input[name="payment"]').evaluateAll(nodes => nodes.map(node => node.value)), ['credito', 'debito']);
    await h.page.locator('#btnEnviarPedido').click();
    await h.page.locator('#checkoutErrorBox .checkout-error').waitFor();
    assert.match(await h.page.locator('#checkoutErrorBox').innerText(), /pagamento online.*indisponível/i);
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(),false);
    assert.equal(h.counts.reservation, 0);
    assert.equal(h.counts.payment, 0); assert.equal(h.counts.sdk, 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
});

test('mesa sem Pix confirma no local sem formulário ou cobrança online', async () => {
  const h = await harness({pagePath:'/mesa.html?mesa=5'});
  try {
    await h.page.locator('.qty-stepper[data-name="Dog Simples"] .plus').click();
    await h.page.locator('#orderTabbarBtn').click();
    await h.page.locator('#checkoutOverlay.open').waitFor();
    await h.page.locator('#clienteNome').fill('Cliente da Mesa');
    assert.deepEqual(await h.page.locator('input[name="payment"]').evaluateAll(nodes=>nodes.map(node=>node.value)),['dinheiro']);
    assert.equal(await h.page.locator('#copiarChavePix').count(),0);
    await h.page.locator('#btnEnviarPedido').click();
    await h.page.locator('#checkoutConfirm').waitFor({state:'visible'});
    const payload=h.state.reservationBodies[0];
    assert.equal(payload.atendimento.tipo,'mesa');
    assert.equal(payload.atendimento.mesa,5);
    assert.equal(payload.pagamento.metodo,'dinheiro');
    assert.equal(payload.pagamento.fluxo,undefined);
    await assertNoWhatsappContact(h.page);
    assert.equal(h.counts.payment,0);
    assert.equal(h.counts.sdk,0);
    assert.deepEqual(h.errors,[]);
  } finally {await h.context.close();}
});

test('reserva não confirma; aprovação do provedor libera confirmação e limpa tentativa', async () => {
  const h = await harness();
  try {
    await reserve(h);
    assert.match(await h.page.locator('#mpPaymentStatus').innerText(), /Crédito/);
    await h.page.locator('#mockProviderPay').click();
    await h.page.locator('#checkoutConfirm').waitFor({ state: 'visible' });
    assert.match(await h.page.locator('#checkoutConfirm').innerText(), /Comanda 42 confirmada/);
    await assertNoWhatsappContact(h.page);
    assert.equal(h.counts.payment, 1);
    assert.equal(h.state.paymentBodies[0].id, id);
    assert.equal(h.state.paymentBodies[0].form.payment_type_id, 'credit_card');
    assert.equal(await h.page.evaluate(key => localStorage.getItem(key), pendingKey), null);
    assert.equal(await h.page.locator('#cartBadge').isVisible(), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
});

test('configuração online incompleta não oferece alternativa presencial', async () => {
  const h=await harness({enabled:false,requested:true});
  try{
    await openCheckout(h);
    assert.equal(await h.page.locator('input[name="paymentFlow"]').count(),0);
    assert.equal(await h.page.locator('input[name="payment"][value="dinheiro"]').count(),0);
    await h.page.locator('#btnEnviarPedido').click();
    await h.page.locator('#checkoutErrorBox .checkout-error').waitFor();
    assert.match(await h.page.locator('#paymentRequiredNotice').innerText(),/indisponível/);
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(),false);
    assert.equal(h.counts.reservation,0);
    assert.equal(h.counts.payment,0);assert.equal(h.counts.sdk,0);assert.deepEqual(h.errors,[]);
  }finally{await h.context.close();}
});

test('crédito padrão reserva pagamento online automaticamente sem liberar comanda',async()=>{
  const h=await harness();
  try{
    await openCheckout(h);
    assert.equal(await h.page.locator('input[name="payment"][value="credito"]').isChecked(),true);
    assert.equal(await h.page.locator('input[name="paymentFlow"]').count(),0);
    await h.page.locator('#btnEnviarPedido').click();
    await h.page.locator('#mockProviderPay').waitFor();
    assert.equal(h.state.reservationBodies[0].pagamento.fluxo,'mercadopago');
    assert.equal(h.state.reservationBodies[0].pagamento.metodo,'credito');
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(),false);
    assert.equal(h.counts.payment,0);assert.equal(h.counts.sdk,1);assert.deepEqual(h.errors,[]);
  }finally{await h.context.close();}
});

test('checkout principal não oferece dinheiro, Pix ou maquininha',async()=>{
  const h=await harness();
  try{
    await openCheckout(h);
    const options=await h.page.locator('input[name="payment"]').evaluateAll(nodes=>nodes.map(node=>node.value));
    assert.deepEqual(options,['credito','debito']);
    assert.equal(await h.page.locator('input[name="paymentFlow"]').count(),0);
    assert.doesNotMatch(await h.page.locator('#paymentOptions').innerText(),/maquininha|dinheiro|pix/i);
    assert.match(await h.page.locator('#paymentRequiredNotice').innerText(),/aprova/i);
    await h.page.locator('#btnEnviarPedido').click();
    await h.page.locator('#mockProviderPay').waitFor();
    assert.equal(h.state.reservationBodies[0].pagamento.fluxo,'mercadopago');
    assert.equal(h.counts.payment,0);
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(),false);
    assert.deepEqual(h.errors,[]);
  }finally{await h.context.close();}
});

test('débito reserva modalidade própria e limita formulário e cobrança a uma parcela', async () => {
  const h = await harness();
  try {
    await reserve(h, 'debito');
    const settings = await h.page.evaluate(() => ({
      amount: window.__mockBrickSettings.initialization.amount,
      maxInstallments: window.__mockBrickSettings.customization.paymentMethods.maxInstallments
    }));
    assert.deepEqual(settings, { amount: 15, maxInstallments: 1 });
    assert.match(await h.page.locator('#mpPaymentStatus').innerText(), /Débito à vista/);
    await h.page.evaluate(() => { window.__mockPaymentType = 'debit_card'; });
    await h.page.locator('#mockProviderPay').click();
    await h.page.locator('#checkoutConfirm').waitFor({ state: 'visible' });
    assert.equal(h.state.reservationBodies[0].pagamento.metodo, 'debito');
    assert.equal(h.state.paymentBodies[0].form.payment_type_id, 'debit_card');
    assert.equal(h.state.paymentBodies[0].form.installments, 1);
    assert.equal(h.counts.payment, 1); assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
});

test('modalidade divergente é bloqueada antes de qualquer cobrança', async () => {
  const h = await harness();
  try {
    await reserve(h);
    await h.page.evaluate(() => { window.__mockPaymentType = 'debit_card'; });
    await h.page.locator('#mockProviderPay').click();
    await h.page.waitForFunction(() => typeof window.__mockSubmitError === 'string');
    assert.match(await h.page.locator('#mpPaymentStatus').innerText(), /não corresponde/);
    assert.equal(h.counts.payment, 0);
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
});

test('pagamento recusado mantém carrinho sem confirmar e permite outra tentativa consciente', async () => {
  const h = await harness({ payment: { status: 'rejected' } });
  try {
    await reserve(h);
    await h.page.locator('#mockProviderPay').click();
    await h.page.locator('#btnEnviarPedido').waitFor({ state: 'visible' });
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(), false);
    assert.match(await h.page.locator('#mpPaymentStatus').innerText(), /recusado ou cancelado/);
    assert.match(await h.page.locator('#btnEnviarPedido').innerText(), /outro cartão/);
    assert.equal(await h.page.locator('#cartBadge').innerText(), '1');
    assert.equal(await h.page.evaluate(key => localStorage.getItem(key), pendingKey), null);
    assert.equal(h.counts.payment, 1); assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
});

test('pendência sobrevive ao reload e recupera aprovação sem nova reserva ou cobrança', async () => {
  const h = await harness({ payment: { status: 'pending' } });
  try {
    await reserve(h);
    await h.page.locator('#mockProviderPay').click();
    await h.page.waitForFunction(key => JSON.parse(localStorage.getItem(key) || '{}').submitted === true, pendingKey);
    await h.page.waitForFunction(() => !document.querySelector('#mockProviderPay'));
    const saved = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)), pendingKey);
    assert.deepEqual(Object.keys(saved).sort(), ['at','clientRequestId','id','metodo','submitted','totalCentavos'].sort());
    assert.equal(saved.id, id);
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(), false);
    h.state.status = { status: 'approved', pedido: confirmed };
    await h.page.reload({ waitUntil: 'domcontentloaded' });
    await h.page.locator('#mpRecoveryButton').click();
    await h.page.locator('#checkoutConfirm').waitFor({ state: 'visible' });
    assert.equal(h.counts.reservation, 1); assert.equal(h.counts.payment, 1);
    assert.equal(await h.page.locator('#linkWhatsappCopia').count(), 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
});

test('erro ambíguo retém referência e só consulta após reload', async () => {
  const h = await harness({ payment: { error: 'Resposta temporariamente indisponível.' }, paymentCode: 503 });
  try {
    await reserve(h);
    await h.page.locator('#mockProviderPay').click();
    await h.page.waitForFunction(() => document.querySelector('#mpPaymentStatus').textContent.includes('Nenhuma nova cobrança será iniciada automaticamente'));
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(), false);
    await h.page.reload({ waitUntil: 'domcontentloaded' });
    await h.page.locator('#mpRecoveryButton').click();
    await h.page.waitForFunction(() => document.querySelector('#mpPaymentStatus').textContent.includes('Pagamento em acompanhamento'));
    assert.equal(await h.page.locator('#mockProviderPay').count(), 0);
    assert.equal(h.counts.payment, 1); assert.equal(h.counts.reservation, 1);
    h.state.status = { status: 'approved', pedido: confirmed };
    await h.page.locator('#mpCheckStatus').click();
    await h.page.locator('#checkoutConfirm').waitFor({ state: 'visible' });
    assert.equal(h.counts.payment, 1); assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
});

test('autenticação bancária mantém pedido pendente até aprovação consultada', async () => {
  const h = await harness({ payment: { status: 'action_required', actionUrl: 'https://www.mercadopago.com.br/3ds/test' } });
  try {
    await reserve(h);
    await h.page.locator('#mockProviderPay').click();
    await h.page.locator('#mpBankAuthentication').waitFor({ state: 'visible' });
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(), false);
    assert.equal(await h.page.locator('#mpBankAuthentication').getAttribute('href'), 'https://www.mercadopago.com.br/3ds/test');
    h.state.status = { status: 'approved', pedido: confirmed };
    await h.page.locator('#mpCheckStatus').click();
    await h.page.locator('#checkoutConfirm').waitFor({ state: 'visible' });
    assert.equal(h.counts.payment, 1); assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
});

test('SDK indisponível oferece recarga sem iniciar cobrança nem confirmar pedido', async () => {
  const h = await harness({ sdkFailure: true });
  try {
    await openCheckout(h);
    await h.page.locator('input[name="payment"][value="credito"]').check();
    await h.page.locator('#btnEnviarPedido').click();
    await h.page.locator('#mpRetryCard').waitFor({ state: 'visible' });
    assert.match(await h.page.locator('#mpPaymentStatus').innerText(), /não carregou/);
    assert.equal(h.counts.payment, 0);
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
});


test('rejeição conhecida de dados permanece recuperável após recarga sem nova cobrança automática',async()=>{
  const result={status:'validation_rejected',needsNewOrder:true,error:'O Mercado Pago rejeitou os dados desta tentativa.'};
  const h=await harness({payment:result,paymentCode:422,status:result});
  try{
    await reserve(h);
    await h.page.locator('#mockProviderPay').click();
    await h.page.locator('#mpRetryCard').waitFor({state:'visible'});
    await h.page.reload({waitUntil:'domcontentloaded'});
    await h.page.locator('#mpRecoveryButton').click();
    await h.page.locator('#mpRetryCard').waitFor({state:'visible'});
    assert.match(await h.page.locator('#mpPaymentStatus').innerText(),/rejeitou os dados/);
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(),false);
    assert.equal(await h.page.locator('#mockProviderPay').count(),0);
    assert.equal(h.counts.reservation,1);assert.equal(h.counts.payment,1);
    assert.notEqual(await h.page.evaluate(key=>localStorage.getItem(key),pendingKey),null);
    h.page.removeAllListeners('dialog');h.page.on('dialog',dialog=>dialog.accept());
    await h.page.locator('#mpRetryCard').click();
    assert.equal(await h.page.evaluate(key=>localStorage.getItem(key),pendingKey),null);
    assert.equal(h.counts.reservation,1);assert.equal(h.counts.payment,1);
    assert.deepEqual(h.errors,[]);
  }finally{await h.context.close();}
});

test('checkout online conserva artesanal +R$9, frete R$3/km e cotação assinada',async()=>{
  const h=await harness();
  try{
    await openCheckout(h,{product:'Simples Burguer',burger:'artesanal',delivery:'entrega'});
    await h.page.locator('#endRua').fill('Rua Teste');
    await h.page.locator('#endNumero').fill('100');
    await h.page.locator('#endBairro').fill('Centro');
    await h.page.locator('#btnCalcularFrete').click();
    await h.page.waitForFunction(()=>document.querySelector('#freteBox').textContent.includes('5.0 km'));
    await h.page.locator('input[name="payment"][value="credito"]').check();
    await h.page.locator('#btnEnviarPedido').click();
    await h.page.locator('#mockProviderPay').waitFor();
    const body=h.state.reservationBodies[0];
    assert.equal(body.itens[0].tipoHamburguer,'artesanal');
    assert.equal(body.itens[0].precoUnitarioCentavos,2400);
    assert.equal(body.atendimento.taxaEntregaCentavos,1500);
    assert.equal(body.atendimento.cotacaoFrete,'signed-quote-fixture');
    assert.equal(body.pagamento.fluxo,'mercadopago');
    assert.equal(await h.page.evaluate(()=>window.__mockBrickSettings.initialization.amount),42);
    assert.equal(h.counts.payment,0);assert.deepEqual(h.errors,[]);
  }finally{await h.context.close();}
});

test('corrigir rejeição conhecida mantém escolha online e não muda para cobrança presencial',async()=>{
  const result={status:'validation_rejected',needsNewOrder:true,error:'O Mercado Pago rejeitou os dados desta tentativa.'};
  const h=await harness({payment:result,paymentCode:422,status:result});
  try{
    await reserve(h);
    const first=h.state.reservationBodies[0].clientRequestId;
    await h.page.locator('#mockProviderPay').click();
    await h.page.locator('#mpRetryCard').waitFor({state:'visible'});
    h.page.removeAllListeners('dialog');h.page.on('dialog',dialog=>dialog.accept());
    await h.page.locator('#mpRetryCard').click();
    assert.equal(await h.page.locator('input[name="paymentFlow"]').count(),0);
    assert.equal(await h.page.locator('input[name="payment"][value="credito"]').isChecked(),true);
    assert.equal(h.counts.reservation,1);assert.equal(h.counts.payment,1);
    await h.page.locator('#btnEnviarPedido').click();
    await h.page.locator('#mockProviderPay').waitFor();
    assert.equal(h.state.reservationBodies[1].pagamento.fluxo,'mercadopago');
    assert.notEqual(h.state.reservationBodies[1].clientRequestId,first);
    assert.equal(h.counts.reservation,2);assert.equal(h.counts.payment,1);
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(),false);
    assert.deepEqual(h.errors,[]);
  }finally{await h.context.close();}
});
