const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const crypto=require('node:crypto');
const {dataOperacao}=require('../assets/dia-operacao');

test('páginas antigas e reservas presenciais não liberam novas comandas sem pagamento online',async()=>{
  const records=new Map();
  const originalLoad=Module._load;
  const storage={
    isStorageUnavailable:()=>false,
    readJson:async pathname=>({value:structuredClone(records.get(pathname)||null)}),
    writeJson:async(pathname,value,options)=>{
      if(records.has(pathname)&&!options.allowOverwrite)throw Object.assign(new Error('conflict'),{status:409});
      records.set(pathname,structuredClone(value));
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
  delete process.env.VERCEL_ENV;
  process.env.MP_CARD_CHECKOUT_ENABLED='true';process.env.MP_ACCESS_TOKEN='TEST-token';
  process.env.MP_PUBLIC_KEY='TEST-public';process.env.MP_WEBHOOK_SECRET='test-secret';
  try{
    const handler=require('../api/pedidos');
    const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
    const day=dataOperacao();
    const draft=(clientRequestId,atendimento={tipo:'retirada'},pagamento={metodo:'credito'})=>({
      clientRequestId,cliente:{nome:'Cliente Teste',telefone:'43999999999'},
      itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],atendimento,pagamento,
    });
    async function call(body){
      const response={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}};
      await handler({method:'POST',body,query:{},headers:{origin:'https://ferracinilanches.com.br','content-type':'application/json','x-real-ip':body.clientRequestId}},response);
      return response;
    }
    const queue=()=>[...records.keys()].filter(path=>path.startsWith('pedidos/fila/'));
    const reservations=()=>[...records.keys()].filter(path=>path.startsWith('pedidos/reservas/'));
    const entrega={tipo:'entrega',distanciaKm:3,taxaEntregaCentavos:900,taxaServicoCentavos:300,
      endereco:{rua:'Rua Teste',numero:'1',bairro:'Centro',cidade:'Londrina',cep:'86010000'}};
    for(const atendimento of [{tipo:'retirada'},entrega])for(const metodo of ['dinheiro','cartao']){
      const before=records.size;
      const rejected=await call(draft('manual-'+atendimento.tipo+'-'+metodo,atendimento,{metodo,fluxo:'presencial'}));
      assert.equal(rejected.statusCode,400);
      assert.equal(rejected.data.pedidoConfirmado,false);
      assert.equal(records.size,before,'neither a price lookup nor a browser flag can enqueue a manual order');
    }
    const pending=await call(draft('browser-faked-approval',undefined,{metodo:'credito',fluxo:'presencial',status:'approved',verified:true,mpOrderId:'ORDFAKEAPPROVAL12345'}));
    assert.equal(pending.statusCode,201);
    assert.equal(pending.data.pedido.status,'aguardando_pagamento');
    const pendingPath='pedidos/aguardando/'+day+'/'+pending.data.pedido.id+'.json';
    assert.deepEqual(records.get(pendingPath).pagamento,{metodo:'credito',fluxo:'mercadopago',status:'pending',verified:false});
    await assert.rejects(()=>handler.confirmarPedido(pending.data.pedido.id),/aguardando pagamento aprovado/);
    assert.equal(queue().length,0);
    assert.equal(reservations().length,0,'an unpaid online reservation receives no receipt number');

    const legacyClient='legacy-unconfirmed-manual';
    const legacyId=hash(legacyClient),legacyPath='pedidos/aguardando/'+day+'/'+legacyId+'.json';
    const legacy={...draft(legacyClient,undefined,{metodo:'dinheiro'}),id:legacyId,data:day,status:'aguardando_whatsapp',criadoEm:new Date().toISOString(),totalCentavos:1500};
    records.set(legacyPath,structuredClone(legacy));
    await assert.rejects(()=>handler.confirmarPedido(legacyId),error=>error.code==='PAYMENT_REQUIRED');
    const replay=await call(draft(legacyClient));
    assert.equal(replay.statusCode,409,'replaying an old unconfirmed manual reservation cannot bypass payment');
    assert.equal(replay.data.pedidoConfirmado,false);
    assert.equal(queue().length,0);
    assert.equal(reservations().length,0);
    assert.equal(records.get(legacyPath).status,'aguardando_whatsapp','do not silently convert historical payment records');

    const oldOfficialClient='historical-official-order';
    const oldOfficialId=hash(oldOfficialClient),officialPath='pedidos/fila/'+day+'/'+oldOfficialId+'.json';
    const official={...draft(oldOfficialClient,undefined,{metodo:'dinheiro'}),id:oldOfficialId,data:day,status:'impresso',numero:'07',criadoEm:new Date().toISOString(),totalCentavos:1500};
    records.set('pedidos/aguardando/'+day+'/'+oldOfficialId+'.json',{...official,status:'confirmado',confirmadoPath:officialPath});
    records.set(officialPath,structuredClone(official));
    assert.equal((await handler.confirmarPedido(oldOfficialId)).status,'impresso','existing official history remains readable');
    assert.equal(queue().length,1);
    assert.deepEqual(records.get(officialPath),official,'historical official orders are not reset or reprinted');
  }finally{Module._load=originalLoad;}
});
