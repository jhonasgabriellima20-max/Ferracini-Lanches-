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
  await handler({method:handler===config?'GET':'POST',body,query:{},headers:{origin:'https://ferracinilanches.com.br','content-type':'application/json',host:'ferracinilanches.com.br','x-real-ip':body.clientRequestId||'fixture'}},response);
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
  for(const metodo of ['pix','dinheiro','debito','credito']){
    const before=queued().length;
    const body=draft('manual-restored-'+metodo,{metodo});
    const result=await call(pedidos,body);
    assert.equal(result.statusCode,201);
    assert.equal(result.body.pedido.status,'pendente');
    assert.equal(queued().length,before+1);
    const repeat=await call(pedidos,body);
    assert.equal(repeat.body.pedido.id,result.body.pedido.id);
    assert.equal(queued().length,before+1,'retries must not duplicate receipts');
  }
  const before=storage.size;
  const stale=await call(pedidos,draft('stale-online-browser',{metodo:'credito',fluxo:'mercadopago'}));
  assert.equal(stale.statusCode,400);
  assert.equal(storage.size,before,'stale online pages must refresh, never silently charge or enqueue');
  process.env.MP_CARD_CHECKOUT_ENABLED='true';
  for(const metodo of ['credito','debito']){
    const before=storage.size;
    const blocked=await call(pedidos,draft('enabled-without-keys-'+metodo,{metodo}));
    assert.equal(blocked.statusCode,503,'online required with incomplete credentials fails closed');
    assert.equal(storage.size,before);
  }
  for(const metodo of ['dinheiro','cartao']){
    const before=storage.size;
    const blocked=await call(pedidos,draft('manual-method-rejected-'+metodo,{metodo}));
    assert.equal(blocked.statusCode,400,'manual pickup payment is no longer offered');
    assert.equal(storage.size,before);
  }
  for(const pagamento of [undefined,{metodo:'dinheiro'},{metodo:'credito'}]){
    const mesaBody=draft('mesa-local-'+(pagamento?.metodo||'no-local'),pagamento,{tipo:'mesa',mesa:4});
    if(!pagamento)delete mesaBody.pagamento;
    const mesa=await call(pedidos,mesaBody);
    assert.equal(mesa.statusCode,201,'mesa retains payment at restaurant without MP configuration');
    assert.equal(mesa.body.pedido.status,'pendente');
  }
  const initialQueued=queued().length;
  assert.equal(initialQueued,7);
  assert.equal(queued().filter(([,order])=>order.atendimento.tipo==='mesa').length,3);
  process.env.MP_ACCESS_TOKEN='TEST-token';
  process.env.MP_PUBLIC_KEY='TEST-public';
  process.env.MP_WEBHOOK_SECRET='test-webhook-secret';
  assert.equal(mp.enabled(),true);
  for(const fluxo of [undefined,'presencial','mercadopago']){
    const pending=await call(pedidos,draft('online-required-'+String(fluxo),{metodo:'credito',...(fluxo?{fluxo}:{})}));
    assert.equal(pending.statusCode,201);
    assert.equal(pending.body.pedido.status,'aguardando_pagamento');
    assert.equal(pending.body.pagamentoObrigatorio,true);
    assert.equal(pending.body.impressaoAtiva,false);
    const stored=[...storage.values()].find(value=>value.id===pending.body.pedido.id&&value.atendimento);
    assert.equal(stored.pagamento.fluxo,'mercadopago','server ignores a missing or modified browser flow tag');
    assert.equal(stored.pagamento.verified,false);
    assert.equal(queued().length,initialQueued,'no credit reservation reaches the kitchen before approval');
  }
  const mesaOnline=await call(pedidos,draft('mesa-cannot-opt-in-online',{metodo:'credito',fluxo:'mercadopago'},{tipo:'mesa',mesa:4}));
  assert.equal(mesaOnline.statusCode,400);
  console.log('OK: entrega/retirada só online; configuração inválida bloqueia; mesa segue no local');
})().catch(error=>{console.error(error);process.exitCode=1;});
