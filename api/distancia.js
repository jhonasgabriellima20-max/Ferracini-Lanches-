/**
 * POST /api/distancia
 * Calcula a rota no servidor. Google Routes é o provedor principal;
 * Photon + OSRM é usado somente como contingência validada em Londrina/PR.
 */

const { calcularDistanciaEndereco, normalizarEndereco, normalizar } = require('../lib/delivery-distance');

const MAX_BODY_BYTES = 8 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;
const buckets = globalThis.__ferraciniDistanceRateBuckets || new Map();
globalThis.__ferraciniDistanceRateBuckets = buckets;

function texto(value, max = 200) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function origemPermitida(req) {
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = texto(req.headers.origin, 300);
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return false;
    return url.hostname === 'ferracinilanches.com.br' ||
      url.hostname === 'www.ferracinilanches.com.br' ||
      /^ferracini-lanches(?:-[a-z0-9-]+)?(?:-jho-n)?\.vercel\.app$/i.test(url.hostname) ||
      url.hostname === 'localhost';
  } catch {
    return false;
  }
}

function rateLimit(req) {
  const now = Date.now();
  const key = texto(
    String(req.headers['x-vercel-forwarded-for'] || '').split(',')[0] ||
      String(req.headers['x-forwarded-for'] || '').split(',')[0] ||
      req.headers['x-real-ip'] ||
      'unknown',
    100
  );
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  current.count += 1;
  if (buckets.size > 1000) {
    for (const [bucketKey, value] of buckets) {
      if (value.resetAt <= now) buckets.delete(bucketKey);
    }
  }
  return {
    ok: current.count <= RATE_MAX,
    retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Metodo nao permitido.' });
  }
  if (!origemPermitida(req)) {
    return res.status(403).json({ error: 'Origem nao permitida.' });
  }

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return res.status(415).json({ error: 'Conteudo deve ser enviado em JSON.' });
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Requisicao muito grande.' });
  }

  const limite = rateLimit(req);
  res.setHeader('X-RateLimit-Limit', String(RATE_MAX));
  if (!limite.ok) {
    res.setHeader('Retry-After', String(limite.retryAfter));
    return res.status(429).json({ error: 'Muitas consultas de frete. Tente novamente em instantes.' });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); }
    catch { return res.status(400).json({ error: 'JSON invalido.' }); }
  }

  const endereco = normalizarEndereco(body.endereco || {});
  if (!endereco.rua || !endereco.numero || !endereco.bairro || !endereco.cidade) {
    return res.status(400).json({ error: 'Preencha rua, numero, bairro e cidade.' });
  }
  if (normalizar(endereco.cidade) !== 'londrina') {
    return res.status(422).json({ error: 'No momento, a entrega automatica atende somente Londrina.' });
  }

  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const resultado = await calcularDistanciaEndereco(endereco);
    console.log('[distancia] sucesso', {
      requestId,
      provider: resultado.provider,
      distanciaKm: resultado.distanciaKm,
    });
    return res.status(200).json({
      distanciaKm: resultado.distanciaKm,
      provider: resultado.provider,
    });
  } catch (error) {
    console.error('[distancia] calculo_falhou', { requestId, error: String(error) });
    return res.status(422).json({
      error: 'Nao conseguimos confirmar esse endereco em Londrina. Confira rua, numero e bairro ou fale com a lanchonete.',
    });
  }
};
