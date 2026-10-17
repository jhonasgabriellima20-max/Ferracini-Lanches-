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
    console.error('[mp] pagamento_falhou',{
      reason:String(error?.message||error),
      operation:error?.operation||'unknown',
      providerCode:error?.providerCode||'unknown',
      providerField:error?.providerField||'unspecified',
      providerHint:error?.providerHint||'unspecified',
      providerRequestId:error?.providerRequestId||'not_provided'
    });
    if(error?.operation==='create_order' && error?.status===400){
      const message=error?.providerHint==='email'
        ? 'O Mercado Pago rejeitou o e-mail informado. Use seu e-mail pessoal real e válido (sem endereços de teste).'
        : error?.providerHint==='installments'
          ? 'O Mercado Pago rejeitou as parcelas selecionadas. Confira a modalidade e utilize débito somente à vista.'
          : 'O Mercado Pago rejeitou uma informação do pagamento. Confira e-mail, modalidade e dados do cartão.';
      return res.status(422).json({error:message+' Confira se houve cobrança antes de iniciar um novo pedido.',needsNewOrder:true,providerCode:error?.providerCode||'invalid_request'});
    }
    if(error?.operation==='create_order' && error?.status===409){
      return res.status(409).json({error:'Esta tentativa já foi utilizada pelo Mercado Pago. Confira o extrato antes de fazer outro pedido; não reutilize a mesma tentativa.',needsNewOrder:true,providerCode:error?.providerCode||'idempotency_conflict'});
    }
    if(error?.status===403){
      return res.status(503).json({
        error:'O Mercado Pago negou acesso à cobrança (erro 403). A integração precisa de autorização ou correção das credenciais da conta. Confira no Mercado Pago se existe pagamento registrado antes de tentar novamente.',
        blockedByProvider:true
      });
    }
    return res.status(503).json({error:'Não foi possível verificar o pagamento. Confira o status antes de tentar novamente.'});
  }
};
