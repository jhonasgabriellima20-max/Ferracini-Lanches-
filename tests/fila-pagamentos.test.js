const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { PGlite } = require('@electric-sql/pglite');

test('SQL real: apenas pagamentos verificados são reivindicados; rollback e Preview não liberam pendências', async () => {
  const db = new PGlite();
  try{
    await db.exec('CREATE TABLE public.ferracini_store (pathname text PRIMARY KEY, value jsonb NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())');
    const day = '2026-10-23';
    const queue = id => `pedidos/fila/${day}/${id}.json`;
    const waiting = id => `pedidos/aguardando/${day}/${id}.json`;
    const insert = async (pathname, value) => db.query('INSERT INTO public.ferracini_store(pathname,value) VALUES ($1,$2)', [pathname,JSON.stringify(value)]);
    const online = id => ({id,data:day,status:'pendente',tentativasImpressao:0,pagamento:{fluxo:'mercadopago',status:'approved',verified:true,mpOrderId:'ORD'+id.padEnd(12,'0')}});
    await insert(queue('legacy'),{status:'pendente',pagamento:{metodo:'dinheiro'}});
    await insert(queue('mesa'),{status:'pendente',pagamento:{metodo:'no_local'}});
    for(const id of ['approved','pending','unverified','missing','reversed','changed','blocked']){
      const order = online(id);
      if(id==='pending') order.pagamento.status='pending';
      if(id==='unverified') order.pagamento.verified=false;
      await insert(queue(id),order);
      if(id!=='missing'){
        const reservation = structuredClone(order);
        if(id==='reversed') reservation.pagamento.status='rejected';
        await insert(waiting(id),reservation);
      }
    }
    await insert('pedidos/pagamento-bloqueado/blocked.json',{id:'blocked',reason:'refunded'});
    const previousLoad = Module._load;
    Module._load = function(request,parent,isMain){
      if(request==='@neondatabase/serverless') return {neon:()=>({query:async(query,params)=>(await db.query(query,params)).rows})};
      return previousLoad.call(this,request,parent,isMain);
    };
    let handler;
    try{handler=require('../api/fila-impressao');}finally{Module._load=previousLoad;}
    process.env.PRINT_AGENT_TOKEN='sql-fixture-print-token';
    process.env.PRINT_QUEUE_DATABASE_URL='postgresql://fixture@localhost/fixture';
    process.env.PRINT_QUEUE_START_AT='2026-01-01T00:00:00Z';
    process.env.MP_CARD_CHECKOUT_ENABLED='false';
    delete process.env.VERCEL_ENV;
    async function call(method,body){
      const res={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}};
      await handler({method,body,headers:{authorization:'Bearer sql-fixture-print-token','content-type':'application/json'},query:{}},res);
      return res;
    }
    const listed=await call('GET');
    assert.equal(listed.statusCode,200);
    assert.deepEqual(listed.data.pedidos.map(order=>order.pathname).sort(),['approved','changed','legacy','mesa'].map(queue).sort());
    for(const id of ['pending','unverified','missing','reversed','blocked']){
      assert.equal((await call('PATCH',{pathname:queue(id),status:'imprimindo'})).statusCode,409,id+' cannot be claimed');
    }
    // Even a receipt fetched before a reversal must be checked again atomically.
    await db.query("UPDATE public.ferracini_store SET value=jsonb_set(value,'{pagamento,status}', '\"rejected\"'::jsonb) WHERE pathname=$1",[waiting('changed')]);
    assert.equal((await call('PATCH',{pathname:queue('changed'),status:'imprimindo'})).statusCode,409);
    assert.equal((await call('PATCH',{pathname:queue('approved'),status:'imprimindo'})).statusCode,200);
    assert.equal((await call('PATCH',{pathname:queue('approved'),status:'imprimindo'})).statusCode,409);
    assert.equal((await call('PATCH',{pathname:queue('approved'),status:'impresso'})).statusCode,200);
    process.env.VERCEL_ENV='preview';
    assert.equal((await call('GET')).statusCode,403);
    assert.equal((await call('PATCH',{pathname:queue('legacy'),status:'imprimindo'})).statusCode,403);
  }finally{await db.close();}
});
