const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const Module=require('node:module');
process.env.MP_WEBHOOK_SECRET='local-test-secret-never-use-in-production';
let lookups=0, reconciliations=0, failLookup=false;
const id='ORD01JS2V6CM8KJ0EC4H502TGK1WP';
const authoritative={id,status:'processing',external_reference:'a'.repeat(64)};
const originalLoad=Module._load;
Module._load=function(request){
  if(request.endsWith('mp-checkout')) return {
    enabled:()=>true,canReconcile:()=>true,safeError:()=>({reason:'test_provider_error'}),
    getOrder:async requested=>{lookups++;assert.equal(requested,id);if(failLookup)throw new Error('provider timeout');return authoritative;},
    reconcile:async data=>{reconciliations++;assert.deepEqual(data,authoritative,'the provider response is authoritative');return {status:'pending'};},
  };
  return originalLoad.apply(this,arguments);
};
const webhook=require('../api/mp-webhook');
function signed(ts=String(Date.now()), requestId='webhook-test-request', signedId=id) {
  const digest=crypto.createHmac('sha256',process.env.MP_WEBHOOK_SECRET)
    .update(`id:${signedId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
  return {'x-signature':`ts=${ts},v1=${digest}`,'x-request-id':requestId};
}
async function call(headers,body={type:'order',data:{id},status:'processed',total_paid_amount:'99999.00'},query={'data.id':id}) {
  const response={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},send(data){this.body=data;return this;},json(data){this.body=data;return this;}};
  await webhook({method:'POST',headers:{'content-type':'application/json',...headers},body,query},response);
  return response;
}
(async()=>{
  assert.equal((await call({})).statusCode,401);
  const tampered=signed();tampered['x-signature']=tampered['x-signature'].replace(/v1=./,'v1=z');
  assert.equal((await call(tampered)).statusCode,401);
  assert.equal((await call(signed(String(Date.now()-11*60*1000)))).statusCode,401,'stale delivery must not authorize a lookup');
  const alteredRequest=signed();alteredRequest['x-request-id']='tampered-request';
  assert.equal((await call(alteredRequest)).statusCode,401);
  assert.equal((await call(signed(String(Date.now()),'webhook-test-request','ORDdifferent12345'))).statusCode,401);
  assert.equal((await call(signed(),{type:'order',data:{id:'ORDother123456789'}})).statusCode,400,'query/body identity mismatch is rejected');
  assert.equal((await call(signed(),undefined,{})).statusCode,401,'unsigned body ID is not a fallback');
  assert.equal(lookups,0,'invalid signatures are rejected before network access');
  assert.equal((await call(signed(),{type:'payment',data:{id}})).statusCode,200);
  assert.equal(lookups,0,'unsupported event type is ignored');
  assert.equal((await call(signed())).statusCode,200);
  assert.equal(lookups,1);assert.equal(reconciliations,1);
  assert.equal((await call(signed(String(Math.floor(Date.now()/1000))))).statusCode,200,'seconds timestamps are supported');
  assert.equal(lookups,2);assert.equal(reconciliations,2);
  failLookup=true;
  assert.equal((await call(signed())).statusCode,503,'provider uncertainty requests webhook retry');
  assert.equal(reconciliations,2,'a failed authoritative lookup cannot approve a forged body');
  console.log('OK: HMAC adulterado/expirado bloqueado; webhook consulta provedor e pede retry em falha');
})().catch(error=>{console.error(error);process.exitCode=1;});
