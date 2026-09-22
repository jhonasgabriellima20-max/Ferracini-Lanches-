const crypto = require('crypto');
const { addItem, orderCatalog } = require('../lib/custom-catalog');
const { readJson, writeJson, isStorageUnavailable } = require('../lib/postgres-storage');

const BLOB_PATH = 'config/disponibilidade.json';
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES = 5;
const MAX_BODY_BYTES = 32 * 1024;
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

const RUNTIME_CACHE_KEY = 'disponibilidade:v1';
const RUNTIME_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

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

async function runtimeCache(){
  const { getCache } = await import('@vercel/functions');
  return getCache({ namespace: 'ferracini' });
}

async function readRuntimeState(){
  try{
    const cache = await runtimeCache();
    const value = await cache.get(RUNTIME_CACHE_KEY);
    return { available: true, value: value ? mergeState(value) : null };
  }catch(err){
    console.warn('[disponibilidade] runtime_cache_leitura_indisponivel', { error: String(err) });
    return { available: false, value: null };
  }
}

async function writeRuntimeState(state){
  const cache = await runtimeCache();
  const normalized = mergeState(state);
  await cache.set(RUNTIME_CACHE_KEY, normalized, {
    ttl: RUNTIME_CACHE_TTL_SECONDS,
    tags: ['ferracini-disponibilidade'],
    name: 'Ferracini disponibilidade',
  });
  return { mode: 'runtime-cache', state: normalized, storageDegraded: true };
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
  ['Refriko 2L', 'Bebidas'],
  ['Suco Tampico 450 ml', 'Bebidas'],
  ['Suco Tampico 2L', 'Bebidas'],
  ['Del Valle 1L Laranja', 'Bebidas'],
  ['Del Valle 1L Uva', 'Bebidas'],
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


const HORARIO_PADRAO = {
  domingo: { abertura: '18:00', fechamento: '23:00' },
  segunda: { abertura: '18:00', fechamento: '23:00' },
  terca: { abertura: '18:00', fechamento: '23:00' },
  quarta: { abertura: '18:00', fechamento: '23:00' },
  quinta: { abertura: '18:00', fechamento: '23:00' },
  sexta: { abertura: '18:00', fechamento: '01:00' },
  sabado: { abertura: '18:00', fechamento: '01:00' },
};
const DIAS_SEMANA = ['domingo','segunda','terca','quarta','quinta','sexta','sabado'];

function horarioValido(value, fallback){
  if(typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return fallback;
  return value;
}

function normalizarHorarios(raw){
  return Object.fromEntries(DIAS_SEMANA.map(dia => {
    const padrao = HORARIO_PADRAO[dia];
    return [dia, {
      abertura: horarioValido(raw?.[dia]?.abertura, padrao.abertura),
      fechamento: horarioValido(raw?.[dia]?.fechamento, padrao.fechamento),
    }];
  }));
}

function partesHorarioLoja(agora = new Date()){
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(agora);
  const values = {};
  parts.forEach(part => { if(part.type !== 'literal') values[part.type] = part.value; });
  const dias = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return { dia: dias[values.weekday], minutos: Number(values.hour) * 60 + Number(values.minute) };
}

function minutosHorario(value){
  const [hora, minuto] = String(value || '00:00').split(':').map(Number);
  return hora * 60 + minuto;
}

function statusHorarioPedidos(state, agora = new Date()){
  const operacao = state?.operacao || {};
  if(operacao.modoLoja === 'aberto'){
    return { aberto: true, modo: 'aberto', mensagem: 'Pedidos online abertos manualmente.' };
  }
  if(operacao.modoLoja === 'fechado'){
    return { aberto: false, modo: 'fechado', mensagem: 'A loja encerrou os pedidos manualmente no momento.' };
  }

  const horarios = normalizarHorarios(operacao.horarios);
  const { dia, minutos } = partesHorarioLoja(agora);
  const hoje = horarios[DIAS_SEMANA[dia]];
  const ontem = horarios[DIAS_SEMANA[(dia + 6) % 7]];
  const inicioHoje = minutosHorario(hoje.abertura);
  const fimHoje = minutosHorario(hoje.fechamento);
  const inicioOntem = minutosHorario(ontem.abertura);
  const fimOntem = minutosHorario(ontem.fechamento);

  let aberto = false;
  if(inicioHoje !== fimHoje){
    aberto = fimHoje > inicioHoje
      ? minutos >= inicioHoje && minutos < fimHoje
      : minutos >= inicioHoje;
  }
  if(!aberto && inicioOntem !== fimOntem && fimOntem < inicioOntem){
    aberto = minutos < fimOntem;
  }

  return {
    aberto,
    modo: 'automatico',
    mensagem: aberto
      ? 'Pedidos online abertos agora.'
      : 'Estamos fechados no momento. Consulte os horários de atendimento.',
  };
}

function defaults(){
  return {
    ingredientes: Object.fromEntries(INGREDIENTES.map(([id]) => [id, true])),
    produtos: Object.fromEntries(PRODUTOS.map(([nome]) => [nome, true])),
    operacao: { demanda: 'normal', modoLoja: 'automatico', horarios: normalizarHorarios(HORARIO_PADRAO) },
    updatedAt: null,
    itensNovos: [],
  };
}

function mergeState(raw){
  const base = defaults();
  if(raw && typeof raw === 'object'){
    for(const [id] of INGREDIENTES){
      if(typeof raw.ingredientes?.[id] === 'boolean') base.ingredientes[id] = raw.ingredientes[id];
    }
    for(const [nome] of PRODUTOS){
      if(typeof raw.produtos?.[nome] === 'boolean'){
        base.produtos[nome] = raw.produtos[nome];
      }else if(nome === 'Refriko 2L' && typeof raw.produtos?.['Refrico 2L'] === 'boolean'){
        base.produtos[nome] = raw.produtos['Refrico 2L'];
      }
    }
    base.itensNovos = Array.isArray(raw.itensNovos) ? raw.itensNovos : [];
    for(const item of base.itensNovos){
      if(item.categoria === 'adicional') base.ingredientes[item.id] = raw.ingredientes?.[item.id] !== false;
      else base.produtos[item.nome] = raw.produtos?.[item.nome] !== false;
    }
    const demanda = raw.operacao?.demanda;
    if(['baixa','normal','alta'].includes(demanda)) base.operacao.demanda = demanda;
    const modoLoja = raw.operacao?.modoLoja;
    if(['automatico','aberto','fechado'].includes(modoLoja)) base.operacao.modoLoja = modoLoja;
    base.operacao.horarios = normalizarHorarios(raw.operacao?.horarios);
    if(typeof raw.updatedAt === 'string') base.updatedAt = raw.updatedAt;
  }
  return base;
}

function catalogo(state = defaults()){
  return {
    ingredientes: [...INGREDIENTES.map(([id, nome]) => ({ id, nome, afeta: [...(DEPENDENCIAS[id] || []), ...state.itensNovos.filter(i => i.ingredientes?.includes(id)).map(i => i.nome)] })), ...state.itensNovos.filter(i => i.categoria === 'adicional').map(i => ({id:i.id, nome:i.nome, afeta:[], precoCentavos:i.precoCentavos}))],
    produtos: [...PRODUTOS.map(([nome, categoria]) => ({ nome, categoria })), ...state.itensNovos.filter(i => i.categoria !== 'adicional').map(i => ({...i, categoria: {'dog':'Lanches-Dog','x':'Lanches-X','bebidas':'Bebidas'}[i.categoria]}))],
  };
}

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

async function readFallbackState(){
  const runtime = await readRuntimeState();
  const state = runtime.value || disponibilidadeCache.state || defaults();
  const storageMode = runtime.available ? 'runtime-cache' : disponibilidadeCache.storageMode;
  saveCache(state, storageMode);
  return {
    state,
    storageReady: runtime.available,
    storageMode,
    cacheHit: Boolean(runtime.value || disponibilidadeCache.state),
    storageBackoff: true,
    storageDegraded: true,
  };
}

async function readState({ force = false } = {}){
  const now = Date.now();

  if(storageBackoff.until > now){
    return readFallbackState();
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

  try{
    const result = await readJson(BLOB_PATH);
    if(result.value){
      const state = mergeState(result.value);
      saveCache(state, result.mode);
      clearStorageBackoff();
      writeRuntimeState(state).catch(() => {});
      return { state, storageReady: true, storageMode: result.mode, cacheHit: false, storageBackoff: false, storageDegraded: false };
    }

    const state = defaults();
    const saved = await writeJson(BLOB_PATH, state, { allowOverwrite: true });
    saveCache(state, saved.mode);
    clearStorageBackoff();
    writeRuntimeState(state).catch(() => {});
    return { state, storageReady: true, storageMode: saved.mode, cacheHit: false, storageBackoff: false, storageDegraded: false };
  }catch(err){
    if(!isStorageSuspended(err) && !isStorageUnavailable(err)) throw err;
    armStorageBackoff(err);
    console.warn('[disponibilidade] storage_indisponivel_usando_runtime_cache', { error: String(err) });
    return readFallbackState();
  }
}

async function writeState(state){
  try{
    const saved = await writeJson(BLOB_PATH, state, { allowOverwrite: true });
    saveCache(state, saved.mode);
    clearStorageBackoff();
    writeRuntimeState(state).catch(() => {});
    return { ...saved, storageDegraded: false };
  }catch(err){
    if(!isStorageSuspended(err) && !isStorageUnavailable(err)) throw err;
    armStorageBackoff(err);
    console.warn('[disponibilidade] storage_indisponivel_salvando_runtime_cache', { error: String(err) });
    const saved = await writeRuntimeState(state);
    saveCache(saved.state, saved.mode);
    return saved;
  }
}

module.exports = async function handler(req, res){
  const adminRequest = Boolean(req.headers['x-admin-password']);
  const freshRequest = req.method === 'GET' && String(req.query?.fresh || '') === '1';
  if(req.method === 'GET' && !adminRequest && !freshRequest){
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
  res.setHeader('Vary', 'X-Admin-Password');

  if(req.method === 'GET'){
    const recebida = req.headers['x-admin-password'];
    const adminPassword = process.env.ADMIN_PASSWORD || '';
    let authenticated;

    if(recebida){
      if(!origemPermitida(req)) return res.status(403).json({ error: 'Origem não permitida.' });
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
      const { state, storageReady, storageMode, cacheHit, storageBackoff: backoff, storageDegraded } = await readState({ force: Boolean(recebida) || freshRequest });
      return res.status(200).json({ ...state, statusLoja: statusHorarioPedidos(state), catalogo: catalogo(state), storageReady, storageMode, cacheHit, storageBackoff: Boolean(backoff), storageDegraded: Boolean(storageDegraded), adminConfigured: Boolean(adminPassword), authenticated });
    }catch(err){
      console.error('Falha ao ler disponibilidade:', err);
      const staleState = disponibilidadeCache.state || defaults();
      return res.status(200).json({
        ...staleState,
        statusLoja: statusHorarioPedidos(staleState),
        catalogo: catalogo(staleState),
        storageReady: false,
        storageMode: disponibilidadeCache.storageMode,
        cacheHit: Boolean(disponibilidadeCache.state),
        storageBackoff: storageBackoff.until > Date.now(),
        storageDegraded: true,
        adminConfigured: Boolean(adminPassword),
        authenticated,
      });
    }
  }

  if(req.method === 'POST'){
    if(!origemPermitida(req)) return res.status(403).json({ error: 'Origem não permitida.' });
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if(!contentType.includes('application/json')){
      return res.status(415).json({ error: 'Conteúdo deve ser enviado em JSON.' });
    }
    const contentLength = Number(req.headers['content-length'] || 0);
    if(Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES){
      return res.status(413).json({ error: 'Requisição muito grande.' });
    }
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
      if(!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({error:'Dados inválidos.'});
      if(Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) return res.status(413).json({error:'Requisição muito grande.'});
      const current = await readState({force:true});
      if(!current.storageReady) return res.status(503).json({error:'Armazenamento indisponível. Tente novamente.'});
      if(body.updatedAt !== current.state.updatedAt) return res.status(409).json({error:'O painel foi atualizado em outro acesso. Recarregue a página antes de salvar.'});
      const itensNovos = body.novoItem ? addItem(current.state.itensNovos, body.novoItem, INGREDIENTES.map(([id]) => id)) : current.state.itensNovos;
      const next = mergeState({...body, itensNovos});
      next.updatedAt = new Date().toISOString();
      const saved = await writeState(next);
      return res.status(200).json({
        ...next,
        statusLoja: statusHorarioPedidos(next),
        catalogo: catalogo(next),
        storageReady: true,
        storageMode: saved.mode,
        storageDegraded: Boolean(saved.storageDegraded),
      });
    }catch(err){
      if(err.status) return res.status(err.status).json({error:err.message});
      if(err instanceof SyntaxError) return res.status(400).json({error:'JSON inválido.'});
      console.error('Falha ao salvar disponibilidade:', err);
      return res.status(503).json({ error: 'Não foi possível salvar. Verifique se um Vercel Blob está conectado ao projeto.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Método não permitido.' });
};

module.exports.readOrderCatalog = async function(){ const {state} = await readState({force:true}); return orderCatalog(state.itensNovos); };
module.exports.readStoreStatus = async function(){ const {state} = await readState({force:true}); return statusHorarioPedidos(state); };
module.exports.statusHorarioPedidos = statusHorarioPedidos;
