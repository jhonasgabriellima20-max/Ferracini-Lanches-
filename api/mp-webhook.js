const crypto=require('crypto');
const {enabled,getOrder,reconcile}=require('../lib/mp-checkout');
function validSignature(req,id){
  const secret=process.env.MP_WEBHOOK_SECRET;
  if(!secret) return false;
  const header=String(req.headers['x-signature']||'');
  const requestId=String(req.headers['x-request-id']||'');
  const ts=header.match(/(?:^|,)\s*ts=([0-9]{1,20})/i)?.[1];
  const v1=header.match(/(?:^|,)\s*v1=([a-f0-9]{64})/i)?.[1];
  if(!ts||!v1||!requestId||requestId.length>200) return false;
  // Order webhooks may send millisecond timestamps; payment webhooks used seconds.
  const time=Number(ts);
  const milliseconds=ts.length>=13 ? time : time*1000;
  if(!Number.isSafeInteger(milliseconds)||Math.abs(Date.now()-milliseconds)>10*60*1000) return false;
  const message='id:'+String(id).toLowerCase()+';request-id:'+requestId+';ts:'+ts+';';
  const expected=crypto.createHmac('sha256',secret).update(message).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(v1,'hex'));
}
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET') return res.status(200).send('ok');
  if(req.method!=='POST') return res.status(405).send('method not allowed');
  if(!enabled()) return res.status(503).send('disabled');
  const id=String(req.query?.['data.id']||req.query?.data_id||req.body?.data?.id||'');
  const topic=String(req.body?.type||req.query?.type||'');
  if(topic!=='order') return res.status(200).send('ignored');
  if(!/^[a-zA-Z0-9_-]{10,80}$/.test(id)||!validSignature(req,id))
    return res.status(401).send('invalid signature');
  try{
    const order=await getOrder(id);
    if(order?.id===id) await reconcile(order);
    return res.status(200).send('ok');
  }catch(error){
    console.error('[mp] webhook_falhou',{reason:String(error?.message||error)});
    return res.status(503).send('retry');
  }
};
