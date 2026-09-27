const crypto = require('crypto');
const { readJson, listBlobs } = require('../lib/postgres-storage');

const TIME_ZONE = 'America/Sao_Paulo';
const FILA_DIR = 'pedidos/fila';
const RASCUNHO_DIR = 'pedidos/aguardando-whatsapp';
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES = 5;
const failedLogins = globalThis.__ferraciniPainelPedidosFailures || new Map();
globalThis.__ferraciniPainelPedidosFailures = failedLogins;
const pedidoReadCache = globalThis.__ferraciniPainelPedidoReadCache || new Map();
globalThis.__ferraciniPainelPedidoReadCache = pedidoReadCache;
const PEDIDO_CACHE_FALLBACK_MS = 30 * 1000;

function origemPermitida(req){
  if(String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = String(req.headers.origin || '').trim();
  if(!origin) return true;
  try{
    const url = new URL(origin);
    if(url.protocol !== 'https:' && url.hostname !== 'localhost') return false;
    return url.hostname === 'ferracinilanches.com.br' ||
      url.hostname === 'www.ferracinilanches.com.br' ||
      /^ferracini-lanches(?:-[a-z0-9-]+)?(?:-jho-n)?\.vercel\.app$/i.test(url.hostname) ||
      url.hostname === 'localhost';
  }catch{
    return false;
  }
}

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
  if(failedLogins.size > 1000){
    for(const [bucketKey, value] of failedLogins){
      if(value.resetAt <= now) failedLogins.delete(bucketKey);
    }
  }
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
  return (await readJson(pathname)).value;
}

function blobSignature(blob){
  const uploadedAt = blob?.uploadedAt ? String(blob.uploadedAt) : '';
  const size = Number(blob?.size) || 0;
  return uploadedAt || size ? `${uploadedAt}:${size}` : '';
}

async function lerPedidoComCache(blob){
  const pathname = blob.pathname;
  const signature = blobSignature(blob);
  const cached = pedidoReadCache.get(pathname);
  const now = Date.now();

  if(cached){
    if(signature && cached.signature === signature) return cached.value;
    if(!signature && (now - cached.cachedAt) < PEDIDO_CACHE_FALLBACK_MS) return cached.value;
  }

  const value = await lerJson(pathname);
  pedidoReadCache.set(pathname, { signature, cachedAt: now, value });
  return value;
}

async function listarPedidos(data, limite){
  const resultado = await listBlobs({ prefix: `${FILA_DIR}/${data}/`, limit: Math.min(100, Math.max(1, limite || 50)) });
  const pedidos = [];
  const atuais = new Set();

  for(const blob of resultado.blobs || []){
    atuais.add(blob.pathname);
    try{
      const pedido = await lerPedidoComCache(blob);
      if(pedido) pedidos.push(pedido);
    }catch(err){
      console.warn('[painel-pedidos] leitura_falhou', { pathname: blob.pathname, error: String(err) });
    }
  }

  for(const pathname of pedidoReadCache.keys()){
    if(pathname.startsWith(`${FILA_DIR}/${data}/`) && !atuais.has(pathname)){
      pedidoReadCache.delete(pathname);
    }
  }

  pedidos.sort((a,b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')));
  return pedidos;
}

async function listarAguardando(data){
  const resultado = await listBlobs({ prefix: `${RASCUNHO_DIR}/${data}/`, limit: 1000 });
  const aguardando = [];
  for(const blob of resultado.blobs || []){
    try{
      const rascunho = await lerJson(blob.pathname);
      if(rascunho?.status === 'aguardando_whatsapp') aguardando.push({
        pathname: blob.pathname,
        referencia: rascunho.referencia,
        criadoEm: rascunho.criadoEm,
        cliente: rascunho.payload?.cliente,
        itens: rascunho.payload?.itens,
        atendimento: rascunho.payload?.atendimento,
        totalCentavos: rascunho.payload?.totalCentavos,
      });
    }catch(err){
      console.warn('[painel-pedidos] rascunho_ignorado', { pathname: blob.pathname, error: String(err) });
    }
  }
  aguardando.sort((a,b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
  return aguardando;
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Vary', 'X-Admin-Password');

  if(req.method !== 'GET' && req.method !== 'POST'){
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  if(!origemPermitida(req)) return res.status(403).json({ error: 'Origem não permitida.' });

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

  if(req.method === 'POST'){
    if(String(req.headers['content-type'] || '').toLowerCase().includes('application/json') === false){
      return res.status(415).json({ error: 'Conteúdo deve ser enviado em JSON.' });
    }
    if(Number(req.headers['content-length'] || 0) > 2048) return res.status(413).json({ error: 'Requisição muito grande.' });
    try{
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if(body?.acao !== 'confirmar_whatsapp') return res.status(400).json({ error: 'Ação inválida.' });
      const pathname = String(body?.pathname || '');
      const confirmado = await require('./pedidos').confirmarPedidoWhatsapp(pathname);
      return res.status(200).json({ confirmado });
    }catch(err){
      console.error('[painel-pedidos] confirmacao_falhou', { error: String(err) });
      const mensagem = ['Referência inválida.','Referência não encontrada.'].includes(err?.message)
        ? err.message : 'Não foi possível confirmar. Tente novamente.';
      return res.status(mensagem === err?.message ? 400 : 503).json({ error: mensagem });
    }
  }

  try{
    const params = queryParams(req);
    const dataParam = String(params.get('data') || '');
    const limitParam = Number(params.get('limit'));
    const data = /^\d{4}-\d{2}-\d{2}$/.test(dataParam) ? dataParam : dataOperacao();
    const pedidos = await listarPedidos(data, Number.isFinite(limitParam) ? limitParam : 50);
    const aguardando = await listarAguardando(data);
    return res.status(200).json({ data, pedidos, aguardando, atualizadoEm: new Date().toISOString() });
  }catch(err){
    console.error('[painel-pedidos] listagem_falhou', { error: String(err) });
    return res.status(503).json({ error: 'Não foi possível carregar os pedidos agora.' });
  }
};
