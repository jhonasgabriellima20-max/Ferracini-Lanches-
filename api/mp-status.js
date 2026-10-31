const {canReconcile,findOrder,getOrder,reconcile,identifier,safeError,readValidationFailure,unknownResponse} = require('../lib/mp-checkout');
const {headers,sameOrigin,rateLimit} = require('../lib/mp-http');
module.exports = async function handler(req,res) {
  headers(res);
  if(req.method !== 'GET') return res.status(405).json({error:'Método não permitido.'});
  if(!canReconcile()) return res.status(503).json({error:'Pagamento indisponível.'});
  if(!sameOrigin(req)) return res.status(403).json({error:'Origem inválida.'});
  if(!rateLimit(req,res,'status',45)) return res.status(429).json({error:'Aguarde antes de consultar novamente.'});
  if(!identifier(req.query?.id)) return res.status(400).json({error:'Referência inválida.'});
  try {
    const found=await findOrder(req.query.id);
    if(!found || found.order.pagamento?.fluxo !== 'mercadopago') return res.status(404).json({error:'Pedido não encontrado.'});
    const id=found.order.pagamento.mpOrderId;
    if(!id) {
      const validation=await readValidationFailure(found.order.id);
      return res.status(200).json(validation || (found.order.pagamento.tentativaIniciadaEm ? unknownResponse() : {status:'aguardando_pagamento'}));
    }
    const result=await reconcile(await getOrder(id));
    return res.status(200).json(result || {status:'pending'});
  } catch(error) {
    console.error('[mp] status_falhou',safeError(error));
    return res.status(503).json({error:'Consulta temporariamente indisponível.'});
  }
};
