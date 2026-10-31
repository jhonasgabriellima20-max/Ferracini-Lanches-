const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {addItem,orderCatalog} = require('../lib/custom-catalog');
const storagePath = require.resolve('../lib/postgres-storage');
let saved;
require.cache[storagePath] = {id:storagePath,filename:storagePath,loaded:true,exports:{
  readJson:async()=>({value:saved,mode:'test'}),
  writeJson:async(_,value)=>{saved=structuredClone(value);return {mode:'test'};},isStorageUnavailable:()=>false
}};
process.env.ADMIN_PASSWORD='test-only';
const handler=require('../api/disponibilidade');
async function call(method,body,password='test-only'){
 let code=200, data;
 const res={setHeader(){},status(n){code=n;return this},json(x){data=x;return this}};
 await handler({method,body,headers:{'content-type':'application/json','x-admin-password':password}},res);
 return {code,data};
}
test('cadastro autenticado, persistência, duplicidade, versão e preservação',async()=>{
 let r=await call('GET'); assert.equal(r.code,200);
 r=await call('POST',{...r.data,novoItem:{nome:'Suco novo',categoria:'bebidas',precoCentavos:950}});
 assert.equal(r.code,200); assert.equal(r.data.itensNovos.length,1);
 const version=r.data.updatedAt;
 assert.equal((await call('POST',{...r.data,novoItem:{nome:'suco novo',categoria:'bebidas',precoCentavos:950}})).code,409);
 assert.equal((await call('POST',{updatedAt:null})).code,409);
 assert.equal((await call('POST',{updatedAt:version},'bad')).code,401);
 r=await call('POST',{updatedAt:version,ingredientes:{frango:false},produtos:{'Suco novo':false}});
 assert.equal(r.code,200); assert.equal(r.data.itensNovos.length,1);
 r=await call('GET');assert.equal(r.data.produtos['Suco novo'],false);assert.equal(r.data.ingredientes.frango,false);
 assert.equal(r.data.catalogo.produtos.find(i=>i.nome==='Suco novo').categoria,'Bebidas');
 assert.equal((await handler.readOrderCatalog()).produtos['Suco novo'].precoCentavos,950);
});
test('preços e conteúdo inválidos são recusados',()=>{
 for(const raw of [{nome:'<script>'},{precoCentavos:NaN},{precoCentavos:-1},{precoCentavos:1.5},{categoria:'invalid'},{ingredientes:['inventado']},{nome:'constructor'}]) assert.throws(()=>addItem([],{nome:'Teste',categoria:'x',precoCentavos:2000,...raw},['frango']));
 assert.throws(()=>addItem([],{nome:'X-Burguer',categoria:'x',precoCentavos:2000},[]));
});
test('novo lanche, adicional e bebida validam preços no servidor sem aceitar adulterações',()=>{
 let items=[];
 for(const [nome,categoria,precoCentavos] of [['X Novo','x',2800],['Cheddar novo','adicional',550],['Suco novo','bebidas',950]]) items=addItem(items,{nome,categoria,precoCentavos},[]);
 const catalog=orderCatalog(items);
 const file=require.resolve('../api/pedidos');
 const ctx={require:createRequire(file),module:{exports:{}},process,console,Buffer,setTimeout,clearTimeout};
 vm.createContext(ctx); vm.runInContext(fs.readFileSync(file,'utf8')+'\nmodule.exports.validarItem=validarItem;',ctx);
 const validate=ctx.module.exports.validarItem;
 const item={nome:'X Novo',quantidade:2,precoUnitarioCentavos:2800,adicionais:[{nome:'Cheddar novo',precoCentavos:550}]};
 assert.ok(validate(item,catalog)); assert.equal(validate({...item,precoUnitarioCentavos:1},catalog),null);
 assert.equal(validate({...item,adicionais:[{nome:'Cheddar novo',precoCentavos:1}]},catalog),null);
 assert.equal(validate({nome:'Suco novo',quantidade:1,precoUnitarioCentavos:950,adicionais:item.adicionais},catalog),null);
 assert.ok(validate({nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200},catalog));
});
test('site e mesa integram itens novos, adicionais, bloqueios e escape HTML',()=>{
 for(const page of ['index.html','mesa.html']){
  const html=fs.readFileSync(page,'utf8');const script=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const start=script.indexOf('const ADICIONAIS_PADRAO');const end=script.indexOf('function removerItensIndisponiveisDoCarrinho');
  const context={document:{getElementById:()=>({})},console};vm.createContext(context);
  vm.runInContext(script.slice(start,end)+`\nthis.testApi={aplicarItensNovos,produtoDisponivel,adicionalDisponivel,CONFIG,ADICIONAIS_PADRAO,disponibilidade,escapeHTML};`,context);
  const api=context.testApi;
  const baseCount=Object.keys(require('../api/catalogo.json').produtos).length;
  assert.equal(api.CONFIG.produtos.length,baseCount);
  api.aplicarItensNovos([{id:'novo_a',nome:'Creme novo',categoria:'adicional',precoCentavos:550},{id:'novo_x',nome:'X "Novo"',categoria:'x',precoCentavos:2900,descricao:'Queijo & pão',ingredientes:['frango']},{id:'novo_b',nome:'Suco novo',categoria:'bebidas',precoCentavos:900}]);
  assert.equal(api.CONFIG.produtos.length,baseCount+2);
  const lanche=api.CONFIG.produtos.find(i=>i.nome==='X "Novo"');
  assert.equal(lanche.adicionais.at(-1).preco,5.5);assert.equal(api.CONFIG.produtos[0].adicionais.at(-1).nome,'Creme novo');
  assert.equal(api.CONFIG.produtos.at(-1).adicionais.length,0);
  api.disponibilidade.ingredientes.frango=false;assert.equal(api.produtoDisponivel(lanche),false);
  api.disponibilidade.ingredientes.novo_a=false;assert.equal(api.adicionalDisponivel(lanche.adicionais.at(-1)),false);
  assert.equal(api.escapeHTML('X "Novo"'),'X &quot;Novo&quot;');
  api.aplicarItensNovos([]);assert.equal(api.CONFIG.produtos.length,baseCount);assert.equal(api.ADICIONAIS_PADRAO.length,17);
 }
});

