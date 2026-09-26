const assert = require('node:assert/strict');
const {
  MINUTOS_POR_LANCHE,
  contarLanches,
  calcularTempoInternoLanches,
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
