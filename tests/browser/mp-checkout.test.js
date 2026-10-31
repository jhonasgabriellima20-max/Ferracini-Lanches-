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
  status: 'pendente', pagamento: { fluxo: 'mercadopago', status: 'approved', verified: true } };
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
    if(pathname === '/') {
      for(const rule of config.headers || []) if(rule.source === '/(.*)' || rule.source === '/') {
        for(const header of rule.headers) res.setHeader(header.key, header.value);
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(fs.readFileSync(path.join(root, 'index.html')));
    }
    if(/^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname)) {
      const file = path.join(root, pathname);
      if(fs.existsSync(file)) {
        res.setHeader('Content-Type', 'image/webp');
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

async function harness({ enabled = true, requested = enabled, payment = { status: 'approved', pedido: confirmed }, paymentCode = 200, status = { status: 'pending' }, sdkFailure = false } = {}) {
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
      return json(enabled ? { pagamentoObrigatorio: true, impressaoAtiva: false, pedido: {
        id, referencia: 'TESTE12345', criadoEm: createdAt, totalCentavos: 1500,
        status: 'aguardando_pagamento', pagamento: { metodo: state.reservationBodies.at(-1).pagamento.metodo }
      } } : { pedido: confirmed }, 201);
    }
    if(url.pathname === '/api/mp-pagamento') {
      counts.payment++; state.paymentBodies.push(request.postDataJSON());
      return json(state.payment, state.paymentCode);
    }
    if(url.pathname === '/api/mp-status') { counts.status++; return json(state.status); }
    if(url.pathname === '/api/mp-diagnostico') return route.fulfill({ status: 204 });
    return route.continue();
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.qty-stepper[data-name="Dog Simples"] .plus').waitFor();
  return { context, page, counts, state, errors, dialogs };
}

async function openCheckout(h) {
  await h.page.locator('.qty-stepper[data-name="Dog Simples"] .plus').click();
  await h.page.locator('#waTabbarBtn').click();
  await h.page.locator('#checkoutOverlay.open').waitFor();
  await h.page.locator('#btnRetirada').click();
  await h.page.locator('#clienteNome').fill('Cliente de Teste');
  await h.page.locator('#clienteTelefone').fill('43999999999');
}
async function reserve(h, method = 'credito') {
  await openCheckout(h);
  assert.deepEqual(await h.page.locator('input[name="payment"]').evaluateAll(nodes => nodes.map(node => node.value)), ['credito', 'debito']);
  await h.page.locator('input[name="payment"][value="' + method + '"]').check();
  await h.page.locator('#btnEnviarPedido').click();
  await h.page.locator('#mockProviderPay').waitFor();
  assert.equal(await h.page.locator('#checkoutConfirm').isVisible(), false);
  assert.equal(h.counts.reservation, 1);
  assert.equal(h.counts.payment, 0);
}

test('flag desativada preserva pagamento manual e confirmação existente', async () => {
  const h = await harness({ enabled: false });
  try {
    await openCheckout(h);
    assert.deepEqual(await h.page.locator('input[name="payment"]').evaluateAll(nodes => nodes.map(node => node.value)), ['pix', 'dinheiro', 'debito', 'credito']);
    await h.page.locator('#btnEnviarPedido').click();
    await h.page.locator('#checkoutConfirm').waitFor({ state: 'visible' });
    assert.match(await h.page.locator('#checkoutConfirm').innerText(), /Comanda 42 confirmada/);
    assert.equal(h.counts.payment, 0); assert.equal(h.counts.sdk, 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
});

test('reserva não confirma; aprovação do provedor libera confirmação e limpa tentativa', async () => {
  const h = await harness();
  try {
    await reserve(h);
    assert.match(await h.page.locator('#mpPaymentStatus').innerText(), /Crédito/);
    await h.page.locator('#mockProviderPay').click();
    await h.page.locator('#checkoutConfirm').waitFor({ state: 'visible' });
    assert.match(await h.page.locator('#checkoutConfirm').innerText(), /Comanda 42 confirmada/);
    assert.equal(h.counts.payment, 1);
    assert.equal(h.state.paymentBodies[0].id, id);
    assert.equal(h.state.paymentBodies[0].form.payment_type_id, 'credit_card');
    assert.equal(await h.page.evaluate(key => localStorage.getItem(key), pendingKey), null);
    assert.equal(await h.page.locator('#cartBadge').isVisible(), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
});

test('flag solicitada com configuração incompleta bloqueia checkout sem cair no fluxo manual', async () => {
  const h = await harness({ enabled: false, requested: true });
  try {
    await h.page.locator('.qty-stepper[data-name="Dog Simples"] .plus').click();
    const dialog = h.page.waitForEvent('dialog');
    await h.page.locator('#waTabbarBtn').click();
    await dialog;
    assert.equal(h.dialogs.length, 1);
    assert.match(h.dialogs[0], /pagamento online.*indisponível/i);
    assert.equal(await h.page.locator('#checkoutOverlay.open').count(), 0);
    assert.equal(h.counts.reservation, 0); assert.equal(h.counts.payment, 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
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
    assert.equal(await h.page.locator('#linkWhatsappCopia').isVisible(), false);
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
    await h.page.locator('#btnEnviarPedido').click();
    await h.page.locator('#mpRetryCard').waitFor({ state: 'visible' });
    assert.match(await h.page.locator('#mpPaymentStatus').innerText(), /não carregou/);
    assert.equal(h.counts.payment, 0);
    assert.equal(await h.page.locator('#checkoutConfirm').isVisible(), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.context.close(); }
});
