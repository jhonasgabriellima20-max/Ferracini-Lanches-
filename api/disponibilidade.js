const crypto = require('crypto');
const { readJson, writeJson } = require('../lib/blob-storage');

const BLOB_PATH = 'config/disponibilidade.json';
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES = 5;
const failedLogins = globalThis.__ferraciniAdminFailures || new Map();
globalThis.__ferraciniAdminFailures = failedLogins;

const PUBLIC_CACHE_TTL_MS = 5 * 60 * 1000;
const disponibilidadeCache = globalThis.__ferraciniDisponibilidadeCache || {
  state: null,
  storageMode: null,
  expiresAt: 0,
};
globalThis.__ferraciniDisponibilidadeCache = disponibilidadeCache;

const STORAGE_SUSPENSION_BACKOFF_MS = 30 * 60 * 1000;
const storageBackoff = globalThis.__ferraciniStorageBackoff || { until: 0, reason: null };
globalThis.__ferraciniStorageBackoff = storageBackoff;

function isStorageSuspended(err){
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('store has been suspended') ||
    message.includes('blobstoresuspendederror');
}

function armStorageBackoff(err){
  if(!isStorageSuspended(err)) return;
  storageBackoff.until = Date.now() + STORAGE_SUSPENSION_BACKOFF_MS;
  storageBackoff.reason = 'suspended';
}

function clearStorageBackoff(){
  storageBackoff.until = 0;
  storageBackoff.reason = null;
}

const INGREDIENTES = [
  ['pao', 'Pão'],
  ['salsicha', 'Salsicha'],
  ['hamburguer', 'Hambúrguer'],
  ['frango', 'Frango'],
  ['bacon', 'Bacon'],
  ['calabresa', 'Calabresa'],
  ['mussarela', 'Mussarela / queijo'],
  ['presunto', 'Presunto'],
  ['ovo', 'Ovo'],
  ['alface', 'Alface'],
  ['tomate', 'Tomate'],
  ['batata_palha', 'Batata palha'],
  ['ketchup', 'Ketchup do lanche'],
  ['maionese', 'Maionese do lanche'],
  ['toscana', 'Toscana (adicional)'],
  ['fraldinha', 'Fraldinha (adicional)'],
  ['molho_verde_saquinho', 'Molho verde (saquinho)'],
  ['ketchup_saquinho', 'Ketchup (saquinho)'],
  ['maionese_saquinho', 'Maionese (saquinho)'],
];

const PRODUTOS = [
  ['Dog Simples', 'Lanches-Dog'],
  ['Dog Duplo', 'Lanches-Dog'],
  ['Dog Presunto Queijo', 'Lanches-Dog'],
  ['Dog Frango', 'Lanches-Dog'],
  ['Dog Bacon', 'Lanches-Dog'],
  ['Dog Frango Bacon (1 Kilo)', 'Lanches-Dog'],
  ['Simples Burguer', 'Lanches-X'],
  ['X-Burguer', 'Lanches-X'],
  ['X-Salada', 'Lanches-X'],
  ['X-Egg', 'Lanches-X'],
  ['X-Frango', 'Lanches-X'],
  ['X-Bacon (1 Kilo)', 'Lanches-X'],
  ['X-Tudo (2 Kilo)', 'Lanches-X'],
  ['Água com gás', 'Bebidas'],
  ['Água sem gás', 'Bebidas'],
  ['Refrigerante lata', 'Bebidas'],
  ['Cerveja lata', 'Bebidas'],
  ['Cerveja Long Neck', 'Bebidas'],
  ['Jujutuba 2L', 'Bebidas'],
  ['Refrico 2L', 'Bebidas'],
  ['Coca-Cola 1L', 'Bebidas'],
  ['Kuat 2L', 'Bebidas'],
  ['Coca-Cola 2L', 'Bebidas'],
];

