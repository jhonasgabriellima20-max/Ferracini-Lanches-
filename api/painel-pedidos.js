const crypto = require('crypto');
const { blobAuthOptions } = require('../lib/blob-auth');

const TIME_ZONE = 'America/Sao_Paulo';
const FILA_DIR = 'pedidos/fila';
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES = 5;
const failedLogins = globalThis.__ferraciniPainelPedidosFailures || new Map();
globalThis.__ferraciniPainelPedidosFailures = failedLogins;

function passwordOk(recebida, esperada){
  if(!recebida || !esperada) return false;
  const a = Buffer.from(String(recebida));
  const b = Buffer.from(String(esperada));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientKey(req){
  return String(
    req.headers['x-vercel-forwarded-for'] ||
    req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    'unknown'
  ).split(',')[0].trim().slice(0, 120) || 'unknown';
}

function authStatus(req){
  const key = clientKey(req);
  const now = Date.now();
  const current = failedLogins.get(key);
  if(!current || current.resetAt <= now){
    if(current) failedLogins.delete(key);
    return { key, blocked: false, retryAfter: 0 };
  }
  return {
    key,
    blocked: current.count >= AUTH_MAX_FAILURES,
    retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

function recordFailure(req){
  const now = Date.now();
  const { key } = authStatus(req);
  let current = failedLogins.get(key);
  if(!current || current.resetAt <= now){
    current = { count: 0, resetAt: now + AUTH_WINDOW_MS };
  }
  current.count += 1;
  failedLogins.set(key, current);
  return {
    blocked: current.count >= AUTH_MAX_FAILURES,
    retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

function dataOperacao(){
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function queryParams(req){
  try{
    return new URL(String(req.url || '/'), 'https://ferracinilanches.com.br').searchParams;
  }catch{
    return new URLSearchParams();
  }
}

function isNotFound(err){
  return err?.status === 404 || err?.statusCode === 404 || err?.code === 'not_found' || err?.code === 'BLOB_NOT_FOUND';
}

async function lerJson(pathname){
  const { get } = await import('@vercel/blob');
  try{
    const result = await get(pathname, { access: 'private', useCache: false, ...blobAuthOptions() });
    if(!result) return null;
    return JSON.parse(await new Response(result.stream).text());
  }catch(err){
    if(isNotFound(err)) return null;
    throw err;
  }
}

async function listarPedidos(data, limite){
  const { list } = await import('@vercel/blob');
  const resultado = await list({ prefix: `${FILA_DIR}/${data}/`, limit: Math.min(100, Math.max(1, limite || 50)), ...blobAuthOptions() });
  const pedidos = [];
  for(const blob of resultado.blobs || []){
    try{
      const pedido = await lerJson(blob.pathname);
      if(pedido) pedidos.push(pedido);
    }catch(err){
      console.warn('[painel-pedidos] leitura_falhou', { pathname: blob.pathname, error: String(err) });
    }
  }
  pedidos.sort((a,b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')));
  return pedidos;
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if(req.method !== 'GET'){
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if(!adminPassword){
    return res.status(503).json({ error: 'Senha administrativa não configurada.' });
  }

  const status = authStatus(req);
  if(status.blocked){
    res.setHeader('Retry-After', String(status.retryAfter));
    return res.status(429).json({ error: 'Muitas tentativas de acesso. Aguarde alguns minutos.' });
  }

  if(!passwordOk(req.headers['x-admin-password'], adminPassword)){
    const failure = recordFailure(req);
    if(failure.blocked) res.setHeader('Retry-After', String(failure.retryAfter));
    return res.status(failure.blocked ? 429 : 401).json({
      error: failure.blocked
        ? 'Muitas tentativas de acesso. Aguarde alguns minutos.'
        : 'Senha administrativa incorreta.'
    });
  }
  failedLogins.delete(clientKey(req));

  try{
    const params = queryParams(req);
    const dataParam = String(params.get('data') || '');
    const limitParam = Number(params.get('limit'));
    const data = /^\d{4}-\d{2}-\d{2}$/.test(dataParam) ? dataParam : dataOperacao();
    const pedidos = await listarPedidos(data, Number.isFinite(limitParam) ? limitParam : 50);
    return res.status(200).json({ data, pedidos, atualizadoEm: new Date().toISOString() });
  }catch(err){
    console.error('[painel-pedidos] listagem_falhou', { error: String(err) });
    return res.status(503).json({ error: 'Não foi possível carregar os pedidos agora.' });
  }
};
