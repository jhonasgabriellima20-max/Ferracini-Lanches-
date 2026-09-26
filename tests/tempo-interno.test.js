const assert = require('node:assert/strict');
const {
  MINUTOS_POR_LANCHE,
  contarLanches,
  calcularTempoInternoLanches,
  calcularFilaTempoInterno,
  calcularFila,
  estimarPrazo,
} = require('../lib/prep-estimator');

assert.equal(MINUTOS_POR_LANCHE, 5);

const casos = [
  { itens:[{ nome:'X-Salada', quantidade:1 }], lanches:1, minutos:5 },
  { itens:[{ nome:'X-Salada', quantidade:4 }], lanches:4, minutos:20 },
  { itens:[{ nome:'X-Bacon (1 Kilo)', quantidade:8 }], lanches:8, minutos:40 },
  { itens:[
      { nome:'X-Salada', quantidade:4 },
      { nome:'X-Frango', quantidade:3 },
      { nome:'Dog Simples', quantidade:4 },
    ], lanches:11, minutos:55 },
  { itens:[
      { nome:'X-Salada', quantidade:2 },
      { nome:'Coca-Cola 2L', quantidade:2 },
    ], lanches:2, minutos:10 },
];

for(const caso of casos){
  assert.equal(contarLanches(caso.itens), caso.lanches);
  assert.equal(calcularTempoInternoLanches(caso.itens), caso.minutos);
}

console.log('OK - regra interna: 5 minutos por lanche');
console.table(casos.map(c => ({ lanches:c.lanches, minutos:c.minutos })));


const t0 = new Date('2026-09-26T22:00:00.000Z');
const pedidosFila = [
  {
    criadoEm: t0.toISOString(),
    itens: [{ nome:'X-Salada', quantidade:4 }],
    atendimento: { tempoInternoMinutos: 20 },
  },
];

assert.equal(calcularFilaTempoInterno(pedidosFila, t0).filaMinutos, 20);
assert.equal(calcularFilaTempoInterno(pedidosFila, new Date(t0.getTime() + 5 * 60000)).filaMinutos, 15);
assert.equal(
  calcularFilaTempoInterno(pedidosFila, new Date(t0.getTime() + 5 * 60000)).filaMinutos +
    calcularTempoInternoLanches([{ nome:'X-Frango', quantidade:3 }]),
  30
);

const duasComandasImediatas = [
  ...pedidosFila,
  {
    criadoEm: t0.toISOString(),
    itens: [{ nome:'X-Frango', quantidade:3 }],
    atendimento: { tempoInternoMinutos: 15 },
  },
];
assert.equal(calcularFilaTempoInterno(duasComandasImediatas, t0).filaMinutos, 35);
assert.equal(calcularFilaTempoInterno(pedidosFila, new Date(t0.getTime() + 25 * 60000)).filaMinutos, 0);

console.log('OK - fila acumulada: 20 + 15 = 35 min; apos 5 min = 30 min');

(async () => {
  const agora = new Date('2026-09-26T23:00:00.000Z');
  const data = '2026-09-26';
  const pedidos = Array.from({length: 37}, (_, indice) => ({
    data, numeroSequencial: indice + 1,
    criadoEm: new Date(agora.getTime() - 30 * 60000 + indice * 1000).toISOString(),
    itens: [{nome:'X-Salada', quantidade:1}],
    atendimento: {tempoInternoMinutos:5},
  }));
  const config = {comandaEmPreparo:12, dataComandaEmPreparo:data};
  const fila = calcularFila(pedidos, agora, config);
  assert.equal(fila.pedidosConsiderados, 26);
  assert.ok(fila.filaMinutos >= 130);
  const estimativa = await estimarPrazo({
    itens:[{nome:'X-Frango',quantidade:1}], tipo:'entrega', distanciaKm:3,
    config, agora, pedidos,
  });
  assert.ok(estimativa.estimativaMinutos.minimo >= 170);
  assert.equal(estimativa.estimativaMinutos.maximo, 180);
  const lotada = await estimarPrazo({
    itens:[{nome:'X-Tudo (2 Kilo)',quantidade:5}], tipo:'entrega', distanciaKm:15,
    config, agora, pedidos,
  });
  assert.deepEqual(lotada.estimativaMinutos, {minimo:180,maximo:180});
  assert.equal(lotada.limiteAtingido, true);
  assert.equal(calcularFila(pedidos, agora, {...config,dataComandaEmPreparo:'2026-09-25'}).pedidosConsiderados, 37);
  console.log('OK - comanda 38, cozinha na 12: fila de 26 comandas; entrega até 3h');
})().catch(err => { console.error(err); process.exitCode = 1; });
