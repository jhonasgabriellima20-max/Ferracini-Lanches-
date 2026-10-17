// Diagnostics for safe checkout initialization only; never receive card details.
const allowed = new Set(['brick_timeout','brick_error','sdk_error','brick_create_error','csp']);
module.exports = async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  if(req.method !== 'POST') return res.status(405).json({error:'method_not_allowed'});
  if(String(req.headers['sec-fetch-site']||'').toLowerCase()==='cross-site') return res.status(403).end();
  const origin=String(req.headers.origin||'');
  if(origin){
    try{const u=new URL(origin);if(u.protocol!=='https:'||u.host!==req.headers.host) return res.status(403).end();}
    catch{return res.status(403).end();}
  }
  if(Number(req.headers['content-length']||0)>800) return res.status(413).end();
  const body=typeof req.body==='string'?(()=>{try{return JSON.parse(req.body)}catch{return {}}})():req.body||{};
  const phase=String(body.phase||'');
  if(!allowed.has(phase)) return res.status(400).end();
  const cause=String(body.cause||'unknown');
  // Report only diagnostic labels. Invalid or free-form text is redacted.
  const safeCause=/^[a-zA-Z0-9._-]{1,85}$/.test(cause)?cause:'redacted';
  console.warn('[mp-frontend]',{phase,cause:safeCause});
  return res.status(204).end();
};
