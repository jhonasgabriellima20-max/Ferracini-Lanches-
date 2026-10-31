const {headers,sameOrigin,rateLimit,jsonBody} = require('../lib/mp-http');
const allowed = new Set(['brick_timeout','brick_error','sdk_error','brick_create_error','csp']);
module.exports = async function handler(req,res) {
  headers(res);
  if(req.method !== 'POST') return res.status(405).json({error:'Método não permitido.'});
  if(!sameOrigin(req)) return res.status(403).json({error:'Origem inválida.'});
  if(!rateLimit(req,res,'diagnostics',20)) return res.status(429).json({error:'Aguarde antes de tentar novamente.'});
  let body;
  try { body=jsonBody(req,800); } catch(error) { return res.status(error.status || 400).json({error:'Diagnóstico inválido.'}); }
  if(!allowed.has(body.phase)) return res.status(400).json({error:'Diagnóstico inválido.'});
  // Fixed vocabulary only: never log arbitrary customer-supplied strings.
  const cause = new Set(['unknown','timeout','sdk_unavailable','brick_failed','csp_blocked']).has(body.cause) ? body.cause : 'redacted';
  console.warn('[mp-frontend]',{phase:body.phase,cause});
  return res.status(204).end();
};
