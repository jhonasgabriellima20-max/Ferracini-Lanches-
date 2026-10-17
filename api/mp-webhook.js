const crypto=require('crypto');
const {enabled,getPayment,reconcile}=require('../lib/mp-checkout');
function validSignature(req,id){
  const secret=process.env.MP_WEBHOOK_SECRET;
  if(!secret) return false; // Fail closed até o webhook ser configurado.
  const header=String(req.headers['x-signature']||'');
  const requestId=String(req.headers['x-request-id']||'');
  const ts=header.match(/(?:^|,)ts=([0-9]{1,20})/i)?.[1];
  const v1=header.match(/(?:^|,)v1=([a-f0-9]{64})/i)?.[1];
  if(!ts || !v1 || !requestId) return false;
  if(Math.abs(Date.now()-Number(ts)*1000)>10*60*1000) return false;
  const value='id:'+String(id).toLowerCase()+';request-id:'+requestId+';ts:'+ts+';';
  const calc=crypto.createHmac('sha256',secret).update(value).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(calc),Buffer.from(v1.toLowerCase()));
}
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET') return res.status(200).send('ok');
  if(req.method!=='POST') return res.status(405).send('method not allowed');
  if(!enabled()) return res.status(503).send('disabled');
  const id=String(req.query?.['data.id']||req.query?.data_id||req.body?.data?.id||'');
  const topic=String(req.body?.type||req.query?.type||'');
  if(topic!=='payment') return res.status(200).send('ignored');
  if(!/^\d{1,24}$/.test(id) || !validSignature(req,id)) return res.status(401).send('invalid signature');
  try{
    const payment=await getPayment(id);
    if(payment?.status==='approved') await reconcile(payment);
    return res.status(200).send('ok');
  }catch(error){
    console.error('[mp] webhook_falhou',{reason:String(error?.message||error)});
    return res.status(503).send('retry');
  }
};