// Uma unica comanda preserva os produtos diferentes e a categoria confiavel do catalogo.
test('validacao conjunta de marmitex, lanche, doce e sobremesa na fila unica',()=>{
  let items=[];
  for(const [nome,categoria,precoCentavos] of [
    ['Brigadeiro','doces',600],
    ['Pudim','sobremesas',1100],
  ]) items=addItem(items,{nome,categoria,precoCentavos},[]);
  const catalog=orderCatalog(items,{'Marmitex Mini':1900,'Marmitex Média':2600});
  const file=require.resolve('../api/pedidos');
  const ctx={require:createRequire(file),module:{exports:{}},process,console,Buffer,setTimeout,clearTimeout};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file,'utf8')+'\nmodule.exports.validarItem=validarItem;',ctx);
  const validar=ctx.module.exports.validarItem;
  const carrinho=[
    {nome:'Marmitex Mini',quantidade:1,precoUnitarioCentavos:1900},
    {nome:'Marmitex Média',quantidade:1,precoUnitarioCentavos:2600},
    {nome:'X-Salada',quantidade:2,precoUnitarioCentavos:2500,tipoHamburguer:'industrializado'},
    {nome:'Brigadeiro',categoria:'x',quantidade:2,precoUnitarioCentavos:600},
    {nome:'Pudim',categoria:'x',quantidade:1,precoUnitarioCentavos:1100},
  ];
  const itens=carrinho.map(i=>validar({...i,observacao:'Teste',adicionais:[]},catalog));
  assert.ok(itens.every(Boolean));
  assert.equal(itens.length,5);
  assert.equal(itens[3].categoria,'doces');
  assert.equal(itens[4].categoria,'sobremesas');
  assert.equal(itens.reduce((s,i)=>s+i.precoUnitarioCentavos*i.quantidade,0),11800);
  assert.equal(validar({...carrinho[2],tipoHamburguer:undefined,adicionais:[]},catalog),null,'hambúrguer exige a escolha de tipo do main atual');
  const artesanal=validar({...carrinho[2],tipoHamburguer:'artesanal',precoUnitarioCentavos:3400,adicionais:[]},catalog);
  assert.equal(artesanal.precoUnitarioCentavos,3400,'acréscimo artesanal de R$ 9 permanece no servidor');
  assert.equal(validar({...carrinho[2],tipoHamburguer:'artesanal',adicionais:[]},catalog),null,'não aceita artesanal pelo valor industrializado');
  assert.equal(validar({nome:'Pudim',quantidade:1,precoUnitarioCentavos:5},catalog),null);
});
