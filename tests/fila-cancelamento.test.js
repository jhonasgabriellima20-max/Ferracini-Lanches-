// Signed webhook -> real reconciliation -> PostgreSQL queue SQL. The provider
// network is simulated; these checks do not send a receipt to a real printer.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const { dataOperacao } = require('../assets/dia-operacao');

test('webhooks repetidos e cancelamentos autorizam no máximo uma reivindicação de impressão', async () => {
  const db = new PGlite();
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  const savedEnvironment = {};
  const settings = {
    VERCEL_ENV:'production', MP_CARD_CHECKOUT_ENABLED:'true',
    MP_PUBLIC_KEY:'fixture-public-key', MP_ACCESS_TOKEN:'fixture-access-token',
    MP_WEBHOOK_SECRET:'fixture-webhook-secret', PRINT_AGENT_TOKEN:'fixture-print-token',
    PRINT_QUEUE_DATABASE_URL:'postgresql://fixture@localhost/fixture',
    PRINT_QUEUE_START_AT:'2020-01-01T00:00:00Z',
  };
  for(const [key,value] of Object.entries(settings)){savedEnvironment[key]=process.env[key];process.env[key]=value;}
  try{
    await db.exec('CREATE TABLE public.ferracini_store (pathname text PRIMARY KEY, value jsonb NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())');
    const storage = {
      isStorageUnavailable:()=>false,
      readJson:async pathname=>({value:(await db.query('SELECT value FROM public.ferracini_store WHERE pathname=$1',[pathname])).rows[0]?.value || null}),
      writeJson:async(pathname,value,options={})=>{
        const conflict = options.allowOverwrite ? ' ON CONFLICT(pathname) DO UPDATE SET value=excluded.value, updated_at=now()' : ' ON CONFLICT(pathname) DO NOTHING';
        const rows=(await db.query('INSERT INTO public.ferracini_store(pathname,value) VALUES ($1,$2)'+conflict+' RETURNING pathname',[pathname,JSON.stringify(value)])).rows;
        if(!rows.length) throw Object.assign(new Error('storage_conflict'),{status:409,code:'conflict'});
      },
      listBlobs:async({prefix,limit=1000})=>({blobs:(await db.query('SELECT pathname FROM public.ferracini_store WHERE pathname LIKE $1 ORDER BY pathname LIMIT $2',[prefix+'%',limit])).rows}),
    };
    Module._load=function(request,parent,isMain){
      if(request.endsWith('postgres-storage')) return storage;
      if(request==='@neondatabase/serverless') return {neon:()=>({query:async(sql,params)=>(await db.query(sql,params)).rows})};
      return originalLoad.call(this,request,parent,isMain);
    };
    const mp=require('../lib/mp-checkout');
    const webhook=require('../api/mp-webhook');
    const queueHandler=require('../api/fila-impressao');
    const legacyHandler=require('../api/pedidos');
    const day=dataOperacao();
    const providers=new Map();
    let providerLookups=0;
    global.fetch=async(url,options={})=>{
      assert.notEqual(options.method,'POST','webhook and queue never create a charge');
      const order=providers.get(String(url).split('/').pop());
      assert.ok(order,'only the signed provider resource may be queried');
      providerLookups++;
      return {ok:true,status:200,json:async()=>structuredClone(order)};
    };
    async function call(handler,method,body={},query={},headers={}){
      const response={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;},send(data){this.data=data;return this;}};
      await handler({method,body,query,headers:{'content-type':'application/json',authorization:'Bearer fixture-print-token',...headers}},response);
      return response;
    }
    async function notify(providerId){
      const ts=String(Date.now()),requestId='fixture-notification-'+providerLookups;
      const signature=crypto.createHmac('sha256',settings.MP_WEBHOOK_SECRET)
        .update(`id:${providerId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
      return call(webhook,'POST',{type:'order',data:{id:providerId}},{'data.id':providerId},{'x-signature':`ts=${ts},v1=${signature}`,'x-request-id':requestId});
    }
    async function reserve(label){
      const id=crypto.createHash('sha256').update('queue-fixture-'+label).digest('hex');
      const providerId='ORDFIXTURE'+id.slice(0,20);
      const path=`pedidos/aguardando/${day}/${id}.json`;
      const order={id,data:day,clientRequestId:'queue-fixture-'+label,referencia:label,criadoEm:new Date().toISOString(),
        status:'aguardando_pagamento',tentativasImpressao:0,totalCentavos:1500,subtotalCentavos:1200,
        atendimento:{tipo:'retirada',taxaServicoCentavos:300},cliente:{nome:'Cliente fictício'},itens:[],
        pagamento:{metodo:'credito',fluxo:'mercadopago',status:'pending',verified:false,mpOrderId:providerId}};
      await storage.writeJson(path,order,{allowOverwrite:false});
      await mp.ensureOrderIndex(order,path);
      const provider={id:providerId,type:'online',processing_mode:'automatic',external_reference:id,total_amount:'15.00',total_paid_amount:'15.00',
        status:'processed',status_detail:'accredited',transactions:{payments:[{amount:'15.00',paid_amount:'15.00',status:'processed',status_detail:'accredited',payment_method:{id:'visa',type:'credit_card',installments:1}}]}};
      providers.set(providerId,provider);
      return {id,providerId,path,queuePath:`pedidos/fila/${day}/${id}.json`,provider};
    }
    const paid=await reserve('aprovado');
    for(let delivery=0;delivery<3;delivery++) assert.equal((await notify(paid.providerId)).statusCode,200);
    const listed=await call(queueHandler,'GET');
    assert.equal(listed.statusCode,200);
    assert.equal(listed.data.pedidos.length,1,'three signed approvals create one queue entry');
    const claims=await Promise.all([call(queueHandler,'PATCH',{pathname:paid.queuePath,status:'imprimindo'}),call(queueHandler,'PATCH',{pathname:paid.queuePath,status:'imprimindo'})]);
    assert.deepEqual(claims.map(result=>result.statusCode).sort(),[200,409]);
    assert.equal((await call(queueHandler,'PATCH',{pathname:paid.queuePath,status:'impresso'})).statusCode,200);
    assert.equal((await notify(paid.providerId)).statusCode,200,'late repeated approval can be acknowledged');
    assert.equal((await call(queueHandler,'GET')).data.pedidos.length,0,'late approval cannot reprint an acknowledged receipt');
    for(const state of ['canceled','cancelled']){
      const cancelled=await reserve(state);
      cancelled.provider.status=state;cancelled.provider.status_detail=state;
      cancelled.provider.transactions.payments[0].status=state;
      cancelled.provider.transactions.payments[0].status_detail=state;
      assert.equal((await notify(cancelled.providerId)).statusCode,200);
      assert.equal((await notify(cancelled.providerId)).statusCode,200,'duplicate cancellation is idempotent');
      assert.equal((await storage.readJson(cancelled.queuePath)).value,null,'cancelled reservation never receives a receipt');
      assert.ok((await storage.readJson(mp.paymentBlockPath(cancelled.id))).value,'cancellation leaves immutable block');
      assert.equal((await call(queueHandler,'PATCH',{pathname:cancelled.queuePath,status:'imprimindo'})).statusCode,409);
    }
    const beforeClaim=await reserve('cancelamento-apos-aprovacao');
    assert.equal((await notify(beforeClaim.providerId)).statusCode,200);
    beforeClaim.provider.status='cancelled';beforeClaim.provider.status_detail='cancelled';
    beforeClaim.provider.transactions.payments[0].status='cancelled';
    beforeClaim.provider.transactions.payments[0].status_detail='cancelled';
    assert.equal((await notify(beforeClaim.providerId)).statusCode,200);
    assert.equal((await call(queueHandler,'GET')).data.pedidos.length,0);
    assert.equal((await call(queueHandler,'PATCH',{pathname:beforeClaim.queuePath,status:'imprimindo'})).statusCode,409,'cancellation after listing blocks atomic claim');
    const afterClaim=await reserve('cancelamento-apos-spool');
    assert.equal((await notify(afterClaim.providerId)).statusCode,200);
    // A client using the old X-Print-Agent-Token contract must receive the same
    // atomic transition guarantees and the original full-order response shape.
    const legacyHeaders={authorization:'','x-print-agent-token':settings.PRINT_AGENT_TOKEN};
    const legacyClaim=await call(legacyHandler,'PATCH',{pathname:afterClaim.queuePath,status:'imprimindo'},{},legacyHeaders);
    assert.equal(legacyClaim.statusCode,200);
    assert.equal(legacyClaim.data.pedido.id,afterClaim.id);
    assert.equal(legacyClaim.data.pedido.status,'imprimindo');
    assert.equal((await call(legacyHandler,'PATCH',{pathname:afterClaim.queuePath,status:'imprimindo'},{},legacyHeaders)).statusCode,409);
    afterClaim.provider.status='cancelled';afterClaim.provider.status_detail='cancelled';
    afterClaim.provider.transactions.payments[0].status='cancelled';
    afterClaim.provider.transactions.payments[0].status_detail='cancelled';
    assert.equal((await notify(afterClaim.providerId)).statusCode,200);
    const legacyAck=await call(legacyHandler,'PATCH',{pathname:afterClaim.queuePath,status:'impresso'},{},legacyHeaders);
    assert.equal(legacyAck.statusCode,200,'a cancellation cannot discard an ACK for paper already sent');
    assert.equal(legacyAck.data.pedido.status,'impresso');
    assert.equal((await call(legacyHandler,'PATCH',{pathname:afterClaim.queuePath,status:'pendente'},{},legacyHeaders)).statusCode,409,'legacy route cannot reset printed to pending');
    assert.equal((await call(queueHandler,'GET')).data.pedidos.length,0);
  }finally{
    Module._load=originalLoad;global.fetch=originalFetch;
    for(const [key,value] of Object.entries(savedEnvironment)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await db.close();
  }
});
