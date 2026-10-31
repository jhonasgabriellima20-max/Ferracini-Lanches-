const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const Module=require('node:module');
const {PGlite}=require('@electric-sql/pglite');
const {backfillOrderIndex}=require('../lib/order-index-backfill');

test('migração usa SQL real, é atômica, preserva índices e recupera pedidos antigos',async t=>{
  const db=new PGlite();
  try{
    await db.exec('CREATE TABLE public.ferracini_store(pathname text PRIMARY KEY,value jsonb NOT NULL,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())');
    const insert=async(pathname,value)=>db.query('INSERT INTO public.ferracini_store(pathname,value) VALUES ($1,$2)',[pathname,JSON.stringify(value)]);
    let statements=0;
    const sql={query:async(query,params)=>{statements++;return (await db.query(query,params)).rows;}};
    function reservation(clientRequestId,day='2026-10-01',namespace=''){
      const id=crypto.createHash('sha256').update(clientRequestId).digest('hex');
      const path=namespace+'pedidos/aguardando/'+day+'/'+id+'.json';
      const queuePath=namespace+'pedidos/fila/'+day+'/'+id+'.json';
      const value={id,clientRequestId,data:day,criadoEm:day+'T22:00:00Z',status:'confirmado',
        confirmadoPath:queuePath,numero:'07',numeroSequencial:7,referencia:'BACKFILL07',
        cliente:{nome:'Cliente Teste',telefone:'43999999999'},
        itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],
        atendimento:{tipo:'retirada',taxaServicoCentavos:300},pagamento:{metodo:'dinheiro',precisaTroco:false},
        subtotalCentavos:1200,totalCentavos:1500};
      return {id,path,queuePath,value,indexPath:namespace+'pedidos/indice/'+id+'.json'};
    }
    const countIndexes=async(namespace='')=>Number((await db.query('SELECT count(*) AS n FROM public.ferracini_store WHERE left(pathname,length($1))=$1',[namespace+'pedidos/indice/'])).rows[0].n);
    const contents=async()=>JSON.stringify((await db.query('SELECT pathname,value,created_at::text,updated_at::text FROM public.ferracini_store ORDER BY pathname')).rows);
    const reset=()=>db.exec('TRUNCATE public.ferracini_store');

    await t.test('dry-run não altera nada, apply é repetível e re-POST antigo mantém a comanda',async()=>{
      const old=reservation('old-reservation-before-permanent-index');
      await insert(old.path,old.value);
      await insert(old.queuePath,{...old.value,status:'pendente'});
      const before=await contents();
      statements=0;
      let dry;
      await db.exec('BEGIN READ ONLY');
      try{dry=await backfillOrderIndex(sql);}finally{await db.exec('ROLLBACK');}
      assert.equal(statements,1,'o diagnóstico lê o conjunto completo em um único statement');
      assert.deepEqual(dry,{mode:'dry-run',blocked:false,reservations:1,invalid_reservations:0,duplicate_ids:0,conflicting_indices:0,already_indexed:0,inserted:0});
      assert.equal(await contents(),before,'dry-run é somente SELECT e não altera dados ou timestamps');
      statements=0;
      const applied=await backfillOrderIndex(sql,{apply:true});
      assert.equal(statements,1,'validação e inserção pertencem ao mesmo statement');
      assert.equal(applied.inserted,1);
      assert.equal(applied.blocked,false);
      const indexed=await contents();
      const repeat=await backfillOrderIndex(sql,{apply:true});
      assert.equal(repeat.inserted,0);
      assert.equal(repeat.already_indexed,1);
      assert.equal(await contents(),indexed,'apply repetido não sobrescreve sequer o timestamp de índices existentes');

      const originalLoad=Module._load;
      const storage={
        isStorageUnavailable:()=>false,
        readJson:async pathname=>({value:(await db.query('SELECT value FROM public.ferracini_store WHERE pathname=$1',[pathname])).rows[0]?.value||null}),
        writeJson:async(pathname,value,{allowOverwrite})=>{
          if(allowOverwrite) await db.query('INSERT INTO public.ferracini_store(pathname,value) VALUES ($1,$2) ON CONFLICT(pathname) DO UPDATE SET value=EXCLUDED.value',[pathname,JSON.stringify(value)]);
          else try{await insert(pathname,value);}catch(error){if(error.code==='23505')throw Object.assign(new Error('conflict'),{status:409});throw error;}
        },
        listBlobs:async()=>({blobs:[]}),
      };
      Module._load=function(request,parent){
        if(request.endsWith('postgres-storage'))return storage;
        if(request==='./disponibilidade'&&parent?.filename.endsWith('/api/pedidos.js'))return {
          readStoreStatus:async()=>({aberto:true}),readServiceAvailability:async()=>({retirada:true,entrega:true}),
          readPrepConfig:async()=>({}),readOrderCatalog:async()=>require('../api/catalogo.json'),
        };
        return originalLoad.apply(this,arguments);
      };
      const oldEnvironment=process.env.VERCEL_ENV;
      const oldFlag=process.env.MP_CARD_CHECKOUT_ENABLED;
      delete process.env.VERCEL_ENV;process.env.MP_CARD_CHECKOUT_ENABLED='false';
      try{
        const handler=require('../api/pedidos');
        const response={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
        await handler({method:'POST',query:{},headers:{origin:'https://ferracinilanches.com.br','content-type':'application/json'},body:{
          clientRequestId:old.value.clientRequestId,cliente:old.value.cliente,itens:old.value.itens,
          atendimento:{tipo:'retirada'},pagamento:{metodo:'dinheiro'},
        }},response);
        assert.equal(response.statusCode,200);
        assert.equal(response.body.duplicado,true);
        assert.equal(response.body.pedido.id,old.id);
        assert.equal(response.body.pedido.numero,'07');
        assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.ferracini_store WHERE pathname LIKE 'pedidos/fila/%'")).rows[0].n),1);
        assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.ferracini_store WHERE pathname LIKE 'pedidos/aguardando/%'")).rows[0].n),1);
      }finally{
        Module._load=originalLoad;
        if(oldEnvironment===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=oldEnvironment;
        if(oldFlag===undefined)delete process.env.MP_CARD_CHECKOUT_ENABLED;else process.env.MP_CARD_CHECKOUT_ENABLED=oldFlag;
      }
    });

    await t.test('duplicidade histórica impede todos os inserts, inclusive pedidos únicos',async()=>{
      await reset();
      const first=reservation('historical-duplicate-id','2026-10-01');
      const second=reservation('historical-duplicate-id','2026-10-02');
      const unique=reservation('historical-unique-id');
      for(const row of [first,second,unique])await insert(row.path,row.value);
      const before=await contents();
      const report=await backfillOrderIndex(sql,{apply:true});
      assert.equal(report.blocked,true);
      assert.equal(report.duplicate_ids,1);
      assert.equal(report.inserted,0);
      assert.equal(await countIndexes(),0);
      assert.equal(await contents(),before);
    });

    await t.test('data impossível e caminho adulterado bloqueiam o conjunto inteiro',async()=>{
      for(const kind of ['path','date','id']){
        await reset();
        const valid=reservation('valid-alongside-invalid-'+kind);
        const invalid=reservation('invalid-backfill-'+kind,kind==='date'?'2026-02-31':'2026-10-01');
        if(kind==='id')invalid.value.id='not-an-order-id';
        await insert(valid.path,valid.value);
        await insert(kind==='path'?invalid.path.replace('/2026-10-01/','/2026-10-01/../'):invalid.path,invalid.value);
        const before=await contents();
        const report=await backfillOrderIndex(sql,{apply:true});
        assert.equal(report.invalid_reservations,1,kind);
        assert.equal(report.blocked,true);
        assert.equal(report.inserted,0);
        assert.equal(await contents(),before);
      }
    });

    await t.test('índice existente conflitante nunca é sobrescrito nem permite inserção parcial',async()=>{
      await reset();
      const first=reservation('conflicting-old-index');
      const second=reservation('valid-other-old-order');
      await insert(first.path,first.value);await insert(second.path,second.value);
      await insert(first.indexPath,{id:first.id,pathname:'config/unrelated-private-record.json'});
      const before=await contents();
      const report=await backfillOrderIndex(sql,{apply:true});
      assert.equal(report.conflicting_indices,1);
      assert.equal(report.blocked,true);
      assert.equal(report.inserted,0);
      assert.equal(await contents(),before);
    });

    await t.test('Preview só lê e escreve seu namespace, sem ser bloqueado por registros de produção',async()=>{
      await reset();
      const prod1=reservation('duplicate-production','2026-10-01');
      const prod2=reservation('duplicate-production','2026-10-02');
      const preview=reservation('valid-preview','2026-10-01','mp-preview/');
      for(const row of [prod1,prod2,preview])await insert(row.path,row.value);
      const report=await backfillOrderIndex(sql,{namespace:'mp-preview/',apply:true});
      assert.equal(report.blocked,false);
      assert.equal(report.reservations,1);
      assert.equal(report.inserted,1);
      assert.equal(await countIndexes(),0);
      assert.equal(await countIndexes('mp-preview/'),1);
      const production=await backfillOrderIndex(sql);
      assert.equal(production.blocked,true);
      assert.equal(production.duplicate_ids,1);
      await assert.rejects(()=>backfillOrderIndex(sql,{namespace:'other/'}),/invalid_backfill_namespace/);
    });
  }finally{await db.close();}
});
