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
  const bad={
    id:'123',status:'approved',currency_id:'BRL',transaction_amount:15,
    external_reference:r.body.pedido.id,payment_type_id:'credit_card'
  };
  assert.equal(mp.validPayment(bad,{id:r.body.pedido.id,totalCentavos:1500,pagamento:{metodo:'credito'}}),true);
  assert.equal(mp.validPayment({...bad,transaction_amount:1},{id:r.body.pedido.id,totalCentavos:1500,pagamento:{metodo:'credito'}}),false);
  assert.equal(mp.validPayment({...bad,payment_type_id:'debit_card'},{id:r.body.pedido.id,totalCentavos:1500,pagamento:{metodo:'credito'}}),false);
  assert.equal(mp.validPayment({...bad,status:'pending'},{id:r.body.pedido.id,totalCentavos:1500,pagamento:{metodo:'credito'}}),false);
  assert.equal((await mp.reconcile({...bad,status:'pending'})).status,'aguardando_pagamento');
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,0);
  const confirmed=await mp.reconcile(bad);
  assert.equal(confirmed.status,'approved');
  assert.equal(confirmed.pedido.numero,'01');
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,1);
  const again=await mp.reconcile(bad);
  assert.equal(again.pedido.numero,'01');
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,1);
  console.log('OK: comanda liberada somente após cartão aprovado e sem duplicidade');
})().catch(e=>{console.error(e);process.exitCode=1;});