const DEPENDENCIAS = {
  pao: ['Dog Simples','Dog Duplo','Dog Presunto Queijo','Dog Frango','Dog Bacon','Dog Frango Bacon (1 Kilo)','Simples Burguer','X-Burguer','X-Salada','X-Egg','X-Frango','X-Bacon (1 Kilo)','X-Tudo (2 Kilo)'],
  salsicha: ['Dog Simples','Dog Duplo','Dog Presunto Queijo','Dog Frango','Dog Bacon','Dog Frango Bacon (1 Kilo)','X-Tudo (2 Kilo)'],
  hamburguer: ['Simples Burguer','X-Burguer','X-Salada','X-Egg','X-Frango','X-Bacon (1 Kilo)','X-Tudo (2 Kilo)'],
  frango: ['Dog Frango','Dog Frango Bacon (1 Kilo)','X-Frango','X-Tudo (2 Kilo)'],
  bacon: ['Dog Bacon','Dog Frango Bacon (1 Kilo)','X-Bacon (1 Kilo)','X-Tudo (2 Kilo)'],
  calabresa: ['X-Tudo (2 Kilo)'],
  mussarela: ['Dog Presunto Queijo','X-Burguer','X-Salada','X-Egg','X-Frango','X-Bacon (1 Kilo)','X-Tudo (2 Kilo)'],
  presunto: ['Dog Presunto Queijo','X-Salada','X-Frango','X-Bacon (1 Kilo)','X-Tudo (2 Kilo)'],
  ovo: ['X-Egg','X-Tudo (2 Kilo)'],
  alface: ['X-Burguer','X-Salada','X-Egg','X-Frango','X-Bacon (1 Kilo)','X-Tudo (2 Kilo)'],
  tomate: ['Dog Simples','Dog Duplo','Dog Presunto Queijo','Dog Frango','Dog Bacon','Dog Frango Bacon (1 Kilo)','Simples Burguer','X-Burguer','X-Salada','X-Egg','X-Frango','X-Bacon (1 Kilo)'],
  batata_palha: ['Dog Simples','Dog Duplo','Dog Presunto Queijo','Dog Frango','Dog Bacon','Dog Frango Bacon (1 Kilo)','X-Burguer','X-Salada','X-Egg','X-Frango','X-Bacon (1 Kilo)','X-Tudo (2 Kilo)'],
  ketchup: ['Dog Simples','Dog Duplo','Dog Presunto Queijo','Dog Frango','Dog Bacon','Dog Frango Bacon (1 Kilo)','Simples Burguer','X-Burguer','X-Salada','X-Egg','X-Frango','X-Bacon (1 Kilo)'],
  maionese: ['Dog Simples','Dog Duplo','Dog Presunto Queijo','Dog Frango','Dog Bacon','Dog Frango Bacon (1 Kilo)','Simples Burguer','X-Burguer','X-Salada','X-Egg','X-Frango','X-Bacon (1 Kilo)'],
};

function defaults(){
  return {
    ingredientes: Object.fromEntries(INGREDIENTES.map(([id]) => [id, true])),
    produtos: Object.fromEntries(PRODUTOS.map(([nome]) => [nome, true])),
    operacao: { demanda: 'normal' },
    updatedAt: null,
  };
}

function mergeState(raw){
  const base = defaults();
  if(raw && typeof raw === 'object'){
    for(const [id] of INGREDIENTES){
      if(typeof raw.ingredientes?.[id] === 'boolean') base.ingredientes[id] = raw.ingredientes[id];
    }
    for(const [nome] of PRODUTOS){
      if(typeof raw.produtos?.[nome] === 'boolean') base.produtos[nome] = raw.produtos[nome];
    }
    const demanda = raw.operacao?.demanda;
    if(['baixa','normal','alta'].includes(demanda)) base.operacao.demanda = demanda;
    if(typeof raw.updatedAt === 'string') base.updatedAt = raw.updatedAt;
  }
  return base;
}

