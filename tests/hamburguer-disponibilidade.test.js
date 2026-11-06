const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const storagePath = require.resolve('../lib/postgres-storage');
let saved = {ingredientes:{hamburguer:false}};
require.cache[storagePath] = {id:storagePath,filename:storagePath,loaded:true,exports:{
  readJson:async()=>({value:saved,mode:'test'}),
  writeJson:async(_,value)=>{saved=structuredClone(value);return {mode:'test'};},isStorageUnavailable:()=>false
}};
process.env.ADMIN_PASSWORD='test-only';
const handler=require('../api/disponibilidade');
async function call(method,body){
 let code=200,data;
 await handler({method,body,headers:{'content-type':'application/json','x-admin-password':'test-only'}},
  {setHeader(){},status(n){code=n;return this},json(x){data=x;return this}});
 assert.equal(code,200);return data;
}
test('migra bloqueio antigo e persiste cada tipo de forma independente',async()=>{
 let state=await call('GET');
 assert.equal(state.ingredientes.hamburguer_artesanal,false);
 assert.equal(state.ingredientes.hamburguer_industrializado,false);
 for(const [industrializado,artesanal] of [[true,false],[false,true],[false,false],[true,true]]){
  state=await call('POST',{...state,ingredientes:{...state.ingredientes,hamburguer_industrializado:industrializado,hamburguer_artesanal:artesanal}});
  assert.equal(state.ingredientes.hamburguer,industrializado||artesanal);
  const catalog=await handler.readOrderCatalog();
  assert.deepEqual(catalog.hamburgueres,{industrializado,artesanal});
  const source=fs.readFileSync('api/pedidos.js','utf8');
  const ctx={CATALOGO:catalog};vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function texto('),source.indexOf('function taxaServicoCentavosPorDistancia('))+source.slice(source.indexOf('function validarItem('),source.indexOf('function validarPayload(')),ctx);
  for(const tipo of ['industrializado','artesanal']){
   const result=ctx.validarItem({nome:'Simples Burguer',quantidade:1,tipoHamburguer:tipo,precoUnitarioCentavos:1500+(tipo==='artesanal'?900:0)});
   assert.equal(Boolean(result),catalog.hamburgueres[tipo]);
  }
 }
});
test('site e mesa mantêm o lanche com um tipo e removem do carrinho o tipo esgotado',()=>{
 for(const page of ['index.html','mesa.html']){
  const source=fs.readFileSync(page,'utf8');
  const ctx={disponibilidade:{ingredientes:{hamburguer_industrializado:false,hamburguer_artesanal:true},produtos:{}},CONFIG:{produtos:[{nome:'Teste',preco:20,ingredientes:['hamburguer']},{nome:'Dog',preco:12,ingredientes:[]}]},cart:{Teste:{tipoHamburguer:'industrializado',preco:20}},updateCartBar(){}};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function temHamburguer('),source.indexOf('async function carregarDisponibilidade(')),ctx);
  assert.equal(ctx.produtoDisponivel(ctx.CONFIG.produtos[0]),true);
  assert.equal(ctx.removerItensIndisponiveisDoCarrinho().removeu,true);
  assert.equal(ctx.cart.Teste,undefined);
  ctx.disponibilidade.ingredientes.hamburguer_artesanal=false;
  assert.equal(ctx.produtoDisponivel(ctx.CONFIG.produtos[0]),false);
  assert.equal(ctx.produtoDisponivel(ctx.CONFIG.produtos[1]),true);
 }
});
