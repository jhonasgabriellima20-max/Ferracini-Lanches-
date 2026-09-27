const assert = require('node:assert/strict');
const storagePath = require.resolve('../lib/postgres-storage');
const dados = new Map();
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true,
  exports: {
    isStorageUnavailable: () => false,
    readJson: async pathname => ({value:dados.get(pathname) ?? null}),
    writeJson: async (pathname,value,options={}) => {
      if(!options.allowOverwrite && dados.has(pathname)){
        const err = new Error('conflict'); err.status = 409; throw err;
      }
      dados.set(pathname, structuredClone(value));
    },
    listBlobs: async () => ({blobs:[]}),
  },
};
const pedidos = require('../api/pedidos');
(async () => {
  const payload = {
    clientRequestId:'pedido-de-teste-12345678',
    cliente:{nome:'Teste',telefone:'43999999999'},
    itens:[{nome:'X-Salada',quantidade:1}],
    atendimento:{tipo:'retirada',tempoInternoMinutos:5},
    totalCentavos:2000,
  };
  const preparado = await pedidos.prepararPedidoWhatsapp(payload);
  assert.match(preparado.rascunho.referencia, /^F[A-F0-9]{10}$/);
  assert.equal([...dados.keys()].filter(x=>x.startsWith('pedidos/fila/')).length, 0);
  assert.equal([...dados.keys()].filter(x=>x.startsWith('pedidos/reservas/')).length, 0);
  const repetido = await pedidos.prepararPedidoWhatsapp(payload);
  assert.equal(repetido.duplicado, true);
  const pathname = [...dados.keys()].find(x=>x.startsWith('pedidos/aguardando-whatsapp/'));
  const confirmado = await pedidos.confirmarPedidoWhatsapp(pathname);
  assert.equal(confirmado.numero, '01');
  assert.equal([...dados.keys()].filter(x=>x.startsWith('pedidos/fila/')).length, 1);
  const novamente = await pedidos.confirmarPedidoWhatsapp(pathname);
  assert.equal(novamente.numero, '01');
  assert.equal([...dados.keys()].filter(x=>x.startsWith('pedidos/fila/')).length, 1);
  console.log('OK - WhatsApp não enviado: sem comanda; confirmação gera uma única comanda');
})().catch(err=>{console.error(err);process.exitCode=1;});
