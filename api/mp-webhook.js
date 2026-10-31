const crypto = require('node:crypto');
const {canReconcile,getOrder,reconcile,safeError} = require('../lib/mp-checkout');
const {headers,jsonBody} = require('../lib/mp-http');
function validSignature(req,id) {
  const secret=process.env.MP_WEBHOOK_SECRET;
  if(!secret) return false;
  const signature=String(req.headers['x-signature'] || '');
  const requestId=String(req.headers['x-request-id'] || '');
  const ts=signature.match(/(?:^|,)\s*ts=([0-9]{1,20})(?=,|$)/i)?.[1];
  const v1=signature.match(/(?:^|,)\s*v1=([a-f0-9]{64})(?=,|$)/i)?.[1];
  if(!ts || !v1 || !requestId || requestId.length > 200 || /[;\r\n]/.test(requestId)) return false;
  const milliseconds=ts.length >= 13 ? Number(ts) : Number(ts)*1000;
  if(!Number.isSafeInteger(milliseconds) || Math.abs(Date.now()-milliseconds) > 10*60*1000) return false;
  const message='id:' + id.toLowerCase() + ';request-id:' + requestId + ';ts:' + ts + ';';
  const expected=crypto.createHmac('sha256',secret).update(message).digest();
  return crypto.timingSafeEqual(expected,Buffer.from(v1,'hex'));
}
module.exports = async function handler(req,res) {
  headers(res);
  if(req.method === 'GET') return res.status(200).send('ok');
  if(req.method !== 'POST') return res.status(405).send('method not allowed');
  if(!canReconcile()) return res.status(503).send('disabled');
  let body;
  try { body=jsonBody(req,16000); } catch(error) { return res.status(error.status || 400).send('invalid body'); }
  // Mercado Pago's manifest signs data.id from the query string. An unsigned
  // fallback to body.data.id would let a signature authorize a different order.
  const id=req.query?.['data.id'];
  if(typeof id !== 'string' || !/^[a-zA-Z0-9_-]{10,80}$/.test(id) || !validSignature(req,id)) return res.status(401).send('invalid signature');
  if(body.data?.id != null && String(body.data.id) !== id) return res.status(400).send('id mismatch');
  if(String(body.type || req.query?.type || '') !== 'order') return res.status(200).send('ignored');
  try {
    await reconcile(await getOrder(id));
    return res.status(200).send('ok');
  } catch(error) {
    console.error('[mp] webhook_falhou',safeError(error));
    return res.status(503).send('retry');
  }
};
module.exports.validSignature = validSignature;
