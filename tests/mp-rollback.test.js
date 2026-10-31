const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const Module=require('node:module');
const storage=new Map();
const fakeStorage={
  isStorageUnavailable:()=>false,
  readJson:async path=>({value:structuredClone(storage.get(path)||null)}),
  writeJson:async(path,value,options)=>{
    if(storage.has(path)&&!options.allowOverwrite)throw Object.assign(new Error('conflict'),{status:409});
    storage.set(path,structuredClone(value));
  },
  listBlobs:async()=>({blobs:[]}),
};
const load=Module._load;
Module._load=function(request,parent){
  if(request.endsWith('postgres-storage'))return fakeStorage;
  if(request==='./disponibilidade'&&parent?.filename.endsWith('/api/pedidos.js'))return {
    readStoreStatus:async()=>({aberto:true}),readServiceAvailability:async()=>({retirada:true,entrega:true}),
    readPrepConfig:async()=>({}),readOrderCatalog:async()=>require('../api/catalogo.json'),
  };
  return load.apply(this,arguments);
};
process.env.VERCEL_ENV='preview';
process.env.MP_CARD_CHECKOUT_ENABLED='true';
process.env.MP_PUBLIC_KEY='TEST-public';
process.env.MP_ACCESS_TOKEN='TEST-token';
process.env.MP_WEBHOOK_SECRET='local-rollback-test-secret';
const pedidos=require('../api/pedidos');
const mp=require('../lib/mp-checkout');
const status=require('../api/mp-status');
const webhook=require('../api/mp-webhook');
const pagamento=require('../api/mp-pagamento');
const config=require('../api/mp-config');
const draft={cliente:{nome:'Cliente Teste',telefone:'43999999999'},itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],atendimento:{tipo:'retirada'},pagamento:{metodo:'credito'}};
async function call(handler,method,body={},query={},extraHeaders={}){
  const response={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(data){this.body=data;return this;},send(data){this.body=data;return this;}};
  await handler({method,body,query,headers:{host:'ferracinilanches.com.br',origin:'https://ferracinilanches.com.br','content-type':'application/json',...extraHeaders}},response);
  return response;
}
function providerOrder(id,providerId){return {id:providerId,type:'online',processing_mode:'automatic',status:'processed',status_detail:'accredited',external_reference:id,total_amount:'15.00',total_paid_amount:'15.00',transactions:{payments:[{amount:'15.00',paid_amount:'15.00',status:'processed',status_detail:'accredited',payment_method:{id:'visa',type:'credit_card',installments:1}}]}};}
(async()=>{
  const approvals=new Map();
  const ids=[];
  for(const [clientRequestId,providerId] of [['rollback-status-existing-charge','ORDROLLBACKSTATUS12345'],['rollback-webhook-existing-charge','ORDROLLBACKWEBHOOK12345']]){
    const result=await call(pedidos,'POST',{...draft,clientRequestId});
    assert.equal(result.body.pedido.status,'aguardando_pagamento');
    ids.push(result.body.pedido.id);
    const found=await mp.findOrder(result.body.pedido.id);
    found.order.pagamento.mpOrderId=providerId;
    await fakeStorage.writeJson(found.path,found.order,{allowOverwrite:true});
    approvals.set(providerId,providerOrder(found.order.id,providerId));
  }
  const unknown=await call(pedidos,'POST',{...draft,clientRequestId:'rollback-aged-unknown-charge'});
  const unknownId=unknown.body.pedido.id;
  const unknownSource=await mp.findOrder(unknownId);
  unknownSource.order.pagamento.tentativaIniciadaEm=new Date(Date.now()-31*60*1000).toISOString();
  await fakeStorage.writeJson(unknownSource.path,unknownSource.order,{allowOverwrite:true});
  process.env.MP_CARD_CHECKOUT_ENABLED='false';
  assert.equal((await call(config,'GET')).body.enabled,false);
  assert.equal((await call(pagamento,'POST',{id:ids[0],form:{}})).statusCode,503,'rollback never permits a new charge');
  const savedFetch=global.fetch;
  let lookups=0;
  try {
    global.fetch=async(url,options={})=>{
      assert.notEqual(options.method,'POST','rollback must not create provider orders');
      const approved=approvals.get(String(url).split('/').pop());
      assert.ok(approved);lookups++;
      return {ok:true,status:200,json:async()=>approved};
    };
    const settled=await call(status,'GET',{}, {id:ids[0]});
    assert.equal(settled.statusCode,200,'an existing charge remains queryable during rollback');
    assert.equal(settled.body.status,'approved');
    const providerId='ORDROLLBACKWEBHOOK12345';
    const ts=String(Date.now()),requestId='rollback-signed-request';
    const digest=crypto.createHmac('sha256',process.env.MP_WEBHOOK_SECRET).update(`id:${providerId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
    const notification=await call(webhook,'POST',{type:'order',data:{id:providerId}},{'data.id':providerId},{'x-signature':`ts=${ts},v1=${digest}`,'x-request-id':requestId});
    assert.equal(notification.statusCode,200,'signed notifications for existing charges still settle during rollback');
    assert.equal(lookups,2);
    const uncertain=await call(status,'GET',{}, {id:unknownId});
    assert.equal(uncertain.statusCode,200);
    assert.equal(uncertain.body.status,'processing_unknown');
    assert.equal(uncertain.body.retrySameAttempt,false,'unknown attempts cannot invite a new charge');
    process.env.MP_CARD_CHECKOUT_ENABLED='true';
    const expiredAttempt=await call(pagamento,'POST',{id:unknownId,form:{}});
    assert.equal(expiredAttempt.statusCode,409,'old unknown attempts require reconciliation');
    assert.equal(expiredAttempt.body.needsNewOrder,false);
    assert.equal(expiredAttempt.body.status,'processing_unknown');
    assert.equal(lookups,2,'aged retry is blocked before any provider request');
    process.env.MP_CARD_CHECKOUT_ENABLED='false';
    const queue=[...storage.entries()].filter(([path])=>path.startsWith('mp-preview/pedidos/fila/'));
    assert.equal(queue.length,2);
    assert.ok(queue.every(([,order])=>order.pagamento.status==='approved'&&order.pagamento.verified===true));
    assert.equal([...storage.keys()].some(path=>path.startsWith('pedidos/fila/')),false);
  } finally {global.fetch=savedFetch;}
  console.log('OK: rollback bloqueia novas cobranças e mantém consulta/webhook de cobranças já aceitas');
})().catch(error=>{console.error(error);process.exitCode=1;});
