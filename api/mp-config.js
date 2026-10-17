const {enabled}=require('../lib/mp-checkout');
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET') return res.status(405).json({error:'Método não permitido'});
  const active=enabled();
  return res.status(200).json({enabled:active,publicKey:active?process.env.MP_PUBLIC_KEY:null});
};
