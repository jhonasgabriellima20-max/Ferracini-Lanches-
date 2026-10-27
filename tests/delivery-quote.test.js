const assert = require('node:assert/strict');
const { calcularDistanciaEndereco } = require('../lib/delivery-distance');
const { assinarCotacao, validarCotacao, TTL_MS } = require('../lib/delivery-quote');
const handler = require('../api/distancia');

const endereco = {
  rua: 'Rua do Canario', numero: '88', bairro: 'Paraiso', cidade: 'Londrina', cep: '86000000',
};
const antigo = process.env.GOOGLE_MAPS_API_KEY;
const buscarAnterior = global.fetch;
process.env.GOOGLE_MAPS_API_KEY = 'chave-privada-usada-apenas-no-teste';
let googleCalls = 0;

function resposta(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function post(end) {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '192.0.2.55' },
    body: { endereco: end },
  }, res);
  return res;
}

(async () => {
  try {
    global.fetch = async url => {
      if (!String(url).includes('routes.googleapis.com')) throw new Error('fallback_inesperado');
      googleCalls += 1;
      return resposta(200, { routes: [{ distanceMeters: googleCalls === 1 ? 5660 : 4830 }] });
    };

    const primeira = await post(endereco);
    assert.equal(primeira.statusCode, 200);
    assert.equal(primeira.body.distanciaKm, 5.66);
    assert.equal(primeira.body.provider, 'google');
    assert.ok(primeira.body.cotacaoFrete);
    assert.equal(validarCotacao(primeira.body.cotacaoFrete, endereco, 5.66), true);
    assert.equal(validarCotacao(primeira.body.cotacaoFrete, endereco, 4.83), false);
    assert.equal(validarCotacao(primeira.body.cotacaoFrete, { ...endereco, numero: '99' }, 5.66), false);
    assert.equal(validarCotacao(primeira.body.cotacaoFrete, { ...endereco, rua: 'Avenida do Canario' }, 5.66), false);
    assert.equal(validarCotacao(primeira.body.cotacaoFrete + 'x', endereco, 5.66), false);

    const segunda = await post({ ...endereco, rua: '  Rua do Canário ' });
    assert.equal(segunda.statusCode, 200);
    assert.equal(segunda.body.distanciaKm, 5.66);
    assert.equal(googleCalls, 1, 'mesmo endereco nao deve disparar nova rota na mesma instancia');

    const tokenVencido = assinarCotacao(endereco, 5.66, Date.now() - TTL_MS - 1000);
    assert.equal(validarCotacao(tokenVencido, endereco, 5.66), false);

    const outro = await post({ ...endereco, cidade: 'Curitiba' });
    assert.equal(outro.statusCode, 422);
    assert.equal(googleCalls, 1, 'fora de Londrina nao consulta Google');

    const [simultaneaA, simultaneaB] = await Promise.all([
      calcularDistanciaEndereco({ ...endereco, numero: '202' }),
      calcularDistanciaEndereco({ ...endereco, numero: '202' }),
    ]);
    assert.equal(simultaneaA.distanciaKm, 4.83);
    assert.equal(simultaneaB.distanciaKm, 4.83);
    assert.equal(googleCalls, 2, 'consultas simultaneas do mesmo endereco devem compartilhar a rota');

    global.fetch = async url => resposta(503, { error: 'provider unavailable' });
    const semProvedor = await post({ ...endereco, numero: '101' });
    assert.equal(semProvedor.statusCode, 503, 'provedores fora devem retornar 503, nao 422');
    assert.equal(semProvedor.headers['Retry-After'], '15');

    console.log('OK - cotacao assinada, endereco vinculado, cache e 422/503 distintos');
  } finally {
    global.fetch = buscarAnterior;
    if (antigo === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = antigo;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
