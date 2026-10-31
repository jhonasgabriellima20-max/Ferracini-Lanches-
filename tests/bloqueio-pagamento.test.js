const assert = require('node:assert/strict');
const Module = require('node:module');
const storage = new Map();
const originalLoad = Module._load;
Module._load = function(request,parent) {
  if(request.endsWith('postgres-storage')) return {
    isStorageUnavailable:()=>false,
    readJson:async p=>({value:structuredClone(storage.get(p)||null)}),
    writeJson:async (p,value,options)=>{
      if(storage.has(p)&&!options.allowOverwrite) throw Object.assign(new Error('conflict'),{status:409});
      storage.set(p,structuredClone(value));
    },
    listBlobs:async()=>({blobs:[]}),
  };
  if(request==='./disponibilidade' && parent?.filename.endsWith('/api/pedidos.js')) return {
    readStoreStatus:async()=>({aberto:true}),readServiceAvailability:async()=>({retirada:true,entrega:true}),
    readPrepConfig:async()=>({}),readOrderCatalog:async()=>require('../api/catalogo.json'),
  };
  return originalLoad.apply(this,arguments);
};
process.env.VERCEL_ENV='production';
delete process.env.MP_CARD_CHECKOUT_ENABLED;
delete process.env.MP_ACCESS_TOKEN;
delete process.env.MP_PUBLIC_KEY;
delete process.env.MP_WEBHOOK_SECRET;
const pedidos=require('../api/pedidos');
const config=require('../api/mp-config');
const payment=require('../api/mp-pagamento');
const mp=require('../lib/mp-checkout');
async function call(handler,body={}) {
  const response={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(data){this.body=data;return this;}};
  await handler({method:handler===config?'GET':'POST',body,query:{},headers:{origin:'https://ferracinilanches.com.br','content-type':'application/json',host:'ferracinilanches.com.br'}},response);
  return response;
}
const draft=(id,pagamento={metodo:'dinheiro'},atendimento={tipo:'retirada'})=>({
  clientRequestId:id,cliente:{nome:'Cliente Teste',telefone:'43999999999'},
  itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],
  atendimento,pagamento,
});
const queued=()=>[...storage.entries()].filter(([p])=>p.startsWith('pedidos/fila/'));
(async()=>{
  assert.equal(mp.enabled(),false);
  assert.equal((await call(config)).body.enabled,false);
  assert.equal((await call(payment)).statusCode,503,'disabled endpoint cannot create a charge');
  const legacy=await call(pedidos,draft('legacy-checkout-with-flag-off'));
  assert.equal(legacy.statusCode,201,'preparing disabled integration preserves current order flow');
  assert.equal(legacy.body.pedido.status,'pendente');
  assert.equal(queued().length,1);
  const optedOut=await call(pedidos,draft('online-request-flag-off',{metodo:'credito',fluxo:'mercadopago'}));
  assert.equal(optedOut.statusCode,503,'a requested online charge never silently falls back to presencial');
  assert.equal(queued().length,1);

  process.env.MP_CARD_CHECKOUT_ENABLED='true';
  for(const metodo of ['credito','debito','dinheiro','pix']){
    const presencial=await call(pedidos,draft('presencial-enabled-without-keys-'+metodo,{metodo}));
    assert.equal(presencial.statusCode,201,metodo+' remains available without online opt-in');
    assert.equal(presencial.body.pedido.status,'pendente');
  }
  assert.equal(queued().length,5);
  assert.ok(queued().every(([,order])=>order.pagamento.fluxo!=='mercadopago'),'the server cannot convert presencial to online implicitly');
  const blocked=await call(pedidos,draft('enabled-without-credentials',{metodo:'credito',fluxo:'mercadopago'}));
  assert.equal(blocked.statusCode,503,'explicit online opt-in with incomplete credentials fails closed');
  assert.equal(queued().length,5,'missing credentials never release an online order');
  const mesaPayload=draft('mesa-with-online-enabled',undefined,{tipo:'mesa',mesa:4});
  delete mesaPayload.pagamento;
  const mesa=await call(pedidos,mesaPayload);
  assert.equal(mesa.statusCode,201,'mesa retains payment at the restaurant');
  assert.equal(queued().length,6);
  assert.equal(queued().find(([,order])=>order.id===mesa.body.pedido.id)[1].pagamento.metodo,'no_local');

  process.env.MP_ACCESS_TOKEN='TEST-token';
  process.env.MP_PUBLIC_KEY='TEST-public';
  process.env.MP_WEBHOOK_SECRET='test-webhook-secret';
  assert.equal(mp.enabled(),true);
  const pending=await call(pedidos,draft('online-opt-in-configured',{metodo:'credito',fluxo:'mercadopago'}));
  assert.equal(pending.statusCode,201);
  assert.equal(pending.body.pedido.status,'aguardando_pagamento');
  assert.equal(queued().length,6,'an opted-in online order remains outside the kitchen before approval');
  const configuredPresencial=await call(pedidos,draft('presencial-configured',{metodo:'credito'}));
  assert.equal(configuredPresencial.statusCode,201);
  assert.equal(queued().length,7,'configured online capability does not remove card payment presencial');
  const mesaOnline=await call(pedidos,draft('mesa-cannot-opt-in-online',{metodo:'credito',fluxo:'mercadopago'},{tipo:'mesa',mesa:4}));
  assert.equal(mesaOnline.statusCode,400,'mesa cannot be charged online by changing the browser payload');
  const pixOnline=await call(pedidos,draft('pix-cannot-opt-in-online',{metodo:'pix',fluxo:'mercadopago'}));
  assert.equal(pixOnline.statusCode,400,'this card integration does not introduce Pix automatic');
  assert.equal(queued().length,7);
  console.log('OK: presencial e mesa preservados; só opt-in online exige integração e aguarda aprovação');
})().catch(error=>{console.error(error);process.exitCode=1;});
