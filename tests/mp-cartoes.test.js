const assert = require('node:assert/strict');
const Module = require('node:module');
const storage = new Map();
const fakeStorage = {
  isStorageUnavailable: () => false,
  readJson: async pathname => ({value: structuredClone(storage.get(pathname) || null)}),
  writeJson: async (pathname, value, options) => {
    if(storage.has(pathname) && !options.allowOverwrite)
      throw Object.assign(new Error('conflict'), {status:409});
    storage.set(pathname, structuredClone(value));
  },
  listBlobs: async ({prefix,limit}) => ({blobs:[...storage.keys()].filter(p => p.startsWith(prefix)).slice(0,limit).map(pathname => ({pathname}))}),
};
const load = Module._load;
Module._load = function(request,parent) {
  if(request.endsWith('postgres-storage')) return fakeStorage;
  if(request === './disponibilidade' && parent?.filename.endsWith('/api/pedidos.js')) return {
    readStoreStatus: async () => ({aberto:true}),
    readServiceAvailability: async () => ({retirada:true,entrega:true}),
    readPrepConfig: async () => ({}),
    readOrderCatalog: async () => require('../api/catalogo.json'),
  };
  return load.apply(this,arguments);
};
process.env.VERCEL_ENV = 'preview';
process.env.MP_CARD_CHECKOUT_ENABLED = 'true';
process.env.MP_PUBLIC_KEY = 'TEST-public';
process.env.MP_ACCESS_TOKEN = 'TEST-token';
const pedidos = require('../api/pedidos');
const mp = require('../lib/mp-checkout');
const queued = () => [...storage.entries()].filter(([p]) => p.startsWith('mp-preview/pedidos/fila/'));
async function call(body) {
  const response = {statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(data){this.body=data;return this;}};
  await pedidos({method:'POST',body,query:{},headers:{origin:'https://ferracinilanches.com.br','content-type':'application/json'}},response);
  return response;
}
const draft = {
  clientRequestId:'teste-cartao-1234567',origem:'site',cliente:{nome:'Cliente Teste',telefone:'43999999999'},
  itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],
  atendimento:{tipo:'retirada'},pagamento:{metodo:'credito',fluxo:'mercadopago'},
};
function providerOrder(id) {
  return {
    id:'ORD01JS2V6CM8KJ0EC4H502TGK1WP',type:'online',processing_mode:'automatic',
    status:'processed',status_detail:'accredited',external_reference:id,total_amount:'15.00',total_paid_amount:'15.00',
    transactions:{payments:[{id:'PAY01JS2V6CM8KJ0EC4H504R7YE34',amount:'15.00',paid_amount:'15.00',
      status:'processed',status_detail:'accredited',payment_method:{id:'visa',type:'credit_card',installments:1}}]},
  };
}
(async () => {
  const first = await call(draft);
  assert.equal(first.statusCode,201);
  assert.equal(first.body.pedido.status,'aguardando_pagamento');
  assert.equal(first.body.pedido.totalCentavos,1500,'server includes the service fee');
  assert.equal(queued().length,0,'unpaid reservation cannot reach the kitchen');
  const duplicate = await call(draft);
  assert.equal(duplicate.body.pedido.id,first.body.pedido.id);
  assert.equal(duplicate.body.duplicado,true);
  assert.equal(queued().length,0);
  const id = first.body.pedido.id;
  const approval = providerOrder(id);
  const found = await mp.findOrder(id);
  // Provider identity captured when the charge is created; fixture models that persisted binding.
  found.order.pagamento.mpOrderId=approval.id;
  await fakeStorage.writeJson(found.path,found.order,{allowOverwrite:true});
  const local = {id,totalCentavos:1500,pagamento:{metodo:'credito',fluxo:'mercadopago',mpOrderId:approval.id}};
  assert.equal(mp.validOrder(approval,local),true);
  for(const amount of ['15.001','-15.00','NaN','1e2',' 15.00','0x10']) assert.equal(mp.moneyCents(amount),null);
  assert.equal(mp.moneyCents('15.01'),1501);
  for(const modified of [
    {...approval,total_amount:'1.00'}, {...approval,total_paid_amount:'1.00'},
    {...approval,status:'processing'}, {...approval,external_reference:'outro'},
    {...approval,id:'ORDdifferent123456789'}, {...approval,currency:'USD'}, {...approval,currency_id:'USD'},
    {...approval,transactions:{payments:[]}},
    {...approval,transactions:{payments:[...approval.transactions.payments,...approval.transactions.payments]}},
    {...approval,transactions:{payments:[{...approval.transactions.payments[0],paid_amount:'0.01'}]}},
    {...approval,transactions:{payments:[{...approval.transactions.payments[0],payment_method:{type:'debit_card'}}]}},
  ]) {
    assert.equal(mp.validOrder(modified,local),false,'a mismatched provider order is not trusted');
    const result = await mp.reconcile(modified);
    assert.notEqual(result?.status,'approved');
    assert.equal(queued().length,0);
  }
  const challenge={...approval,status:'action_required',transactions:{payments:[{
    ...approval.transactions.payments[0],status:'action_required',status_detail:'pending_challenge',
    payment_method:{...approval.transactions.payments[0].payment_method,transaction_security:{url:'https://bank.example.test/3ds/challenge'}}
  }]}};
  const challenged=await mp.reconcile(challenge);
  assert.equal(challenged.status,'action_required');
  assert.equal(challenged.requiresBankAuthentication,true);
  assert.equal(challenged.actionUrl,'https://bank.example.test/3ds/challenge');
  assert.equal(queued().length,0,'bank authentication challenge cannot release a receipt');
  const unsafeChallenge=structuredClone(challenge);
  unsafeChallenge.transactions.payments[0].payment_method.transaction_security.url='javascript:alert(1)';
  assert.equal((await mp.reconcile(unsafeChallenge)).actionUrl,undefined);
  await assert.rejects(() => pedidos.confirmarPedido(id), /pagamento|aprovad/i);
  assert.equal(queued().length,0,'calling queue release directly cannot bypass approval');
  const confirmed = await mp.reconcile(approval);
  assert.equal(confirmed.status,'approved');
  assert.equal(confirmed.pedido.numero,'01');
  assert.equal(queued().length,1);
  await Promise.all([mp.reconcile(approval),mp.reconcile(approval)]);
  assert.equal(queued().length,1,'duplicate polling/webhook approval has one queue record');
  assert.equal(queued()[0][1].pagamento.status,'approved');
  assert.equal([...storage.keys()].filter(p => p.startsWith('pedidos/fila/')).length,0,'Preview never uses the production queue');
  const again = await call(draft);
  assert.equal(again.body.pedido.id,id);
  assert.equal(again.body.pedido.numero,'01');
  assert.equal(queued().length,1);
  for(const partialRefund of [
    {...approval,status_detail:'partially_refunded'},
    {...approval,transactions:{payments:[{...approval.transactions.payments[0],refunded_amount:'1.00'}]}},
    {...approval,transactions:{...approval.transactions,refunds:[{status:'processed'}]}},
  ]) {
    assert.equal(mp.rejected(partialRefund),true);
    assert.equal(mp.validOrder(partialRefund,local),false,'a partial refund is never a valid full approval');
  }
  const staleApprovedSource=await mp.findOrder(id);
  const staleApprovedQueue=structuredClone(queued()[0]);
  const reversed = await mp.reconcile({...approval,transactions:{payments:[{...approval.transactions.payments[0],refunded_amount:'1.00'}]}});
  assert.equal(reversed.status,'rejected');
  assert.equal(queued()[0][1].status,'bloqueado_pagamento','a reversal blocks a receipt not yet claimed');
  assert.equal(queued()[0][1].pagamento.verified,false);
  assert.equal((await mp.reconcile(approval)).status,'rejected','a stale approval cannot undo a recorded reversal');
  assert.equal(queued()[0][1].status,'bloqueado_pagamento');
  const blockPath=mp.storageNamespace()+'pedidos/pagamento-bloqueado/'+id+'.json';
  assert.ok(storage.has(blockPath),'reversal writes a permanent insert-only block marker');
  const blockedSource=await mp.findOrder(id);
  const blockedQueue=structuredClone(queued()[0]);
  // Simulate stale worker writes after a reversal: mutable records may regress,
  // but the independent permanent marker must still block queue release.
  await fakeStorage.writeJson(staleApprovedSource.path,staleApprovedSource.order,{allowOverwrite:true});
  await fakeStorage.writeJson(staleApprovedQueue[0],staleApprovedQueue[1],{allowOverwrite:true});
  assert.equal((await mp.reconcile(approval)).status,'rejected','stale approved source cannot bypass permanent reversal marker');
  await assert.rejects(()=>pedidos.confirmarPedido(id),/pagamento|aprovad|bloquead/i);
  assert.ok(storage.has(blockPath));
  await fakeStorage.writeJson(blockedSource.path,blockedSource.order,{allowOverwrite:true});
  await fakeStorage.writeJson(blockedQueue[0],blockedQueue[1],{allowOverwrite:true});
  // The same app order must always use the same provider idempotency key.
  assert.equal(mp.requestId(id),mp.requestId(id));
  assert.notEqual(mp.requestId(id),mp.requestId('b'.repeat(64)));
  // A provider may charge successfully even when the creation response is lost.
  // Retrying the same local order must reuse the same provider idempotency key.
  const refused = await call({...draft,clientRequestId:'teste-cartao-recusado'});
  const refusedOrder = await mp.findOrder(refused.body.pedido.id);
  refusedOrder.order.pagamento.mpOrderId='ORDREFUSED1234567890';
  await fakeStorage.writeJson(refusedOrder.path,refusedOrder.order,{allowOverwrite:true});
  const declined = await mp.reconcile({...providerOrder(refusedOrder.order.id),id:refusedOrder.order.pagamento.mpOrderId,status:'failed'});
  assert.equal(declined.status,'rejected');
  assert.equal(queued().length,1,'a refused charge does not create a receipt');
  await assert.rejects(()=>pedidos.confirmarPedido(refusedOrder.order.id),/pagamento|aprovad/i);
  const debit = await call({...draft,clientRequestId:'teste-cartao-debito-invalido',pagamento:{metodo:'debito',fluxo:'mercadopago'}});
  const debitId = debit.body.pedido.id;
  const invalidDebitForm={token:'local-token-for-debit-card',payment_method_id:'visa',payment_type_id:'debit_card',installments:2,payer:{email:'cliente@dominio.test'}};
  const oldFetch=global.fetch;
  let invalidRequests=0;
  try {
    global.fetch=async()=>{invalidRequests++;throw new Error('invalid debit must not contact provider');};
    await assert.rejects(()=>mp.submitPayment(debitId,invalidDebitForm),/cartao_invalido/);
    await assert.rejects(()=>mp.submitPayment(debitId,{...invalidDebitForm,installments:1,payment_type_id:'credit_card'}),/cartao_invalido/);
    assert.equal(invalidRequests,0);
  } finally {global.fetch=oldFetch;}
  const uncertain = await call({...draft,clientRequestId:'teste-cartao-resposta-perdida'});
  const uncertainId = uncertain.body.pedido.id;
  const networkApproval = {...providerOrder(uncertainId),id:'ORDAMBIGUOUS1234567890'};
  const savedFetch = global.fetch;
  const keys = [];
  let providerCreations = 0, firstReplyLost = true;
  try {
    global.fetch = async (url, options={}) => {
      if(options.method === 'POST') {
        const payload = JSON.parse(options.body);
        assert.equal(payload.total_amount,'15.00');
        assert.equal(payload.external_reference,uncertainId);
        keys.push(options.headers['X-Idempotency-Key']);
        if(firstReplyLost) {
          providerCreations++;
          firstReplyLost=false;
          throw new Error('connection lost after charge creation');
        }
        return {ok:true,status:200,json:async()=>networkApproval};
      }
      assert.equal(String(url).split('/').pop(),networkApproval.id);
      return {ok:true,status:200,json:async()=>networkApproval};
    };
    const form={token:'tokenized-card-for-local-test',payment_method_id:'visa',payment_type_id:'credit_card',installments:1,payer:{email:'cliente@dominio.test'}};
    await assert.rejects(()=>mp.submitPayment(uncertainId,form));
    assert.equal(queued().length,1,'uncertain creation does not generate a kitchen order');
    await assert.rejects(()=>mp.submitPayment(uncertainId,form),/mp_attempt_requires_reconciliation/);
    assert.equal(keys.length,1,'an unknown first reply never creates another provider request');
    const recovered = await mp.reconcile(await mp.getOrder(networkApproval.id));
    assert.equal(recovered.status,'approved');
    assert.equal(providerCreations,1);
    assert.equal(keys.length,1);
    assert.equal(queued().length,2);
    const savedOrder=[...storage.entries()].find(([p,v])=>p.includes('/aguardando/')&&v.id===uncertainId)[1];
    assert.equal(savedOrder.pagamento.mpOrderId,networkApproval.id);
    assert.equal(JSON.stringify(savedOrder).includes(form.token),false,'card token is never persisted');
  } finally { global.fetch=savedFetch; }
  // The signed webhook's authoritative lookup can arrive after a provider charge
  // succeeded but before the local POST response recorded its provider ID.
  const orphan = await call({...draft,clientRequestId:'teste-cartao-webhook-resposta-perdida'});
  const orphanId = orphan.body.pedido.id;
  const orphanApproval={...providerOrder(orphanId),id:'ORDWEBHOOK1234567890'};
  assert.equal(await mp.reconcile(orphanApproval),null,'untrusted objects cannot bind an orphan payment');
  const attempted=await mp.findOrder(orphanId);
  attempted.order.pagamento.tentativaIniciadaEm=new Date().toISOString();
  await fakeStorage.writeJson(attempted.path,attempted.order,{allowOverwrite:true});
  const orphanFetch=global.fetch;
  try {
    global.fetch=async()=>({ok:true,status:200,json:async()=>orphanApproval});
    const recoveredByNotification=await mp.reconcile(await mp.getOrder(orphanApproval.id));
    assert.equal(recoveredByNotification.status,'approved');
  } finally {global.fetch=orphanFetch;}
  assert.equal(queued().length,3);
  assert.equal((await mp.findOrder(orphanId)).order.pagamento.mpOrderId,'ORDWEBHOOK1234567890');
  console.log('OK: valores verificados, pendência/recusa sem impressão, aprovação idempotente, estorno parcial, 3DS, resposta perdida e Preview isolado');
})().catch(error => { console.error(error);process.exitCode=1; });
