'use strict';

const assert = require('node:assert/strict');
const { calcularDistanciaEndereco } = require('../lib/delivery-distance');
const handler = require('../api/distancia');

const base = { rua: 'Rua Teste', numero: '10', bairro: 'Centro', cidade: 'Londrina' };
const different = { ...base, rua: 'Rua Outra', numero: '20' };
const partial = { ...base, rua: 'Rua Terceira', numero: '30' };
const failing = { ...base, rua: 'Rua Quarta', numero: '40' };

function mockJson(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function run() {
  process.env.GOOGLE_MAPS_API_KEY = 'mock';
  let googleCalls = 0;
  let photonCalls = 0;
  let osrmCalls = 0;

  global.fetch = async (url, options = {}) => {
    if (String(url).includes('routes.googleapis.com')) {
      googleCalls += 1;
      const request = JSON.parse(options.body);
      assert.deepEqual(request.origin.location.latLng, {
        latitude: -23.2816671, longitude: -51.1569058,
      }, 'Origem precisa ser fixa e nao geocodificada a cada consulta');
      const target = request.destination.address;
      if (target.includes('Quarta')) return mockJson({ error: 'temporary' }, 503);
      if (target.includes('Terceira')) {
        return mockJson({
          routes: [{ distanceMeters: 4700 }],
          geocodingResults: { destination: { partialMatch: true } },
        });
      }
      return mockJson({
        routes: [{ distanceMeters: target.includes('Outra') ? 4830 : googleCalls === 1 ? 5660 : 4830 }],
        geocodingResults: { destination: { partialMatch: false, placeId: 'mock-place' } },
      });
    }
    if (String(url).includes('photon.komoot.io')) {
      photonCalls += 1;
      const q = decodeURIComponent(new URL(url).searchParams.get('q'));
      if (q.includes('Quarta')) return mockJson({ error: 'temporary' }, 503);
      return mockJson({ features: [{
        properties: { city: 'Londrina', state: 'Parana', countrycode: 'BR', street: 'Rua Terceira', housenumber: '30' },
        geometry: { coordinates: [-51.16, -23.29] },
      }] });
    }
    if (String(url).includes('router.project-osrm.org')) {
      osrmCalls += 1;
      return mockJson({ routes: [{ distance: 4700 }] });
    }
    throw new Error('Unexpected URL ' + url);
  };

  const first = await calcularDistanciaEndereco(base);
  assert.equal(first.distanciaKm, 5.66);
  assert.equal(first.provider, 'google');

  const second = await calcularDistanciaEndereco({ ...base, rua: ' rua  teste ' });
  assert.equal(second.distanciaKm, 5.66, 'Mesma entrega nao pode oscilar para 4.83 km');
  assert.equal(googleCalls, 1, 'A segunda leitura deve usar cache');

  const other = await calcularDistanciaEndereco(different);
  assert.equal(other.distanciaKm, 4.83, 'Enderecos distintos jamais compartilham cache');

  await assert.rejects(() => calcularDistanciaEndereco({ ...base, cidade: 'Curitiba' }), /fora_de_londrina/);

  const fallback = await calcularDistanciaEndereco(partial);
  assert.equal(fallback.provider, 'photon_osrm', 'Correspondencia parcial Google nao pode ser aceita');
  assert.equal(fallback.distanciaKm, 4.7);
  assert.equal(photonCalls, 1);
  assert.equal(osrmCalls, 1);

  await assert.rejects(() => calcularDistanciaEndereco(failing), { code: 'ROUTE_PROVIDERS_UNAVAILABLE' });

  const res = {
    headers: {},
    statusCode: 200,
    setHeader(key, value) { this.headers[key] = value; return this; },
    status(n) { this.statusCode = n; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { endereco: failing } }, res);
  assert.equal(res.statusCode, 503, 'Pane de fornecedores nao pode ser apresentada como endereco invalido');

  const res422 = {
    headers: {},
    setHeader(key, value) { this.headers[key] = value; return this; },
    status(n) { this.statusCode = n; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler({ method: 'POST', headers: { 'content-type': 'application/json' },
    body: { endereco: { ...base, cidade: 'Curitiba' } } }, res422);
  assert.equal(res422.statusCode, 422, 'Cidade fora da area deve continuar 422');

  console.log('OK: frete consistente, origem fixa, cache, fallback, 503 e 422');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
