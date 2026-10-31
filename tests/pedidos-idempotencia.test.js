const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const Module=require('node:module');

test('idempotência presencial atravessa meia-noite e expedientes sem repetir comanda',async()=>{
  const storage=new Map(),reads=[];
  const fakeStorage={
    isStorageUnavailable:()=>false,
    readJson:async pathname=>{reads.push(pathname);return {value:structuredClone(storage.get(pathname)||null)};},
    writeJson:async(pathname,value,options)=>{
      if(storage.has(pathname)&&!options.allowOverwrite)throw Object.assign(new Error('conflict'),{status:409});
      storage.set(pathname,structuredClone(value));
    },
    listBlobs:async({prefix,limit})=>({blobs:[...storage.keys()].filter(p=>p.startsWith(prefix)).slice(0,limit).map(pathname=>({pathname}))}),
  };
  const originalLoad=Module._load;
  const RealDate=Date;
  let now='2026-10-30T22:00:00Z';
  global.Date=class extends RealDate{
    constructor(...args){super(...(args.length?args:[now]));}
    static now(){return new RealDate(now).getTime();}
  };
  Module._load=function(request,parent){
    if(request.endsWith('postgres-storage'))return fakeStorage;
    if(request==='./disponibilidade'&&parent?.filename.endsWith('/api/pedidos.js'))return {
      readStoreStatus:async()=>({aberto:true}),readServiceAvailability:async()=>({retirada:true,entrega:true}),
      readPrepConfig:async()=>({}),readOrderCatalog:async()=>require('../api/catalogo.json'),
    };
    return originalLoad.apply(this,arguments);
  };
  delete process.env.VERCEL_ENV;
  process.env.MP_CARD_CHECKOUT_ENABLED='false';
  try{
    const pedidos=require('../api/pedidos');
    const indexed=require('../lib/order-reservations');
    const body=clientRequestId=>({clientRequestId,cliente:{nome:'Cliente Teste',telefone:'43999999999'},
      itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],
      atendimento:{tipo:'retirada'},pagamento:{metodo:'dinheiro'}});
    async function call(clientRequestId){
      const res={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(data){this.body=data;return this;}};
      await pedidos({method:'POST',body:body(clientRequestId),query:{},headers:{'content-type':'application/json',origin:'https://ferracinilanches.com.br','x-real-ip':clientRequestId}},res);
      return res;
    }
    const queue=()=>[...storage.entries()].filter(([p])=>p.startsWith('pedidos/fila/'));
    const original=await call('presencial-retry-across-operational-days');
    assert.equal(original.statusCode,201);
    assert.equal(original.body.pedido.numero,'01');
    assert.equal(original.body.pedido.data,'2026-10-30');
    assert.equal(storage.get(indexed.indexPath(original.body.pedido.id)).pathname,'pedidos/aguardando/2026-10-30/'+original.body.pedido.id+'.json');

    now='2026-10-31T03:01:00Z'; // 00h01 São Paulo, still the previous workday.
    const midnight=await call('presencial-new-order-after-midnight');
    assert.equal(midnight.statusCode,201);
    assert.equal(midnight.body.pedido.numero,'02');
    assert.equal(midnight.body.pedido.data,'2026-10-30');
    const midnightReplay=await call('presencial-retry-across-operational-days');
    assert.equal(midnightReplay.statusCode,200);
    assert.equal(midnightReplay.body.duplicado,true);
    assert.equal(midnightReplay.body.pedido.id,original.body.pedido.id);
    assert.equal(midnightReplay.body.pedido.numero,'01');
    assert.equal(queue().length,2);

    now='2026-10-31T09:00:00Z'; // 06h São Paulo starts a new operational day.
    const nextDay=await call('presencial-new-operational-day');
    assert.equal(nextDay.statusCode,201);
    assert.equal(nextDay.body.pedido.numero,'01');
    assert.equal(nextDay.body.pedido.data,'2026-10-31');
    const nextDayReplay=await call('presencial-retry-across-operational-days');
    assert.equal(nextDayReplay.statusCode,200);
    assert.equal(nextDayReplay.body.duplicado,true);
    assert.equal(nextDayReplay.body.pedido.id,original.body.pedido.id);
    assert.equal(nextDayReplay.body.pedido.data,'2026-10-30');
    assert.equal(queue().length,3,'retry from yesterday cannot create a second receipt');

    now='2026-11-09T22:00:00Z';
    const late=await call('presencial-retry-across-operational-days');
    assert.equal(late.statusCode,200);
    assert.equal(late.body.duplicado,true);
    assert.equal(late.body.pedido.id,original.body.pedido.id);
    assert.equal(late.body.pedido.numero,'01');
    assert.equal(late.body.pedido.data,'2026-10-30');
    assert.equal(queue().length,3,'ten-day replay resolves permanent index instead of scanning recent dates');
    const fresh=await call('presencial-new-order-ten-days-later');
    assert.equal(fresh.statusCode,201);
    assert.equal(fresh.body.pedido.numero,'01');
    assert.equal(fresh.body.pedido.data,'2026-11-09');

    const concurrent=await Promise.all([call('presencial-simultaneous-identical-request'),call('presencial-simultaneous-identical-request')]);
    assert.deepEqual(concurrent.map(r=>r.statusCode).sort(),[200,201]);
    assert.equal(concurrent[0].body.pedido.id,concurrent[1].body.pedido.id);
    assert.equal(concurrent[0].body.pedido.numero,concurrent[1].body.pedido.numero);
    assert.equal(queue().length,5,'two concurrent requests create only one additional queue record');

    const maliciousClient='presencial-malicious-index-reference';
    const maliciousId=crypto.createHash('sha256').update(maliciousClient).digest('hex');
    storage.set(indexed.indexPath(maliciousId),{id:maliciousId,pathname:'config/not-a-reservation.json'});
    const priorReads=reads.length;
    const invalid=await call(maliciousClient);
    assert.equal(invalid.statusCode,503,'invalid index fails closed instead of registering another order');
    assert.equal(reads.slice(priorReads).includes('config/not-a-reservation.json'),false);
    assert.equal(queue().length,5);
  }finally{
    Module._load=originalLoad;
    global.Date=RealDate;
  }
});
