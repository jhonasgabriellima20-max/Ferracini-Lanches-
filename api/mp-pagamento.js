const {enabled,submitPayment,identifier}=require('../lib/mp-checkout');
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST') return res.status(405).json({error:'Método não permitido'});
  if(!enabled()) return res.status(503).json({error:'Pagamento online indisponível.'});
  if(String(req.headers['sec-fetch-site']||'').toLowerCase()==='cross-site') return res.status(403).json({error:'Origem inválida.'});
  const origin=String(req.headers.origin||'');
  if(origin){
    try{
      const u=new URL(origin), host=String(req.headers.host||'').split(':')[0];
      if(u.protocol!=='https:' || u.hostname!==host) return res.status(403).json({error:'Origem inválida.'});
    }catch{return res.status(403).json({error:'Origem inválida.'});}
  }
  if(Number(req.headers['content-length']||0)>12000) return res.status(413).json({error:'Requisição grande demais.'});
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
    if(!identifier(body.id)) return res.status(400).json({error:'Pedido inválido.'});
    const result=await submitPayment(body.id,body.form);
    return res.status(200).json(result);
  }catch(error){
    if(['cartao_invalido','pedido_nao_encontrado'].includes(error?.message)) return res.status(400).json({error:'Dados do pagamento inválidos ou pedido expirado.'});
    console.error('[mp] pagamento_falhou',{reason:String(error?.message||error)});
    return res.status(503).json({error:'Não foi possível verificar o pagamento. Confira o status antes de tentar novamente.'});
  }
};
