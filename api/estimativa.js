const { estimarPrazo } = require('../lib/prep-estimator');

const MAX_BODY_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30;
const buckets = globalThis.__ferraciniEstimativaRateBuckets || new Map();
globalThis.__ferraciniEstimativaRateBuckets = buckets;

function texto(value, max = 200){
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function origemPermitida(req){
  if(String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = texto(req.headers.origin, 300);
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

function rateLimit(req){
  const now = Date.now();
  const key = texto(
    String(req.headers['x-vercel-forwarded-for'] || '').split(',')[0] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0] ||
    req.headers['x-real-ip'] ||
    'unknown',
    100
  );
  const current = buckets.get(key);
  if(!current || current.resetAt <= now){
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  current.count += 1;
  return {
    ok: current.count <= RATE_MAX,
    retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

function validarItens(raw){
  if(!Array.isArray(raw) || raw.length < 1 || raw.length > 40) throw new Error('Itens inválidos.');
  return raw.map(item => {
    const nome = texto(item?.nome, 100);
    const quantidade = Math.trunc(Number(item?.quantidade));
    if(!nome || !Number.isSafeInteger(quantidade) || quantidade < 1 || quantidade > 50){
      throw new Error('Itens inválidos.');
    }
    return { nome, quantidade };
  });
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if(req.method !== 'POST'){
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido.' });
  }
  if(!origemPermitida(req)) return res.status(403).json({ error: 'Origem não permitida.' });

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if(!contentType.includes('application/json')) return res.status(415).json({ error: 'Conteúdo deve ser enviado em JSON.' });
  if(Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) return res.status(413).json({ error: 'Requisição muito grande.' });

  const limit = rateLimit(req);
  res.setHeader('X-RateLimit-Limit', String(RATE_MAX));
  if(!limit.ok){
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: 'Muitas consultas em sequência.' });
  }

  try{
    let body = req.body;
    if(typeof body === 'string') body = JSON.parse(body || '{}');

    const tipo = texto(body?.tipo, 20);
    if(tipo !== 'entrega') throw new Error('Tipo de atendimento inválido.');
    const itens = validarItens(body?.itens);
    const distanciaKm = Number(body?.distanciaKm);
    if(!Number.isFinite(distanciaKm) || distanciaKm <= 0 || distanciaKm > 35){
      throw new Error('Distância inválida.');
    }

    const config = await require('./disponibilidade').readPrepConfig();
    const resultado = await estimarPrazo({ itens, tipo, distanciaKm, config });
    return res.status(200).json(resultado);
  }catch(err){
    const message = err instanceof SyntaxError ? 'JSON inválido.' : (err?.message || 'Não foi possível calcular a previsão.');
    const clientErrors = ['Itens inválidos.','Tipo de atendimento inválido.','Distância inválida.','JSON inválido.'];
    if(clientErrors.includes(message)) return res.status(400).json({ error: message });
    console.error('[estimativa] calculo_falhou', { error: String(err) });
    return res.status(503).json({ error: 'Não foi possível calcular a previsão agora.' });
  }
};
