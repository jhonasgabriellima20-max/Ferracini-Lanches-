const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;
const cutoff = '2026-10-10T15:00:00.000Z';
process.env.PRINT_AGENT_TOKEN = 'token-test-with-more-than-twenty-characters';
process.env.PRINT_QUEUE_DATABASE_URL = 'postgresql://fake:fake@local/fake';
process.env.PRINT_QUEUE_START_AT = cutoff;
const store = Array.from({length: 305}, (_, i) => ({
  pathname: 'pedidos/fila/2026-10-10/' + String(i).padStart(8, '0') + '.json',
  createdAt: new Date(Date.parse(cutoff) + i * 1000).toISOString(),
  value: { numero: i + 1, criadoEm: new Date(Date.parse(cutoff) + i * 1000).toISOString(),
    status: i < 300 ? 'impresso' : 'pendente', tentativasImpressao: 0 }
}));

Module._load = function(request, parent, isMain) {
  if (request === '@neondatabase/serverless') {
    return {
      neon: () => ({
        query: async (query, params) => {
          if (query.startsWith('SELECT')) {
            const [after, limit] = params;
            return store.filter(x => x.createdAt >= after && x.value.status === 'pendente')
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .slice(0, limit).map(x => ({pathname:x.pathname, value:{...x.value}}));
          }
          if (query.startsWith('UPDATE')) {
            const [status, updatedAt, increment, printerError, pathname, after, from] = params;
            const rec = store.find(x=>x.pathname===pathname && x.createdAt>=after && x.value.status===from);
            if (!rec) return [];
            Object.assign(rec.value, {status, atualizadoEm: updatedAt,
              tentativasImpressao: rec.value.tentativasImpressao + increment});
            if (status === 'impresso') rec.value.impressoEm = updatedAt;
            if (status === 'falhou') rec.value.erroImpressao = printerError;
            return [{pathname}];
          }
          throw Error('SQL inesperado');
        }
      })
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const handler = require(path.resolve(__dirname, '../api/fila-impressao.js'));
Module._load = originalLoad;

async function call(method, body, opts={}) {
  const req={method, body, query:opts.query||{},
    headers:{authorization: opts.token === false ? '' : 'Bearer '+process.env.PRINT_AGENT_TOKEN,
      'content-type':'application/json'}};
  const res={headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;return this;},
    status(c){this.statusCode=c;return this;},json(payload){this.data=payload;return this;}};
  await handler(req,res);
  return res;
}
(async()=>{
  const unauth = await call('GET',null,{token:false});
  assert.equal(unauth.statusCode,401,'Fila exige token');

  const first = await call('GET',null,{query:{limit:'1000'}});
  assert.equal(first.statusCode,200);
  assert.equal(first.data.pedidos.length,5,'A fila ignora 300 pedidos ja impressos');
  const pedido=first.data.pedidos[0];
  const pathname=pedido.pathname;
  let r=await call('PATCH',{pathname,status:'imprimindo'});
  assert.equal(r.statusCode,200,'Primeira reivindicacao autorizada');
  r=await call('PATCH',{pathname,status:'imprimindo'});
  assert.equal(r.statusCode,409,'Reivindicacao duplicada bloqueada');
  r=await call('PATCH',{pathname,status:'impresso'});
  assert.equal(r.statusCode,200,'Impresso marcado');
  r=await call('PATCH',{pathname,status:'impresso'});
  assert.equal(r.statusCode,409,'ACK duplicado bloqueado');
  const remaining=await call('GET');
  assert.equal(remaining.data.pedidos.length,4);
  r=await call('PATCH',{pathname:'pedidos/fila/2026-10-10/../../wrong.json',status:'imprimindo'});
  assert.equal(r.statusCode,400);
  console.log('OK: consulta de alta demanda, autenticacao, reivindicacao atomica e ACK validado.');
})().catch(err=>{console.error(err);process.exitCode=1;});
