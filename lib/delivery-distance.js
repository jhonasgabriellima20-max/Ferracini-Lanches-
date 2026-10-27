const crypto = require('node:crypto');
const TIMEOUT_MS = 15000;
const DISTANCE_CACHE_TTL_SECONDS = 30 * 60;
const FALLBACK_CACHE_TTL_SECONDS = 3 * 60;
const confirmedDistanceCache = globalThis.__ferraciniConfirmedDistanceCache || new Map();
globalThis.__ferraciniConfirmedDistanceCache = confirmedDistanceCache;
const pendingDistanceCalculations = globalThis.__ferraciniPendingDistanceCalculations || new Map();
globalThis.__ferraciniPendingDistanceCalculations = pendingDistanceCalculations;
let runtimeDistanceCache;

function sharedDistanceCache() {
  if (runtimeDistanceCache !== undefined) return runtimeDistanceCache;
  try {
    const { getCache } = require('@vercel/functions');
    runtimeDistanceCache = typeof getCache === 'function'
      ? getCache({ namespace: 'ferracini-distance-v2' })
      : null;
  } catch {
    runtimeDistanceCache = null; // Testes locais e ambientes sem Runtime Cache.
  }
  return runtimeDistanceCache;
}

function distanceCacheKey(endereco) {
  const parts = [endereco.rua, endereco.numero, endereco.bairro, endereco.cidade, endereco.cep];
  const canonical = parts.map(value => normalizar(value)).join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function readConfirmedDistance(key) {
  const local = confirmedDistanceCache.get(key);
  if (local && local.expires > Date.now() && validarDistancia(local.value.distanciaKm)) {
    return local.value;
  }
  const shared = sharedDistanceCache();
  if (!shared) return null;
  try {
    const value = await shared.get(key);
    if (!value || !validarDistancia(value.distanciaKm) ||
        !['google', 'photon_osrm'].includes(value.provider)) return null;
    const ttl = value.provider === 'google' ? DISTANCE_CACHE_TTL_SECONDS : FALLBACK_CACHE_TTL_SECONDS;
    confirmedDistanceCache.set(key, { value, expires: Date.now() + ttl * 1000 });
    return value;
  } catch (error) {
    console.warn('[delivery-distance] cache_leitura_falhou', { error: String(error) });
    return null;
  }
}

async function writeConfirmedDistance(key, value) {
  const ttl = value.provider === 'google' ? DISTANCE_CACHE_TTL_SECONDS : FALLBACK_CACHE_TTL_SECONDS;
  confirmedDistanceCache.set(key, { value, expires: Date.now() + ttl * 1000 });
  if (confirmedDistanceCache.size > 1000) {
    for (const [k, entry] of confirmedDistanceCache) {
      if (entry.expires <= Date.now()) confirmedDistanceCache.delete(k);
    }
  }
  const shared = sharedDistanceCache();
  if (!shared) return;
  try {
    await shared.set(key, value, { ttl, name: 'frete-endereco-confirmado' });
  } catch (error) {
    console.warn('[delivery-distance] cache_escrita_falhou', { error: String(error) });
  }
}
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

function montarDestinosGoogle(endereco) {
  const base = `${endereco.rua}, ${endereco.numero}`;
  const candidatos = [
    [base, endereco.bairro, endereco.cep ? `CEP ${endereco.cep}` : '', 'Londrina', 'PR', 'Brasil'],
    [base, endereco.cep ? `CEP ${endereco.cep}` : '', 'Londrina', 'PR', 'Brasil'],
    [base, endereco.bairro, 'Londrina', 'PR', 'Brasil'],
    [base, 'Londrina', 'PR', 'Brasil'],
  ]
    .map(partes => partes.filter(Boolean).join(', '))
    .filter(Boolean);

  return [...new Set(candidatos)];
}

async function rotaGoogleUnica(apiKey, destino) {
  const response = await fetchComTimeout(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters,geocodingResults.destination.partialMatch,geocodingResults.destination.placeId',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: STORE_COORDS.lat, longitude: STORE_COORDS.lon } } },
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
  // O Google pode calcular uma rota para apenas parte do endereco, sem confirmar o numero.
  if (data?.geocodingResults?.destination?.partialMatch === true) {
    throw new Error('google_endereco_parcial');
  }
  const metros = data?.routes?.[0]?.distanceMeters;
  if (typeof metros !== 'number' || !Number.isFinite(metros)) {
    throw new Error('google_sem_distancia');
  }

  const km = metros / 1000;
  if (!validarDistancia(km)) throw new Error(`google_distancia_invalida_${km}`);
  return Math.round(km * 100) / 100;
}

async function rotaGoogle(apiKey, destinos) {
  let ultimoErro = null;
  const lista = Array.isArray(destinos) ? destinos : [destinos];

  for (let i = 0; i < lista.length; i += 1) {
    try {
      const distanciaKm = await rotaGoogleUnica(apiKey, lista[i]);
      if (i > 0) {
        console.info('[delivery-distance] google_endereco_alternativo', {
          tentativa: i + 1,
          distanciaKm,
        });
      }
      return distanciaKm;
    } catch (error) {
      ultimoErro = error;
      const mensagem = String(error);
      const erroHttp = /google_http_(\d{3})/.exec(mensagem);
      const status = erroHttp ? Number(erroHttp[1]) : 0;

      // Erros de credencial, limite ou servidor nao melhoram alterando o texto do endereco.
      if (status === 401 || status === 403 || status === 429 || status >= 500 ||
          (status === 400 && /API_KEY_INVALID|API key not valid/i.test(mensagem))) break;

      if (i < lista.length - 1) {
        console.warn('[delivery-distance] google_tentativa_falhou', {
          tentativa: i + 1,
          error: mensagem,
        });
      }
    }
  }

  throw ultimoErro || new Error('google_sem_rota');
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
  if (!ruaAchada) return -Infinity;
  if (ruaEsperada && ruaAchada) {
    if (ruaAchada === ruaEsperada) score += 60;
    else if (ruaAchada.includes(ruaEsperada) || ruaEsperada.includes(ruaAchada)) score += 30;
    else return -Infinity;
  }

  const numeroEsperado = texto(endereco.numero);
  const numeroAchado = texto(p.housenumber);
  if (numeroEsperado && numeroAchado) {
    if (numeroAchado === numeroEsperado) score += 50;
    else score -= 90;
  }
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

async function calcularDistanciaSemCache(endereco, options) {
  const destinos = montarDestinosGoogle(endereco);
  const apiKey = texto(options.apiKey || process.env.GOOGLE_MAPS_API_KEY, 500);
  let googleError = null;

  if (apiKey) {
    try {
      return { distanciaKm: await rotaGoogle(apiKey, destinos), provider: 'google' };
    } catch (error) {
      if (options.googleOnly) throw error;
      googleError = error;
      console.warn('[delivery-distance] google_falhou', { error: String(error) });
    }
  } else if (options.googleOnly) {
    throw new Error('google_key_ausente');
  }

  try {
    const coordenadas = await geocodePhoton(endereco);
    const distanciaKm = await rotaOsrm(coordenadas);
    return { distanciaKm, provider: 'photon_osrm' };
  } catch (error) {
    // Um endereco nao encontrado nao equivale a pane de fornecedor.
    const fallbackFailure = /(?:photon|osrm)_http_(?:429|5\d\d)|AbortError|TimeoutError/i.test(String(error));
    if (fallbackFailure) {
      const providerError = new Error('provedores_de_rota_indisponiveis');
      providerError.code = 'ROUTE_PROVIDERS_UNAVAILABLE';
      providerError.cause = error;
      console.error('[delivery-distance] fallback_falhou', {
        googleError: googleError ? String(googleError) : 'google_nao_configurado',
        fallbackError: String(error),
      });
      throw providerError;
    }
    throw error;
  }
}

async function calcularDistanciaEndereco(rawEndereco, options = {}) {
  const endereco = normalizarEndereco(rawEndereco);
  validarEndereco(endereco);

  // O mesmo endereco precisa ter o mesmo valor na tela e na conferencia do pedido.
  // Runtime Cache e compartilhado entre instancias da Vercel na mesma regiao.
  const useCache = !options.disableCache && !options.googleOnly;
  const key = useCache ? distanceCacheKey(endereco) : null;
  if (!useCache) return { ...(await calcularDistanciaSemCache(endereco, options)), endereco };

  const cached = await readConfirmedDistance(key);
  if (cached) {
    console.info('[delivery-distance] distancia_cache_hit', { provider: cached.provider });
    return { ...cached, endereco };
  }

  if (pendingDistanceCalculations.has(key)) {
    const result = await pendingDistanceCalculations.get(key);
    return { ...result, endereco };
  }

  const calculation = (async () => {
    const result = await calcularDistanciaSemCache(endereco, options);
    await writeConfirmedDistance(key, result);
    return result;
  })();
  pendingDistanceCalculations.set(key, calculation);
  try {
    const result = await calculation;
    return { ...result, endereco };
  } finally {
    pendingDistanceCalculations.delete(key);
  }
}

module.exports = {
  MAX_ROUTE_KM,
  STORE_ADDRESS,
  normalizar,
  normalizarEndereco,
  calcularDistanciaEndereco,
};