function catalogo(){
  return {
    ingredientes: INGREDIENTES.map(([id, nome]) => ({ id, nome, afeta: DEPENDENCIAS[id] || [] })),
    produtos: PRODUTOS.map(([nome, categoria]) => ({ nome, categoria })),
  };
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

function recordAuthFailure(req){
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

function clearAuthFailures(req){
  failedLogins.delete(clientKey(req));
}

function authRateLimited(req, res){
  const status = authStatus(req);
  if(!status.blocked) return false;
  res.setHeader('Retry-After', String(status.retryAfter));
  res.status(429).json({ error: 'Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.' });
  return true;
}

function isNotFound(err){
  return err?.status === 404 || err?.statusCode === 404 || err?.code === 'not_found' || err?.code === 'BLOB_NOT_FOUND';
}

function saveCache(state, storageMode){
  disponibilidadeCache.state = mergeState(state);
  disponibilidadeCache.storageMode = storageMode || disponibilidadeCache.storageMode || null;
  disponibilidadeCache.expiresAt = Date.now() + PUBLIC_CACHE_TTL_MS;
}

async function readState({ force = false } = {}){
  const now = Date.now();

  if(storageBackoff.until > now){
    return {
      state: disponibilidadeCache.state || defaults(),
      storageReady: false,
      storageMode: disponibilidadeCache.storageMode,
      cacheHit: Boolean(disponibilidadeCache.state),
      storageBackoff: true,
    };
  }

  if(!force && disponibilidadeCache.state && disponibilidadeCache.expiresAt > now){
    return {
      state: disponibilidadeCache.state,
      storageReady: true,
      storageMode: disponibilidadeCache.storageMode,
      cacheHit: true,
      storageBackoff: false,
    };
  }

  let result;
  try{
    result = await readJson(BLOB_PATH);
  }catch(err){
    armStorageBackoff(err);
    throw err;
  }
  if(result.value){
    const state = mergeState(result.value);
    saveCache(state, result.mode);
    clearStorageBackoff();
    return { state, storageReady: true, storageMode: result.mode, cacheHit: false, storageBackoff: false };
  }

  const state = defaults();
  const saved = await writeJson(BLOB_PATH, state, { allowOverwrite: true });
  saveCache(state, saved.mode);
  clearStorageBackoff();
  return { state, storageReady: true, storageMode: saved.mode, cacheHit: false, storageBackoff: false };
}

async function writeState(state){
  try{
    const saved = await writeJson(BLOB_PATH, state, { allowOverwrite: true });
    saveCache(state, saved.mode);
    clearStorageBackoff();
    return saved;
  }catch(err){
    armStorageBackoff(err);
    throw err;
  }
}

module.exports = async function handler(req, res){
  const adminRequest = Boolean(req.headers['x-admin-password']);
  if(req.method === 'GET' && !adminRequest){
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('CDN-Cache-Control', 'public, max-age=300, stale-while-revalidate=900');
    res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=300, stale-while-revalidate=900');
  }else{
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if(req.method === 'GET'){
    const recebida = req.headers['x-admin-password'];
    const adminPassword = process.env.ADMIN_PASSWORD || '';
    let authenticated;

    if(recebida){
      if(authRateLimited(req, res)) return;
      authenticated = passwordOk(recebida, adminPassword);
      if(!authenticated){
        const failure = recordAuthFailure(req);
        if(failure.blocked) res.setHeader('Retry-After', String(failure.retryAfter));
        return res.status(failure.blocked ? 429 : 401).json({
          error: failure.blocked
            ? 'Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.'
            : 'Senha administrativa incorreta.'
        });
      }
      clearAuthFailures(req);
    }

    try{
      const { state, storageReady, storageMode, cacheHit, storageBackoff: backoff } = await readState({ force: Boolean(recebida) });
      return res.status(200).json({ ...state, catalogo: catalogo(), storageReady, storageMode, cacheHit, storageBackoff: Boolean(backoff), adminConfigured: Boolean(adminPassword), authenticated });
    }catch(err){
      console.error('Falha ao ler disponibilidade:', err);
      const staleState = disponibilidadeCache.state || defaults();
      return res.status(200).json({
        ...staleState,
        catalogo: catalogo(),
        storageReady: false,
        storageMode: disponibilidadeCache.storageMode,
        cacheHit: Boolean(disponibilidadeCache.state),
        storageBackoff: storageBackoff.until > Date.now(),
        adminConfigured: Boolean(adminPassword),
        authenticated,
      });
    }
  }

  if(req.method === 'POST'){
    const adminPassword = process.env.ADMIN_PASSWORD || '';
    const recebida = req.headers['x-admin-password'];
    if(!adminPassword){
      return res.status(503).json({ error: 'ADMIN_PASSWORD não configurada na Vercel.' });
    }
    if(authRateLimited(req, res)) return;
    if(!passwordOk(recebida, adminPassword)){
      const failure = recordAuthFailure(req);
      if(failure.blocked) res.setHeader('Retry-After', String(failure.retryAfter));
      return res.status(failure.blocked ? 429 : 401).json({
        error: failure.blocked
          ? 'Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.'
          : 'Senha administrativa incorreta.'
      });
    }
    clearAuthFailures(req);

    try{
      let body = req.body;
      if(typeof body === 'string') body = JSON.parse(body || '{}');
      const next = mergeState(body || {});
      next.updatedAt = new Date().toISOString();
      await writeState(next);
      return res.status(200).json({ ...next, catalogo: catalogo(), storageReady: true });
    }catch(err){
      console.error('Falha ao salvar disponibilidade:', err);
      return res.status(503).json({ error: 'Não foi possível salvar. Verifique se um Vercel Blob está conectado ao projeto.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Método não permitido.' });
};
