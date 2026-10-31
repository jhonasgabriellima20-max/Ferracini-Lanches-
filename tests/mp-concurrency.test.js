const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');

const storage = new Map();
let synchronizedId, initialAttemptReads = 0, releaseInitialReads;
let firstApprovalFinished, attemptWrites = 0;
const initialReadsReady = new Promise(resolve => {releaseInitialReads=resolve;});
const fakeStorage = {
  isStorageUnavailable:error=>error?.code==='STORAGE_UNAVAILABLE',
  readJson:async pathname=>{
    const value=structuredClone(storage.get(pathname)||null);
    if(synchronizedId && pathname.endsWith('/pagamento-tentativa/'+synchronizedId+'.json') && initialAttemptReads<2){
      initialAttemptReads++;
      if(initialAttemptReads===2)releaseInitialReads();
      await initialReadsReady;
    }
    return {value};
  },
  writeJson:async(pathname,value,options)=>{
    if(synchronizedId && pathname.endsWith('/pagamento-tentativa/'+synchronizedId+'.json')){
      attemptWrites++;
      if(attemptWrites===2)await firstApprovalFinished;
    }
    if(storage.has(pathname)&&!options.allowOverwrite)throw Object.assign(new Error('conflict'),{status:409});
    storage.set(pathname,structuredClone(value));
  },
  listBlobs:async({prefix,limit})=>({blobs:[...storage.keys()].filter(path=>path.startsWith(prefix)).slice(0,limit).map(pathname=>({pathname}))}),
};
const originalLoad=Module._load;
Module._load=function(request,parent){
  if(request.endsWith('postgres-storage'))return fakeStorage;
  if(request==='./disponibilidade'&&parent?.filename.endsWith('/api/pedidos.js'))return {
    readStoreStatus:async()=>({aberto:true}),readServiceAvailability:async()=>({retirada:true,entrega:true}),
    readPrepConfig:async()=>({}),readOrderCatalog:async()=>require('../api/catalogo.json'),
  };
  return originalLoad.apply(this,arguments);
};
process.env.VERCEL_ENV='preview';
process.env.MP_CARD_CHECKOUT_ENABLED='true';
process.env.MP_PUBLIC_KEY='TEST-concurrency-public';
process.env.MP_ACCESS_TOKEN='TEST-concurrency-token';
const mp=require('../lib/mp-checkout');
const statusHandler=require('../api/mp-status');
const paymentHandler=require('../api/mp-pagamento');
const oldFetch=global.fetch;
test.after(()=>{Module._load=originalLoad;global.fetch=oldFetch;});

const form={token:'opaque-token-should-never-be-saved',payment_method_id:'visa',payment_type_id:'credit_card',installments:1,payer:{email:'not-persisted@example.test',identification:{type:'CPF',number:'12345678901'}}};
function seed(label){
  const id=crypto.createHash('sha256').update(label).digest('hex');
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const pathname='mp-preview/pedidos/aguardando/'+date+'/'+id+'.json';
  const order={id,data:date,criadoEm:new Date().toISOString(),atualizadoEm:new Date().toISOString(),status:'aguardando_pagamento',referencia:label,totalCentavos:1500,
    pagamento:{metodo:'credito',fluxo:'mercadopago',status:'pending',verified:false},atendimento:{tipo:'retirada'},cliente:{nome:'Cliente Teste'},itens:[]};
  storage.set(pathname,order);
  storage.set(mp.orderIndexPath(id),{id,pathname});
  return {id,pathname};
}
function providerOrder(id,providerId,status='processed'){
  return {id:providerId,type:'online',processing_mode:'automatic',external_reference:id,status,status_detail:status==='processed'?'accredited':'canceled',currency:'BRL',total_amount:'15.00',total_paid_amount:status==='processed'?'15.00':'0.00',
    transactions:{payments:[{status,status_detail:status==='processed'?'accredited':'canceled_transaction',amount:'15.00',paid_amount:status==='processed'?'15.00':'0.00',payment_method:{id:'visa',type:'credit_card',installments:1}}]}};
}
const response=(value,status=200)=>({ok:status<400,status,json:async()=>structuredClone(value),headers:{get(){return null;}}});
async function call(handler,method,body={},query={}){
  const result={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(data){this.body=data;return this;}};
  await handler({method,body,query,headers:{host:'ferracinilanches.com.br',origin:'https://ferracinilanches.com.br','content-type':'application/json'}},result);
  return result;
}

