const {enabled,submitPayment,identifier,safeError} = require('../lib/mp-checkout');
const {headers,sameOrigin,rateLimit,jsonBody} = require('../lib/mp-http');
module.exports = async function handler(req,res) {
  headers(res);
  if(req.method !== 'POST') return res.status(405).json({error:'Método não permitido.'});
  if(!enabled()) return res.status(503).json({error:'Pagamento online indisponível.'});
  if(!sameOrigin(req)) return res.status(403).json({error:'Origem inválida.'});
  if(!rateLimit(req,res,'submit',12)) return res.status(429).json({error:'Muitas tentativas. Aguarde um minuto.'});
  try {
    const body=jsonBody(req);
    if(!identifier(body.id)) return res.status(400).json({error:'Pedido inválido.'});
    return res.status(200).json(await submitPayment(body.id,body.form));
  } catch(error) {
    if(['json_required','body_too_large','invalid_json'].includes(error?.message)) return res.status(error.status).json({error:'Requisição de pagamento inválida.'});
    if(['cartao_invalido','pedido_nao_encontrado','pedido_expirado'].includes(error?.message)) return res.status(400).json({error:'Dados do pagamento inválidos ou pedido expirado.'});
    if(error?.message === 'mp_attempt_requires_reconciliation') return res.status(409).json({status:'processing_unknown',needsNewOrder:false,error:'Esta cobrança já foi iniciada e precisa de conferência. Não faça outro pedido; consulte o pagamento ou entre em contato com a loja.'});
    console.error('[mp] pagamento_falhou',safeError(error));
    if(error?.operation === 'create_order' && error?.status === 400) {
      const message=error.providerHint === 'email' ? 'Confira o e-mail informado no pagamento.'
        : error.providerHint === 'installments' ? 'Confira as parcelas. Débito aceita somente pagamento à vista.'
        : 'Confira os dados do cartão, e-mail e modalidade.';
      return res.status(422).json({error:message + ' Esta tentativa não foi confirmada; confira o extrato antes de iniciar outro pedido.',needsNewOrder:true});
    }
    if(error?.operation === 'create_order' && error?.status === 409) return res.status(409).json({error:'A tentativa já existe. Consulte seu status e confira o extrato antes de iniciar outro pedido.',needsNewOrder:false});
    if(error?.status === 403) return res.status(503).json({error:'O Mercado Pago negou a cobrança. A integração precisa ser revisada. Confira o extrato antes de tentar novamente.',blockedByProvider:true});
    return res.status(503).json({error:'Não foi possível verificar o pagamento. Consulte o status antes de tentar novamente.'});
  }
};
