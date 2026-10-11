// End-to-end simulated payment. Never contacts real Mercado Pago.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const Module=require('node:module');
const storage=new Map();
const fakeStorage={
  isStorageUnavailable:()=>false,
  readJson:async p=>({value:structuredClone(storage.get(p)||null)}),
  writeJson:async(p,val,opts)=>{
    if(!opts?.allowOverwrite&&storage.has(p)){const e=new Error('conflict');e.status=409;throw e;}
    storage.set(p,structuredClone(val));
  },
  listBlobs:async({prefix,limit})=>({blobs:[...storage.keys()].filter(x=>x.startsWith(prefix)).slice(0,limit).map(pathname=>({pathname}))}),
};
const initial=Module._load;
Module._load=function(request,parent,isMain){
  if(request.endsWith('postgres-storage'))return fakeStorage;
  if(request==='./disponibilidade'&&/\/api\/(pedidos|pagamentos)\.js$/.test(parent?.filename||'')){
    return {
      readStoreStatus:async()=>({aberto:true}),
      readOrderCatalog:async()=>require('../api/catalogo.json'),
      readServiceAvailability:async()=>({entrega:true,retirada:true}),
      readPrepConfig:async()=>({}),
    };
  }
  return initial.apply(this,arguments);
};
process.env.MP_PAYMENTS_ENABLED='true';
process.env.MP_ACCESS_TOKEN='TEST_TOKEN_ONLY';
process.env.MP_PUBLIC_KEY='TEST_PUBLIC_ONLY';
process.env.MP_WEBHOOK_SECRET='TEST_WEBHOOK_SECRET_ONLY';
process.env.MP_WEBHOOK_URL='https://ferracinilanches.com.br/api/mercadopago-webhook';
const orders=require('../api/pedidos');
const payments=require('../api/pagamentos');
const webhooks=require('../api/mercadopago-webhook');

const body={
  clientRequestId:'pix-simulacao-1234567890',
  origem:'site',cliente:{nome:'Cliente Teste',telefone:'43999999999'},
  itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],
  atendimento:{tipo:'retirada'},pagamento:{metodo:'pix'},
};
let created=0,paid=false,amount=15;
let provider;
global.fetch=async(url,opts={})=>{
  assert.match(url,/api\.mercadopago\.com\/v1\/payments/);
  if(opts.method==='POST'){
    created++;
    const p=JSON.parse(opts.body);
    assert.equal(p.transaction_amount,15);
    assert.equal(p.payment_method_id,'pix');
    assert.equal(p.notification_url,process.env.MP_WEBHOOK_URL);
    assert.match(opts.headers['X-Idempotency-Key'],/^[a-f0-9-]{36}$/);
    provider={id:123456789,status:'pending',payment_method_id:'pix',
      payment_type_id:'bank_transfer',currency_id:'BRL',transaction_amount:amount,
      external_reference:p.external_reference,
      point_of_interaction:{transaction_data:{qr_code:'pix-test'}}};
  }
  if(opts.method!=='POST'&&provider){
    return {ok:true,json:async()=>({...provider,
      status:paid?'approved':'pending',transaction_amount:amount})};
  }
  return {ok:true,json:async()=>provider};
};
function req(method,body={},query={},headers={}){
  return {method,body,query,headers:{origin:'https://ferracinilanches.com.br',
    'content-type':'application/json',...headers}};
}
async function call(handler,input){
  const result={headers:{},setHeader(k,v){this.headers[k]=v;},
    status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;},
    end(){this.ended=true;return this;}};
  await handler(input,result);
  return result;
}
(async()=>{
  const bypass=await call(orders,req('POST',body));
  assert.equal(bypass.statusCode,402);
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,0);
  const first=await call(payments,req('POST',{pedido:body,pagamento:{
    payment_method_id:'pix',payer:{email:'cliente@example.com'}}}));
  assert.equal(first.statusCode,200);
  assert.equal(first.body.status,'pending');
  assert.equal(first.body.qrCode,'pix-test');
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,0);
  const repeat=await call(payments,req('POST',{pedido:body,pagamento:{
    payment_method_id:'pix',payer:{email:'cliente@example.com'}}}));
  assert.equal(repeat.statusCode,200);
  assert.equal(created,1,'Pix não pode ser cobrado duas vezes');
  const pending=await call(payments,req('GET',{}, {id:first.body.id}));
  assert.equal(pending.body.pago,false);
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,0);
  paid=true;amount=14;
  const wrongAmount=await call(payments,req('GET',{}, {id:first.body.id}));
  assert.equal(wrongAmount.body.pago,false);
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,0);
  amount=15;
  const approved=await call(payments,req('GET',{}, {id:first.body.id}));
  assert.equal(approved.body.pago,true);
  assert.equal(approved.body.numero,'01');
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,1);
  const again=await call(payments,req('GET',{}, {id:first.body.id}));
  assert.equal(again.body.numero,'01');
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,1);
  const invalidWebhook=await call(webhooks,req('POST',{type:'payment',data:{id:'123456789'}},
    {'data.id':'123456789'}, {'x-signature':'ts=1,v1='+('0'.repeat(64)),'x-request-id':'test-1'}));
  assert.equal(invalidWebhook.statusCode,401);
  const ts='1700000000',rid='test-1',mid='123456789';
  const message='id:'+mid+';request-id:'+rid+';ts:'+ts+';';
  const v1=crypto.createHmac('sha256',process.env.MP_WEBHOOK_SECRET).update(message).digest('hex');
  const hook=await call(webhooks,req('POST',{type:'payment',data:{id:mid}},
    {'data.id':mid},{'x-signature':'ts='+ts+',v1='+v1,'x-request-id':rid}));
  assert.equal(hook.statusCode,200);
  assert.equal([...storage.keys()].filter(x=>x.startsWith('pedidos/fila/')).length,1);
  console.log('OK: sem comanda antes do pagamento, rejeita valor divergente, libera após aprovação e não duplica');
})().catch(err=>{console.error(err);process.exitCode=1;});