test('duas abas: tentativa atrasada não apaga aprovação nem cria segunda cobrança', {timeout:5000}, async()=>{
  const {id,pathname}=seed('concurrent-payment-regression');
  synchronizedId=id;
  let finishFirst;
  firstApprovalFinished=new Promise(resolve=>{finishFirst=resolve;});
  const approval=providerOrder(id,'ORDCONCURRENT123456789');
  let creations=0;
  global.fetch=async(url,options={})=>{
    if(options.method==='POST'){
      creations++;
      assert.equal(options.headers['X-Idempotency-Key'],mp.requestId(id));
      return response(approval);
    }
    return response(approval);
  };
  const first=mp.submitPayment(id,form);
  const second=mp.submitPayment(id,form);
  first.then(finishFirst,finishFirst);
  const [a,b]=await Promise.all([first,second]);
  synchronizedId=null;
  assert.equal(attemptWrites,2,'the test forced a delayed loser in the insert-only attempt claim');
  assert.equal(a.status,'approved');assert.equal(b.status,'approved');
  assert.equal(creations,1,'only the winning worker contacts the create endpoint');
  assert.equal(storage.get(pathname).pagamento.status,'approved');
  assert.equal(storage.get(pathname).pagamento.verified,true);
  assert.equal(storage.get(pathname).pagamento.mpOrderId,approval.id);
  assert.ok(storage.get(pathname).confirmadoPath);
  assert.equal([...storage.keys()].filter(path=>path.startsWith('mp-preview/pedidos/fila/')).length,1);
  assert.equal((await call(statusHandler,'GET',{}, {id})).body.status,'approved');
  const facts=JSON.stringify([...storage.values()]);
  assert.equal(facts.includes(form.token),false);
  assert.equal(facts.includes(form.payer.email),false);
  assert.equal(facts.includes(form.payer.identification.number),false);
});

test('HTTP 400 conhecido permanece recuperável após recarga e não permite repetir a mesma cobrança', async()=>{
  const {id}=seed('validation-rejected-reload-regression');
  let creations=0;
  global.fetch=async(url,options={})=>{
    assert.equal(options.method,'POST');creations++;
    return response({errors:[{code:'property_value',message:'payer.email invalid'}]},400);
  };
  const rejected=await call(paymentHandler,'POST',{id,form});
  assert.equal(rejected.statusCode,422);
  assert.equal(rejected.body.status,'validation_rejected');
  assert.equal(rejected.body.needsNewOrder,true);
  assert.equal(storage.get(mp.validationPath(id)).status,'validation_rejected');
  const reloaded=await call(statusHandler,'GET',{}, {id});
  assert.equal(reloaded.statusCode,200);
  assert.deepEqual(reloaded.body,rejected.body,'reload recovers the same definitive classification');
  assert.equal((await call(paymentHandler,'POST',{id,form})).body.status,'validation_rejected');
  assert.equal(creations,1);
  assert.equal([...storage.values()].some(value=>value.status==='pendente'&&value.id===id),false);
});

test('HTTP 409, erro 400 desconhecido e timeout não iniciam outra cobrança', async()=>{
  for(const outcome of ['conflict','unknown400','timeout']){
    const {id}=seed('unknown-first-request-'+outcome);
    let creations=0;
    global.fetch=async()=>{
      creations++;
      if(outcome==='timeout')throw new Error('network result unknown');
      if(outcome==='unknown400')return response({code:'idempotency_state_unknown'},400);
      return response({code:'idempotency_key_already_used'},409);
    };
    const unknown=await call(paymentHandler,'POST',{id,form});
    assert.equal(unknown.statusCode,outcome==='conflict'?409:503);
    assert.notEqual(unknown.body.needsNewOrder,true);
    const reloaded=await call(statusHandler,'GET',{}, {id});
    assert.equal(reloaded.body.status,'processing_unknown');
    assert.equal(reloaded.body.retrySameAttempt,false);
    assert.equal((await call(paymentHandler,'POST',{id,form})).body.needsNewOrder,false);
    assert.equal(creations,1,'uncertainty cannot lead to a new transport request');
    assert.equal(storage.has(mp.validationPath(id)),false);
  }
});

test('cancelamento explícito recebido do provedor bloqueia comanda sem aprovação', async()=>{
  for(const cancelled of ['canceled','cancelled']){
    const {id}=seed('provider-explicit-'+cancelled);
    const provider=providerOrder(id,'ORDCANCELLED'+id.slice(0,16),cancelled);
    global.fetch=async()=>response(provider);
    const result=await mp.submitPayment(id,form);
    assert.equal(result.status,'rejected');
    assert.ok(storage.has(mp.paymentBlockPath(id)));
    assert.equal([...storage.values()].some(value=>value.status==='pendente'&&value.id===id),false);
  }
});
