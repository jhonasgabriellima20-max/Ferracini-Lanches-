/**
 * POST /api/distancia
 * Google Routes e o provedor principal. Photon + OSRM e usado somente como
 * contingencia, sempre validando que o resultado pertence a Londrina/PR.
 */

const TIMEOUT_MS = 15000;
const MAX_ROUTE_KM = 35;
const STORE_COORDS = { lon: -51.1569058, lat: -23.2816671 };
const cache = new Map();

function fetchComTimeout(url, options = {}, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}

function texto(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizar(value) {
  return texto(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(rua|r|avenida|av|travessa|tv)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
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

async function rotaGoogle(apiKey, origem, destino) {
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
        origin: { address: origem },
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
    headers: { 'User-Agent': 'FerraciniLanches/1.2 (delivery-distance)' },
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
    headers: { 'User-Agent': 'FerraciniLanches/1.2 (delivery-distance)' },
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

  const body = req.body || {};
  const origem = texto(body.origem);
  const destino = texto(body.destino);
  const endereco = {
    rua: texto(body.endereco?.rua),
    numero: texto(body.endereco?.numero),
    bairro: texto(body.endereco?.bairro),
    cidade: texto(body.endereco?.cidade || 'Londrina'),
    cep: texto(body.endereco?.cep).replace(/\D/g, '').slice(0, 8),
  };

  if (!origem || !destino || !endereco.rua || !endereco.numero || !endereco.bairro) {
    return res.status(400).json({ error: 'Preencha rua, numero, bairro e cidade.' });
  }
  if (normalizar(endereco.cidade) !== 'londrina') {
    return res.status(422).json({ error: 'No momento, a entrega automatica atende somente Londrina.' });
  }

  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const apiKey = texto(process.env.GOOGLE_MAPS_API_KEY);

  if (apiKey) {
    try {
      const distanciaKm = await rotaGoogle(apiKey, origem, destino);
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
