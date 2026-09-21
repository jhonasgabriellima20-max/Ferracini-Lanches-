const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {addItem,orderCatalog} = require('../lib/custom-catalog');
const storagePath = require.resolve('../lib/blob-storage');
let saved;
require.cache[storagePath] = {id:storagePath,filename:storagePath,loaded:true,exports:{
  readJson:async()=>({value:saved,mode:'test'}),
  writeJson:async(_,value)=>{saved=structuredClone(value);return {mode:'test'};},isAuthError:()=>false
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
