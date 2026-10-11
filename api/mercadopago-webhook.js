// Mercado Pago Webhook: verify HMAC and fetch payment from provider.
// Never trust event payload (or browser) as proof of payment.
const crypto=require('node:crypto');
const {ready,mercadoPago,conferirPagamento}=require('../lib/mercadopago');
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).end();}
  if(!ready()) return res.status(503).end();
  const signature=String(req.headers['x-signature']||'');
  const requestId=String(req.headers['x-request-id']||'');
  const ts=/\bts=(\d+)\b/.exec(signature)?.[1];
  const value=/\bv1=([a-f0-9]{64})\b/i.exec(signature)?.[1];
  const id=String(req.query?.['data.id'] || req.body?.data?.id || '');
  if(!ts || !value || !requestId || !/^\d{1,30}$/.test(id))return res.status(401).end();
  const manifest='id:'+id.toLowerCase()+';request-id:'+requestId+';ts:'+ts+';';
  const expected=crypto.createHmac('sha256',process.env.MP_WEBHOOK_SECRET)
    .update(manifest).digest('hex');
  if(!crypto.timingSafeEqual(Buffer.from(value.toLowerCase()),Buffer.from(expected))){
    return res.status(401).end();
  }
  if(req.body?.type && req.body.type!=='payment') return res.status(200).json({ok:true});
  try{
    const payment=await mercadoPago('/v1/payments/'+id);
    if(String(payment.id)!==id) return res.status(400).end();
    await conferirPagamento(payment);
    return res.status(200).json({ok:true});
  }catch(err){
    console.error('[mp-webhook] erro', {code:err.code,message:err.message});
    return res.status(503).json({ok:false});
  }
};
