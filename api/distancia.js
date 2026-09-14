/**
 * POST /api/distancia
 * Google Routes é o provedor principal. Photon + OSRM é usado somente como
 * contingência, sempre validando que o resultado pertence a Londrina/PR.
 */

const TIMEOUT_MS = 15000;
const MAX_ROUTE_KM = 35;
const MAX_BODY_BYTES = 8 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;
const STORE_COORDS = { lon: -51.1569058, lat: -23.2816671 };
const STORE_ADDRESS = 'Rua do Pelicano, 163, Paraíso, Londrina - PR, Brasil';
const cache = new Map();
const buckets = new Map();

function fetchComTimeout(url, options = {}, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}

function texto(value, max = 200) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function normalizar(value) {
  return texto(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(rua|r|avenida|av|travessa|tv)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
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

function distanciaRetaKm(a, b) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function validarDistancia(km) {
  return Number.isFinite(km) && km > 0 && km <= MAX_ROUTE_KM;
}

function montarDestino(endereco) {
  return [
    `${endereco.rua}, ${endereco.numero}`,
    endereco.bairro,
    endereco.cep ? `CEP ${endereco.cep}` : '',
    'Londrina',
    'PR',
    'Brasil',
  ].filter(Boolean).join(', ');
}

async function rotaGoogle(apiKey, destino) {
  const response = await fetchComTimeout(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters',
      },
      body: JSON.stringify({
        origin: { address: STORE_ADDRESS },
        destination: { address: destino },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
        languageCode: 'pt-BR',
        regionCode: 'BR',
        units: 'METRIC',
      }),
    }
  );

  if (!response.ok) {
    const detalhes = await response.text().catch(() => '');
    throw new Error(`google_http_${response.status}: ${detalhes.slice(0, 300)}`);
  }

  const data = await response.json();
  const metros = data?.routes?.[0]?.distanceMeters;
  const km = typeof metros === 'number' ? metros / 1000 : NaN;
  if (!validarDistancia(km)) throw new Error(`google_distancia_invalida_${km}`);
  return Math.round(km * 100) / 100;
}

function pontuar(feature, endereco) {
  const p = feature?.properties || {};
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return -Infinity;

  const city = normalizar(p.city || p.locality || p.county);
  const state = normalizar(p.state);
  const country = normalizar(p.countrycode || p.country);
  if (city !== 'londrina' || (state && state !== 'parana') ||
      (country && country !== 'br' && country !== 'brasil')) return -Infinity;

  const point = { lon: Number(coords[0]), lat: Number(coords[1]) };
  const reta = distanciaRetaKm(STORE_COORDS, point);
  if (!Number.isFinite(reta) || reta > MAX_ROUTE_KM) return -Infinity;

  let score = 100 - reta;
  const ruaEsperada = normalizar(endereco.rua);
  const ruaAchada = normalizar(p.street || (p.type === 'street' ? p.name : ''));
  if (ruaEsperada && ruaAchada) {
    if (ruaAchada === ruaEsperada) score += 60;
    else if (ruaAchada.includes(ruaEsperada) || ruaEsperada.includes(ruaAchada)) score += 30;
    else score -= 80;
  }
  if (texto(endereco.numero) && texto(p.housenumber) === texto(endereco.numero)) score += 50;
  if (normalizar(endereco.bairro) &&
      [p.district, p.locality].some(v => normalizar(v) === normalizar(endereco.bairro))) score += 25;
  return score;
}

