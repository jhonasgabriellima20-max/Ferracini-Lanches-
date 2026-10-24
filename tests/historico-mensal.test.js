const assert = require('node:assert/strict');
const Module = require('node:module');

const storage = new Map();
let storageOffline = false;
const storageOutage = () => {
  const err = new Error('Armazenamento fora do ar');
  err.code = 'STORAGE_UNAVAILABLE';
  return err;
};
const fakeStorage = {
  isStorageUnavailable: error => error?.code === 'STORAGE_UNAVAILABLE',
  readJson: async path => {
    if(storageOffline) throw storageOutage();
    return { value: storage.get(path) || null };
  },
  writeJson: async (path, value, options) => {
    if(storageOffline) throw storageOutage();
    if(storage.has(path) && !options.allowOverwrite){
      const e = new Error('conflict');
      e.status = 409;
      throw e;
    }
    storage.set(path, structuredClone(value));
  },
  listBlobs: async ({ prefix, limit }) => ({
    blobs: [...storage.keys()]
      .filter(k => k.startsWith(prefix))
      .slice(0, limit)
      .map(pathname => ({ pathname })),
  }),
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain){
  if(request.endsWith('postgres-storage')) return fakeStorage;
  if(request === './disponibilidade' && parent?.filename.endsWith('/api/pedidos.js')){
    return {
      readStoreStatus: async () => ({ aberto: true }),
      readServiceAvailability: async () => ({ entrega: true, retirada: true }),
      readPrepConfig: async () => ({}),
      readOrderCatalog: async () => require('../api/catalogo.json'),
    };
  }
  return originalLoad.apply(this, arguments);
};

const RealDate = Date;
let now = '2026-10-12T02:59:00Z';
global.Date = class extends RealDate { constructor(...args){ super(...(args.length ? args : [now])); } static now(){ return new RealDate(now).getTime(); } };
const pedidosHandler = require('../api/pedidos');
const painelHandler = require('../api/painel-pedidos');
process.env.ADMIN_PASSWORD = 'senha-teste';

function req(method, body = {}, headers = {}, url = '/api/pedidos'){
  return {
    method,
    body,
    headers: {
      origin: 'https://ferracinilanches.com.br',
      'content-type': 'application/json',
      ...headers,
    },
    url,
    query: {},
  };
}

async function call(handler, request){
  const response = {
    headers: {},
    setHeader(k, v){ this.headers[k] = v; },
    status(n){ this.statusCode = n; return this; },
    json(v){ this.body = v; return this; },
  };
  await handler(request, response);
  return response;
}

(async () => {
  const payload = n => ({clientRequestId: 'monthly-test-order-'+n, origem:'mesa', cliente:{nome:'Teste',telefone:'43999999999'}, itens:[{nome:'Dog Simples',quantidade:1,precoUnitarioCentavos:1200,adicionais:[]}],atendimento:{tipo:'mesa',mesa:1}});
  storage.set('config/pedidos-sequencia.json', {data:'2026-10-11',ultimo:42});
  let r=await call(pedidosHandler, req('POST',payload(1)));
  assert.equal(r.body.pedido.numero,'43');
  now='2026-10-12T03:01:00Z';
  r=await call(pedidosHandler, req('POST',payload(2)));
  assert.equal(r.body.pedido.numero,'44');
  assert.equal(r.body.pedido.data,'2026-10-11');
  now='2026-10-12T21:00:00Z';
  r=await call(pedidosHandler, req('POST',payload(3)));
  assert.equal(r.body.pedido.numero,'01');
  assert.equal(r.body.pedido.data,'2026-10-12');
  const concurrent = await Promise.all([4,5,6].map(n => call(pedidosHandler, req('POST',payload(n)))));
  assert.deepEqual(concurrent.map(r=>r.body.pedido.numero).sort(), ['02','03','04']);
  r=await call(pedidosHandler, req('POST',payload(3)));
  assert.equal(r.body.pedido.numero,'01'); // Retry não ganha outra comanda.
  now='2026-11-01T02:59:00Z';
  r=await call(pedidosHandler, req('POST',payload(7)));
  assert.equal(r.body.pedido.numero,'01');
  now='2026-11-01T03:01:00Z';
  r=await call(pedidosHandler, req('POST',payload(8)));
  assert.equal(r.body.pedido.numero,'02');
  assert.equal(r.body.pedido.data,'2026-10-31');
  const auth={'x-admin-password':'senha-teste'};
  r=await call(painelHandler,req('GET',{},auth,'/api/painel-pedidos'));
  assert.equal(r.body.data,'2026-10-31');
  assert.equal(r.body.pedidos.length,2);
  now='2026-11-01T09:00:00Z';
  r=await call(painelHandler,req('GET',{},auth,'/api/painel-pedidos'));
  assert.equal(r.body.data,'2026-11-01');
  assert.equal(r.body.pedidos.length,0);
  r=await call(pedidosHandler, req('POST',payload(9)));
  assert.equal(r.body.pedido.numero,'01');
  r=await call(painelHandler,req('GET',{},auth,'/api/painel-pedidos?mes=2026-10&resumo=1'));
  assert.equal(r.body.total,8);
  assert.equal(r.body.dias.find(d=>d.data==='2026-10-11').quantidade,2);
  r=await call(painelHandler,req('GET',{},auth,'/api/painel-pedidos?data=2026-10-11'));
  assert.deepEqual(r.body.pedidos.map(p=>p.numero).sort(),['43','44']);
  for(let i=0;i<1105;i++){
    const id=i.toString(16).padStart(64,'0');
    storage.set('pedidos/fila/2026-10-15/'+id+'.json',{id,numero:String(i+1),criadoEm:'2026-10-15T22:00:00Z',status:'impresso'});
  }
  r=await call(painelHandler,req('GET',{},auth,'/api/painel-pedidos?data=2026-10-15'));
  assert.equal(r.body.pedidos.length,1105);
  r=await call(painelHandler,req('GET',{},auth,'/api/painel-pedidos?mes=2026-10&resumo=1'));
  assert.equal(r.body.total,1113);
  r=await call(painelHandler,req('GET',{}, {},'/api/painel-pedidos?mes=2026-10&resumo=1'));
  assert.equal(r.statusCode,401);
  r=await call(painelHandler,req('GET',{},auth,'/api/painel-pedidos?mes=2026-99&resumo=1'));
  assert.equal(r.statusCode,400);
  console.log('OK - migração, reset diário, concorrência, retry, meia-noite, virada mensal, histórico e autenticação');
})().catch(e=>{console.error(e);process.exitCode=1;});
