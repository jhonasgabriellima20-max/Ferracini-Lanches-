const assert = require('node:assert/strict');
const Module = require('node:module');
const storage = new Map();
const fakeStorage = {
  isStorageUnavailable: () => false,
  readJson: async path => ({value: storage.get(path) || null}),
  writeJson: async (path, value, options) => {
    if(storage.has(path) && !options.allowOverwrite){ const e=new Error('conflict'); e.status=409; throw e; }
    storage.set(path, structuredClone(value));
  },
  listBlobs: async ({prefix,limit}) => ({blobs:[...storage.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(pathname=>({pathname}))}),
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain){
  if(request.endsWith('postgres-storage')) return fakeStorage;
  if(request === './disponibilidade' && parent?.filename.endsWith('/api/pedidos.js')) return {readStoreStatus:async()=>({aberto:true})};
  return originalLoad.apply(this,arguments);
};
const pedidosHandler = require('../api/pedidos');
const painelHandler = require('../api/painel-pedidos');
process.env.ADMIN_PASSWORD = 'senha-teste';
function req(method,body={},headers={},url='/api/pedidos'){
  return {method,body,headers:{origin:'https://ferracinilanches.com.br','content-type':'application/json',...headers},url,query:{}};
}
async function call(handler, request){
  const response = {headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};
  await handler(request,response); return response;
}
(async()=>{
  const body={clientRequestId:'teste-comanda-1234567890',origem:'mesa',cliente:{nome:'Cliente Teste',telefone:'43999999999'},
    itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],
    atendimento:{tipo:'mesa',mesa:1},pagamento:{metodo:'pix'}};
  const retirada=await call(pedidosHandler,req('POST',{...body,clientRequestId:'teste-retirada-1234567890',origem:'site',atendimento:{tipo:'retirada'}}));
  assert.equal(retirada.statusCode,400);
  assert.equal([...storage.keys()].length,0);
  const created=await call(pedidosHandler,req('POST',body));
  assert.equal(created.statusCode,201);
  assert.equal(created.body.pedido.referencia,'1234567890');
  assert.equal([...storage.keys()].filter(k=>k.startsWith('pedidos/fila/')).length,0);
  assert.equal([...storage.keys()].filter(k=>k.startsWith('pedidos/reservas/')).length,0);
  const auth={'x-admin-password':'senha-teste'};
  const before=await call(painelHandler,req('GET',{},auth,'/api/painel-pedidos'));
  assert.equal(before.body.pedidos.length,0);
  assert.equal(before.body.aguardando.length,1);
  const confirmed=await call(painelHandler,req('POST',{id:created.body.pedido.id},auth,'/api/painel-pedidos'));
  assert.equal(confirmed.statusCode,200);
  assert.equal(confirmed.body.pedido.numero,'01');
  const after=await call(painelHandler,req('GET',{},auth,'/api/painel-pedidos'));
  assert.equal(after.body.pedidos.length,1);
  assert.equal(after.body.aguardando.length,0);
  const again=await call(painelHandler,req('POST',{id:created.body.pedido.id},auth,'/api/painel-pedidos'));
  assert.equal(again.body.pedido.numero,'01');
  assert.equal([...storage.keys()].filter(k=>k.startsWith('pedidos/reservas/')).length,1);
  console.log('OK - tentativa sem WhatsApp não entra na fila; confirmação gera uma única comanda');
})().catch(e=>{console.error(e);process.exitCode=1;});
