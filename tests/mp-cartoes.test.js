const assert=require('node:assert/strict');
const Module=require('node:module');
const storage=new Map();
const fakeStorage={
  isStorageUnavailable:()=>false,
  readJson:async p=>({value:storage.get(p)||null}),
  writeJson:async(p,value,opt)=>{
    if(storage.has(p)&&!opt.allowOverwrite) throw Object.assign(new Error('conflict'),{status:409});
    storage.set(p,structuredClone(value));
  },
  listBlobs:async()=>({blobs:[]}),
};
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){
  if(request.endsWith('postgres-storage'))return fakeStorage;
  if(request==='./disponibilidade' && parent?.filename.endsWith('/api/pedidos.js'))
    return {
      readStoreStatus:async()=>({aberto:true}),
      readServiceAvailability:async()=>({retirada:true,entrega:true}),
      readPrepConfig:async()=>({}),
      readOrderCatalog:async()=>require('../api/catalogo.json')
    };
  return originalLoad.apply(this,arguments);
};
process.env.MP_CARD_CHECKOUT_ENABLED='true';
process.env.MP_PUBLIC_KEY='TEST-public';
process.env.MP_ACCESS_TOKEN='TEST-token';
process.env.MP_WEBHOOK_SECRET='TEST-secret';
const handler=require('../api/pedidos');
const mp=require('../lib/mp-checkout');
async function call(body){
  const res={
    setHeader(){},status(n){this.statusCode=n;return this;},
    json(x){this.body=x;return this;}
  };
  await handler({
    method:'POST',
    body,query:{},
    headers:{origin:'https://ferracinilanches.com.br','content-type':'application/json'}
  },res);
  return res;
}
(async()=>{
  const order={
    clientRequestId:'teste-cartao-1234567',
    origem:'site',
    cliente:{nome:'Cliente Teste',telefone:'43999999999'},
    itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],
    atendimento:{tipo:'retirada'},
    pagamento:{metodo:'credito'}
  };
  const r=await call(order);
  assert.equal(r.statusCode,201);
  assert.equal(r.body.pedido.status,'aguardando_pagamento');
  assert.equal(r.body.pedido.totalCentavos,1500);
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,0);
  const d=await call({...order,clientRequestId:'teste-cartao-dinheiro',pagamento:{metodo:'dinheiro'}});
  assert.equal(d.statusCode,400);
  const approved={
    id:'ORD01JS2V6CM8KJ0EC4H502TGK1WP',type:'online',processing_mode:'automatic',
    status:'processed',status_detail:'accredited',
    external_reference:r.body.pedido.id,total_amount:'15.00',total_paid_amount:'15.00',
    transactions:{payments:[{
      id:'PAY01JS2V6CM8KJ0EC4H504R7YE34',amount:'15.00',paid_amount:'15.00',
      status:'processed',status_detail:'accredited',
      payment_method:{id:'visa',type:'credit_card',installments:1}
    }]}
  };
  const local={id:r.body.pedido.id,totalCentavos:1500,pagamento:{metodo:'credito'}};
  assert.equal(mp.moneyCents('15.00'),1500);
  assert.equal(mp.validOrder(approved,local),true);
  assert.equal(mp.validOrder({...approved,total_amount:'1.00'},local),false);
  assert.equal(mp.validOrder({...approved,total_paid_amount:'1.00'},local),false);
  assert.equal(mp.validOrder({...approved,status:'processing'},local),false);
  assert.equal(mp.validOrder({...approved,external_reference:'outro'},local),false);
  assert.equal(mp.validOrder({...approved,transactions:{payments:[{...approved.transactions.payments[0],payment_method:{type:'debit_card'}}]}},local),false);
  assert.equal(mp.validOrder({...approved,transactions:{payments:[{...approved.transactions.payments[0],paid_amount:'0.01'}]}},local),false);
  assert.equal((await mp.reconcile({...approved,status:'processing'})).status,'pending');
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,0);
  const confirmed=await mp.reconcile(approved);
  assert.equal(confirmed.status,'approved');
  assert.equal(confirmed.pedido.numero,'01');
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,1);
  const again=await mp.reconcile(approved);
  assert.equal(again.pedido.numero,'01');
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,1);
  console.log('OK: comanda liberada somente após cartão aprovado e sem duplicidade');
})().catch(e=>{console.error(e);process.exitCode=1;});
