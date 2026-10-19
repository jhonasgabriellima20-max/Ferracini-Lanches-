'use strict';
// Rota de homologação ISOLADA: jamais processa em produção, registra pedidos ou libera impressão.
// Somente credenciais específicas de teste do Mercado Pago (TEST-...). Não usa MP_ACCESS_TOKEN.
const crypto = require('crypto');
const PREVIEW_BRANCH = 'teste-checkout-transparente';
const AMOUNT_CENTS = 500;
const MAX_BODY = 16 * 1024;
const RATE_LIMIT = 12;
const WINDOW_MS = 60 * 1000;
const buckets = globalThis.__ferraciniPreviewCheckoutBuckets || new Map();
globalThis.__ferraciniPreviewCheckoutBuckets = buckets;

function previewPermitido() {
  return process.env.VERCEL_ENV === 'preview' &&
    process.env.VERCEL_GIT_COMMIT_REF === PREVIEW_BRANCH;
}

function chavesTeste() {
  const publicKey = String(process.env.MP_TEST_PUBLIC_KEY || '').trim();
  const accessToken = String(process.env.MP_TEST_ACCESS_TOKEN || '').trim();
  return {
    publicKey: /^TEST-[A-Za-z0-9_-]{8,}$/.test(publicKey) ? publicKey : '',
    accessToken: /^TEST-[A-Za-z0-9_-]{8,}$/.test(accessToken) ? accessToken : ''
  };
}

function origemValida(req) {
  const origin = String(req.headers.origin || '');
  if (!origin || String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  try {
    const url = new URL(origin);
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return url.protocol === 'https:' && url.host === host;
  } catch {
    return false;
  }
}

function limite(req) {
  const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].slice(0, 100);
  const agora = Date.now();
  const atual = buckets.get(ip);
  if (!atual || agora > atual.ate) {
    buckets.set(ip, { ate: agora + WINDOW_MS, n: 1 });
    return true;
  }
  atual.n++;
  if (buckets.size > 1000) {
    for (const [key, value] of buckets) if (value.ate < agora) buckets.delete(key);
  }
  return atual.n <= RATE_LIMIT;
}

function validacao(form) {
  if (!form || typeof form !== 'object' || Array.isArray(form)) return null;
  const token = String(form.token || '').trim();
  const metodo = String(form.payment_method_id || '').trim();
  const parcelas = Number(form.installments);
  const email = String(form.payer?.email || '').trim().toLowerCase();
  const uuid = String(form.idempotencyKey || '').trim();
  if (!/^[a-zA-Z0-9_-]{10,4096}$/.test(token)) return null;
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(metodo)) return null;
  if (!Number.isSafeInteger(parcelas) || parcelas < 1 || parcelas > 12) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180) return null;
  if (!/^[a-f0-9]{8}-[a-f0-9-]{27,40}$/i.test(uuid)) return null;
  const payer = { email };
  const identificacao = form.payer?.identification;
  if (identificacao && /^[A-Za-z]{2,8}$/.test(String(identificacao.type || '')) &&
      /^\d{5,20}$/.test(String(identificacao.number || ''))) {
    payer.identification = {type: String(identificacao.type), number: String(identificacao.number)};
  }
  const payload = {
    token,
    transaction_amount: AMOUNT_CENTS / 100,
    installments: parcelas,
    payment_method_id: metodo,
    payer,
    description: 'TESTE DE HOMOLOGACAO FERRACINI - NAO E PEDIDO',
    external_reference: 'ferracini-homolog-' + uuid
  };
  if (form.issuer_id !== null && form.issuer_id !== undefined && /^\d{1,15}$/.test(String(form.issuer_id))) {
    payload.issuer_id = Number(form.issuer_id);
  }
  return { payload, uuid };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Allow', 'GET, POST');
  if (!previewPermitido()) {
    return res.status(403).json({ error: 'Homologacao bloqueada fora da branch de teste na Vercel Preview.' });
  }
  const keys = chavesTeste();

  if (req.method === 'GET') {
    return res.status(200).json({
      modo: keys.publicKey && keys.accessToken ? 'sandbox' : 'demonstracao',
      valorCentavos: AMOUNT_CENTS,
      moeda: 'BRL',
      publicKey: keys.publicKey && keys.accessToken ? keys.publicKey : null,
      pedidosAtivos: false,
      impressaoAtiva: false
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo nao permitido.' });
  if (!origemValida(req)) return res.status(403).json({ error: 'Origem nao permitida.' });
  if (!keys.accessToken || !keys.publicKey) {
    return res.status(503).json({ error: 'Somente simulacao visual. Configure MP_TEST_PUBLIC_KEY e MP_TEST_ACCESS_TOKEN no ambiente Preview.' });
  }
  if (!limite(req)) return res.status(429).json({ error: 'Limite de testes atingido. Aguarde um minuto.' });
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json') ||
      Number(req.headers['content-length'] || 0) > MAX_BODY) {
    return res.status(415).json({ error: 'Formulario invalido.' });
  }
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (JSON.stringify(body || {}).length > MAX_BODY) return res.status(413).json({error:'Dados excederam o limite.'});
  } catch {
    return res.status(400).json({ error: 'JSON invalido.' });
  }
  const validado = validacao(body);
  if (!validado) return res.status(400).json({ error: 'Dados do pagamento de teste invalidos.' });
  const requestId = crypto.randomUUID();
  try {
    const resposta = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + keys.accessToken,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': validado.uuid,
        'X-Request-Id': requestId
      },
      body: JSON.stringify(validado.payload),
      signal: AbortSignal.timeout(15000)
    });
    const data = await resposta.json().catch(() => ({}));
    return res.status(resposta.ok ? 200 : 422).json({
      ambiente: 'sandbox',
      pagamentoId: data.id || null,
      status: data.status || 'error',
      detalhe: data.status_detail || null,
      mensagem: resposta.ok ? null : 'O Mercado Pago nao aceitou o pagamento de teste.',
      pedidoGerado: false,
      impressaoGerada: false
    });
  } catch (err) {
    console.error('[checkout-teste] falha de conexao', { error: err?.name || 'unknown' });
    return res.status(503).json({
      error: 'Nao foi possivel verificar o pagamento. Nao repita com outra identificacao antes de consultar o status no Mercado Pago.',
      pedidoGerado: false
    });
  }
};