async function geocodePhoton(endereco) {
  const chave = normalizar(`${endereco.rua}|${endereco.numero}|${endereco.bairro}|${endereco.cidade}|${endereco.cep || ''}`);
  const existente = cache.get(chave);
  if (existente && existente.expires > Date.now()) return existente.value;

  const consulta = [endereco.rua, endereco.numero, endereco.bairro, endereco.cep, 'Londrina', 'Parana', 'Brasil']
    .filter(Boolean).join(' ');
  const url = `https://photon.komoot.io/api/?limit=10&q=${encodeURIComponent(consulta)}`;
  const response = await fetchComTimeout(url, {
    headers: { 'User-Agent': 'FerraciniLanches/1.3 (delivery-distance)' },
  });
  if (!response.ok) throw new Error(`photon_http_${response.status}`);

  const data = await response.json();
  const ranked = (data?.features || [])
    .map(feature => ({ feature, score: pontuar(feature, endereco) }))
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length || ranked[0].score < 80) {
    throw new Error('endereco_nao_confirmado_em_londrina');
  }

  const [lon, lat] = ranked[0].feature.geometry.coordinates.map(Number);
  const value = { lon, lat };
  cache.set(chave, { value, expires: Date.now() + 6 * 60 * 60 * 1000 });
  return value;
}

async function rotaOsrm(destino) {
  const url = `https://router.project-osrm.org/route/v1/driving/` +
    `${STORE_COORDS.lon},${STORE_COORDS.lat};${destino.lon},${destino.lat}` +
    '?overview=false&steps=false';
  const response = await fetchComTimeout(url, {
    headers: { 'User-Agent': 'FerraciniLanches/1.3 (delivery-distance)' },
  });
  if (!response.ok) throw new Error(`osrm_http_${response.status}`);
  const data = await response.json();
  const metros = data?.routes?.[0]?.distance;
  const km = typeof metros === 'number' ? metros / 1000 : NaN;
  if (!validarDistancia(km)) throw new Error(`osrm_distancia_invalida_${km}`);
  return Math.round(km * 100) / 100;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Metodo nao permitido.' });
  }
  if (!origemPermitida(req)) {
    return res.status(403).json({ error: 'Origem nao permitida.' });
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Requisicao muito grande.' });
  }

  const limite = rateLimit(req);
  if (!limite.ok) {
    res.setHeader('Retry-After', String(limite.retryAfter));
    return res.status(429).json({ error: 'Muitas consultas de frete. Tente novamente em instantes.' });
  }

  const body = req.body || {};
  const endereco = {
    rua: texto(body.endereco?.rua, 120),
    numero: texto(body.endereco?.numero, 20),
    bairro: texto(body.endereco?.bairro, 100),
    cidade: texto(body.endereco?.cidade || 'Londrina', 80),
    cep: texto(body.endereco?.cep, 10).replace(/\D/g, '').slice(0, 8),
  };

  if (!endereco.rua || !endereco.numero || !endereco.bairro || !endereco.cidade) {
    return res.status(400).json({ error: 'Preencha rua, numero, bairro e cidade.' });
  }
  if (normalizar(endereco.cidade) !== 'londrina') {
    return res.status(422).json({ error: 'No momento, a entrega automatica atende somente Londrina.' });
  }

  const destino = montarDestino(endereco);
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const apiKey = texto(process.env.GOOGLE_MAPS_API_KEY, 500);

  if (apiKey) {
    try {
      const distanciaKm = await rotaGoogle(apiKey, destino);
      console.log('[distancia] sucesso', { requestId, provider: 'google', distanciaKm });
      return res.status(200).json({ distanciaKm, provider: 'google' });
    } catch (error) {
      console.warn('[distancia] google_falhou', { requestId, error: String(error) });
    }
  } else {
    console.warn('[distancia] chave_google_ausente', { requestId });
  }

  try {
    const coordenadas = await geocodePhoton(endereco);
    const distanciaKm = await rotaOsrm(coordenadas);
    console.log('[distancia] sucesso', { requestId, provider: 'photon_osrm', distanciaKm });
    return res.status(200).json({ distanciaKm, provider: 'photon_osrm' });
  } catch (error) {
    console.error('[distancia] contingencia_falhou', { requestId, error: String(error) });
    return res.status(422).json({
      error: 'Nao conseguimos confirmar esse endereco em Londrina. Confira rua, numero e bairro ou fale com a lanchonete.',
    });
  }
};
