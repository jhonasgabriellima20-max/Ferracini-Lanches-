const TIMEOUT_MS = 15000;
const MAX_ROUTE_KM = 35;
const STORE_COORDS = { lon: -51.1569058, lat: -23.2816671 };
const STORE_ADDRESS = 'Rua do Pelicano, 163, Paraíso, Londrina - PR, Brasil';
const cache = globalThis.__ferraciniDistanceCache || new Map();
globalThis.__ferraciniDistanceCache = cache;

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

function normalizarEndereco(raw = {}) {
  return {
    rua: texto(raw.rua, 120),
    numero: texto(raw.numero, 20),
    bairro: texto(raw.bairro, 100),
    cidade: texto(raw.cidade || 'Londrina', 80),
    cep: texto(raw.cep, 10).replace(/\D/g, '').slice(0, 8),
  };
}

function validarEndereco(endereco) {
  if (!endereco.rua || !endereco.numero || !endereco.bairro || !endereco.cidade) {
    const err = new Error('endereco_incompleto');
    err.code = 'ENDERECO_INCOMPLETO';
    throw err;
  }
  if (normalizar(endereco.cidade) !== 'londrina') {
    const err = new Error('fora_de_londrina');
    err.code = 'FORA_DE_LONDRINA';
    throw err;
  }
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
    headers: { 'User-Agent': 'FerraciniLanches/1.4 (delivery-distance)' },
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
    headers: { 'User-Agent': 'FerraciniLanches/1.4 (delivery-distance)' },
  });
  if (!response.ok) throw new Error(`osrm_http_${response.status}`);
  const data = await response.json();
  const metros = data?.routes?.[0]?.distance;
  const km = typeof metros === 'number' ? metros / 1000 : NaN;
  if (!validarDistancia(km)) throw new Error(`osrm_distancia_invalida_${km}`);
  return Math.round(km * 100) / 100;
}

async function calcularDistanciaEndereco(rawEndereco, options = {}) {
  const endereco = normalizarEndereco(rawEndereco);
  validarEndereco(endereco);
  const destino = montarDestino(endereco);
  const apiKey = texto(options.apiKey || process.env.GOOGLE_MAPS_API_KEY, 500);

  if (apiKey) {
    try {
      return { distanciaKm: await rotaGoogle(apiKey, destino), provider: 'google', endereco };
    } catch (error) {
      if (options.googleOnly) throw error;
      console.warn('[delivery-distance] google_falhou', { error: String(error) });
    }
  } else if (options.googleOnly) {
    throw new Error('google_key_ausente');
  }

  const coordenadas = await geocodePhoton(endereco);
  const distanciaKm = await rotaOsrm(coordenadas);
  return { distanciaKm, provider: 'photon_osrm', endereco };
}

module.exports = {
  MAX_ROUTE_KM,
  STORE_ADDRESS,
  normalizar,
  normalizarEndereco,
  calcularDistanciaEndereco,
};
