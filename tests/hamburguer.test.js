const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('api/pedidos.js','utf8');
const context = { CATALOGO: require('../api/catalogo.json') };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function texto('),source.indexOf('function taxaServicoCentavosPorDistancia(')) + source.slice(source.indexOf('function validarItem('),source.indexOf('function validarPayload(')),context);
for(const [nome,p] of Object.entries(context.CATALOGO.produtos).filter(([,p])=>p.temHamburguer)){
 const item={nome,quantidade:2,precoUnitarioCentavos:p.precoCentavos,adicionais:[]};
 assert.equal(context.validarItem(item),null);
 for(const tipo of ['industrializado','artesanal']){
  const price=p.precoCentavos+(tipo==='artesanal'?900:0);
  const result=context.validarItem({...item,tipoHamburguer:tipo,precoUnitarioCentavos:price});
  assert.equal(result.precoUnitarioCentavos,price);
  assert.equal(result.nome,`${nome} — ${tipo}`);
 }
 assert.equal(context.validarItem({...item,tipoHamburguer:'artesanal'}),null);
 assert.equal(context.validarItem({...item,tipoHamburguer:'invalido'}),null);
}
assert.equal(context.validarItem({nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:2100,tipoHamburguer:'artesanal'}),null);
const {orderCatalog}=require('../lib/custom-catalog');
const updated=orderCatalog([{nome:'Novo X',categoria:'x',precoCentavos:2000,ingredientes:['hamburguer']}],{'Simples Burguer':1800});
assert.equal(updated.produtos['Novo X'].temHamburguer,true);
assert.equal(context.validarItem({nome:'Simples Burguer',quantidade:1,precoUnitarioCentavos:2700,tipoHamburguer:'artesanal'},updated).precoUnitarioCentavos,2700);
console.log('OK: escolha obrigatória, sete lanches, +R$9, preços personalizados e identificação na comanda.');

const custom=orderCatalog([{nome:'X-Bacon normal',categoria:'x',precoCentavos:3000,ingredientes:[]},{nome:'PROMOÇÂO 4 X-SALADA 1 GUARATUBA .',categoria:'x',precoCentavos:8000,ingredientes:['hamburguer']}]);
assert.equal(context.validarItem({nome:'X-Bacon normal',quantidade:1,precoUnitarioCentavos:3900,tipoHamburguer:'artesanal'},custom).precoUnitarioCentavos,3900);
assert.equal(context.validarItem({nome:'PROMOÇÂO 4 X-SALADA 1 GUARATUBA .',quantidade:1,precoUnitarioCentavos:11600,tipoHamburguer:'artesanal'},custom).precoUnitarioCentavos,11600);
