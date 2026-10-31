const assert = require('node:assert/strict');
const Module = require('node:module');
const storage = new Map();
const originalLoad = Module._load;
Module._load = function(request,parent) {
  if(request.endsWith('postgres-storage')) return {
    isStorageUnavailable:()=>false,
    readJson:async p=>({value:structuredClone(storage.get(p)||null)}),
    writeJson:async (p,value,options)=>{
      if(storage.has(p)&&!options.allowOverwrite) throw Object.assign(new Error('conflict'),{status:409});
      storage.set(p,structuredClone(value));
    },
    listBlobs:async()=>({blobs:[]}),
  };
  if(request==='./disponibilidade' && parent?.filename.endsWith('/api/pedidos.js')) return {
    readStoreStatus:async()=>({aberto:true}),readServiceAvailability:async()=>({retirada:true,entrega:true}),
    readPrepConfig:async()=>({}),readOrderCatalog:async()=>require('../api/catalogo.json'),
  };
  return originalLoad.apply(this,arguments);
};
process.env.VERCEL_ENV='production';
delete process.env.MP_CARD_CHECKOUT_ENABLED;
delete process.env.MP_ACCESS_TOKEN;
delete process.env.MP_PUBLIC_KEY;
delete process.env.MP_WEBHOOK_SECRET;
const pedidos=require('../api/pedidos');
const config=require('../api/mp-config');
const payment=require('../api/mp-pagamento');
const mp=require('../lib/mp-checkout');
async function call(handler,body={}) {
  const response={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(data){this.body=data;return this;}};
  await handler({method:handler===config?'GET':'POST',body,query:{},headers:{origin:'https://ferracinilanches.com.br','content-type':'application/json',host:'ferracinilanches.com.br'}},response);
  return response;
}
(async()=>{
  assert.equal(mp.enabled(),false);
  assert.equal((await call(config)).body.enabled,false);
  assert.equal((await call(payment)).statusCode,503,'disabled endpoint cannot create a charge');
  const legacy=await call(pedidos,{
    clientRequestId:'legacy-checkout-with-flag-off',cliente:{nome:'Cliente Teste',telefone:'43999999999'},
    itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],
    atendimento:{tipo:'retirada'},pagamento:{metodo:'dinheiro'},
  });
  assert.equal(legacy.statusCode,201,'preparing disabled integration preserves current order flow');
  assert.equal(legacy.body.pedido.status,'pendente');
  assert.equal([...storage.keys()].filter(p=>p.startsWith('pedidos/fila/')).length,1);
  process.env.MP_CARD_CHECKOUT_ENABLED='true';
  const blocked=await call(pedidos,{
    clientRequestId:'enabled-without-credentials',cliente:{nome:'Cliente Teste',telefone:'43999999999'},
    itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],
    atendimento:{tipo:'retirada'},pagamento:{metodo:'credito'},
  });
  assert.equal(blocked.statusCode,503,'explicitly enabled but incomplete integration fails closed');
  assert.equal([...storage.keys()].filter(p=>p.startsWith('pedidos/fila/')).length,1,'missing credentials never release an additional order');
  console.log('OK: flag desligada preserva site atual; cobrança desligada e ativação incompleta bloqueadas');
})().catch(error=>{console.error(error);process.exitCode=1;});
