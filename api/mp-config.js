const {enabled} = require('../lib/mp-checkout');
const {headers} = require('../lib/mp-http');
module.exports = async function handler(req,res) {
  headers(res);
  if(req.method !== 'GET') return res.status(405).json({error:'Método não permitido.'});
  const active = enabled();
  // A Preview URL is not proof that credentials are for test accounts.
  const requested = process.env.MP_CARD_CHECKOUT_ENABLED === 'true';
  return res.status(200).json({enabled:active, requested, configurationError:requested && !active, preview:process.env.VERCEL_ENV === 'preview', publicKey:active ? process.env.MP_PUBLIC_KEY : null});
};
