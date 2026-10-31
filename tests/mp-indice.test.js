const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const Module=require('node:module');
const storage=new Map(),reads=[];
const fakeStorage={
  isStorageUnavailable:()=>false,
  readJson:async pathname=>{reads.push(pathname);return {value:structuredClone(storage.get(pathname)||null)};},
  writeJson:async(pathname,value,options)=>{
    if(storage.has(pathname)&&!options.allowOverwrite)throw Object.assign(new Error('conflict'),{status:409});
    storage.set(pathname,structuredClone(value));
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
process.env.MP_CARD_CHECKOUT_ENABLED='false';
process.env.MP_ACCESS_TOKEN='TEST-token';
process.env.MP_PUBLIC_KEY='TEST-public';
process.env.MP_WEBHOOK_SECRET='local-index-regression-secret';
const mp=require('../lib/mp-checkout');
const pedidos=require('../api/pedidos');
const webhook=require('../api/mp-webhook');
const ns='mp-preview/';
const id=crypto.createHash('sha256').update('late-refund-index-regression').digest('hex');
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()-10*86400000));
const pendingPath=ns+'pedidos/aguardando/'+date+'/'+id+'.json';
const queuePath=ns+'pedidos/fila/'+date+'/'+id+'.json';
const indexPath=ns+'pedidos/pagamento-indice/'+id+'.json';
const providerId='ORDLATEPAYMENT123456789';
const order={id,data:date,criadoEm:new Date(Date.now()-10*86400000).toISOString(),status:'confirmado',confirmadoPath:queuePath,numero:'07',referencia:'LATEPAYMENT',totalCentavos:1500,pagamento:{metodo:'credito',fluxo:'mercadopago',status:'approved',verified:true,mpOrderId:providerId}};
storage.set(pendingPath,structuredClone(order));
storage.set(queuePath,{...structuredClone(order),status:'pendente'});
storage.set(indexPath,{id,pathname:pendingPath});
(async()=>{
  const found=await mp.findOrder(id);
  assert.equal(found.path,pendingPath,'the durable index finds a charge older than the recent-date scan');
  await mp.ensureOrderIndex(order,pendingPath);
  await mp.ensureOrderIndex(order,pendingPath);
  const otherValidDate='2020-01-01';
  await assert.rejects(()=>mp.ensureOrderIndex(order,ns+'pedidos/aguardando/'+otherValidDate+'/'+id+'.json'),/mp_order_index_conflict/);
  assert.equal(storage.get(indexPath).pathname,pendingPath,'repeated setup preserves the immutable original mapping');
  assert.equal((await pedidos.confirmarPedido(id)).numero,'07','queue confirmation resolves the indexed historical order');
  process.env.MP_CARD_CHECKOUT_ENABLED='true';
  const replayResponse={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  await pedidos({method:'POST',query:{},headers:{origin:'https://ferracinilanches.com.br','content-type':'application/json'},body:{
    clientRequestId:'late-refund-index-regression',cliente:{nome:'Cliente Teste',telefone:'43999999999'},
    itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],
    atendimento:{tipo:'retirada'},pagamento:{metodo:'credito',fluxo:'mercadopago'},
  }},replayResponse);
  assert.equal(replayResponse.statusCode,200,'a retry on a later date reuses the indexed original order');
  assert.equal(replayResponse.body.duplicado,true);
  assert.equal(replayResponse.body.pedido.id,id);
  assert.equal(replayResponse.body.pedido.numero,'07');
  assert.equal([...storage.keys()].filter(p=>p.startsWith(ns+'pedidos/aguardando/')).length,1,'cross-date retry cannot create a new reservation');
  process.env.MP_CARD_CHECKOUT_ENABLED='false';
  const oldFetch=global.fetch;
  try {
    global.fetch=async url=>{
      assert.equal(String(url).split('/').pop(),providerId);
      return {ok:true,status:200,json:async()=>({id:providerId,external_reference:id,status:'refunded'})};
    };
    const ts=String(Date.now()),requestId='late-refund-signed-request';
    const signature=crypto.createHmac('sha256',process.env.MP_WEBHOOK_SECRET).update(`id:${providerId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
    const response={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},send(body){this.body=body;return this;}};
    await webhook({method:'POST',body:{type:'order',data:{id:providerId}},query:{'data.id':providerId},headers:{'content-type':'application/json','x-signature':`ts=${ts},v1=${signature}`,'x-request-id':requestId}},response);
    assert.equal(response.statusCode,200);
    assert.equal(storage.get(pendingPath).pagamento.status,'rejected');
    assert.equal(storage.get(queuePath).status,'bloqueado_pagamento','a refund ten days later blocks an unclaimed old receipt');
    assert.ok(storage.has(ns+'pedidos/pagamento-bloqueado/'+id+'.json'));
    assert.equal([...storage.keys()].filter(p=>p.startsWith(ns+'pedidos/fila/')).length,1,'late events cannot duplicate a receipt');
  } finally {global.fetch=oldFetch;}
  for(const [n,target] of [
    [1,'config/segredo.json'],
    [2,'pedidos/aguardando/'+date+'/'+id+'.json'],
    [3,ns+'pedidos/aguardando/'+date+'/../'+id+'.json'],
    [4,ns+'pedidos/aguardando/'+date+'/'+'f'.repeat(64)+'.json'],
  ]) {
    const maliciousId=crypto.createHash('sha256').update('malicious-index-'+n).digest('hex');
    storage.set(ns+'pedidos/pagamento-indice/'+maliciousId+'.json',{id:maliciousId,pathname:target});
    const previousReads=reads.length;
    await assert.rejects(()=>mp.findOrder(maliciousId),/invalid_order_index_path/,'an index cannot redirect order lookups outside the exact namespaced order path');
    assert.equal(reads.slice(previousReads).includes(target),false,'untrusted index targets are refused before storage access');
  }
  console.log('OK: índice recupera pedido antigo, webhook de estorno tardio bloqueia fila e caminhos maliciosos são recusados');
})().catch(error=>{console.error(error);process.exitCode=1;});
