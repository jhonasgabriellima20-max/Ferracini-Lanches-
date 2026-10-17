const {enabled,findOrder,getPayment,reconcile,identifier}=require('../lib/mp-checkout');
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET') return res.status(405).json({error:'Método não permitido'});
  if(!enabled()) return res.status(503).json({error:'Pagamento indisponível'});
  if(!identifier(req.query?.id)) return res.status(400).json({error:'Referência inválida'});
  try{
    const found=await findOrder(req.query.id);
    if(!found) return res.status(404).json({error:'Pedido não encontrado'});
    const pid=found.order?.pagamento?.mpPaymentId;
    if(pid){
      const payment=await getPayment(pid);
      if(payment.status==='approved'){
        const result=await reconcile(payment);
        if(result?.status==='approved') return res.status(200).json(result);
      }
      return res.status(200).json({status:payment.status==='rejected'?'rejected':'pending'});
    }
    return res.status(200).json({status:'aguardando_pagamento'});
  }catch(error){
    console.error('[mp] status_falhou',{reason:String(error?.message||error)});
    return res.status(503).json({error:'Consulta temporariamente indisponível'});
  }
};
