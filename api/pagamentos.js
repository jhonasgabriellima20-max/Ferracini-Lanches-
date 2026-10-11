// Payment Brick backend. A Mercado Pago-approved charge is required to queue
// deliveries and pickups. Direct /api/pedidos remains available for mesa only.
const crypto=require('node:crypto');
const {readJson,writeJson}=require('../lib/postgres-storage');
const {ready,requestId,mercadoPago,procurarPedido,conferirPagamento,respostaPublica}=require('../lib/mercadopago');
const orders=require('./pedidos');
const disponibilidade=require('./disponibilidade');
const {calcularTempoInternoLanches}=require('../lib/prep-estimator');

function error(res,status,message){return res.status(status).json({error:message});}
function method(req){return String(req.headers?.['content-type']||'').toLowerCase().includes('application/json');}
function validEmail(v){return typeof v==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length<=160;}

function paymentPayload(form,order){
  const name=String(form?.payment_method_id||'');
  const pix=name==='pix';
  if(!pix && (!/^[a-z0-9_-]{2,50}$/i.test(name) ||
    !/^[a-zA-Z0-9_-]{10,200}$/.test(String(form?.token||'')))) {
    throw new Error('Dados do cartão inválidos.');
  }
  const email=form?.payer?.email;
  if(!validEmail(email)) throw new Error('Informe um e-mail válido no pagamento.');
  const identification=form?.payer?.identification;
  const payer={email};
  if(identification?.type && identification?.number){
    payer.identification={
      type:String(identification.type).slice(0,10),
      number:String(identification.number).replace(/\D/g,'').slice(0,25)
    };
  }
  const out={
    transaction_amount:order.totalCentavos/100,
    description:'Ferracini Lanches - pedido '+order.referencia,
    payment_method_id:name,
    external_reference:order.id,
    notification_url:process.env.MP_WEBHOOK_URL,
    payer,
  };
  if(!pix){
    out.token=String(form.token);
    out.installments=Number.isInteger(Number(form.installments)) &&
      Number(form.installments)>=1 && Number(form.installments)<=12 ?
      Number(form.installments) : 1;
    if(form.issuer_id) out.issuer_id=String(form.issuer_id).slice(0,30);
  }
  return out;
}

module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('X-Robots-Tag','noindex, nofollow');
  if(req.method==='GET'){
    if(req.query?.config==='1'){
      return res.status(200).json({ativo:ready(),
        chavePublica:ready() ? process.env.MP_PUBLIC_KEY : null});
    }
    const id=String(req.query?.id||'');
    if(!/^[a-f0-9]{64}$/.test(id)) return error(res,400,'Referência inválida.');
    if(!ready()) return error(res,503,'Pagamento online ainda não configurado.');
    try{
      const found=await procurarPedido(id);
      if(!found) return error(res,404,'Pedido não encontrado.');
      let {pedido}=found;
      if(pedido.pagamento?.pagamentoId && pedido.pagamento?.status!=='approved'){
        const provider=await mercadoPago('/v1/payments/'+encodeURIComponent(pedido.pagamento.pagamentoId));
        await conferirPagamento(provider);
        pedido=(await procurarPedido(id)).pedido;
      }
      const confirmedPath=pedido.confirmadoPath;
      const confirmado=confirmedPath ? (await readJson(confirmedPath)).value : null;
      return res.status(200).json(respostaPublica(pedido,confirmado));
    }catch(err){
      console.error('[pagamento] consulta_falhou', {code:err.code,message:err.message});
      return error(res,503,'Não foi possível conferir o pagamento agora.');
    }
  }
  if(req.method!=='POST'){
    res.setHeader('Allow','GET, POST');
    return error(res,405,'Método não permitido.');
  }
  if(!ready()) return error(res,503,'Pagamento online ainda não configurado.');
  if(!orders.origemPermitida(req)) return error(res,403,'Origem não permitida.');
  if(!method(req)) return error(res,415,'Envie JSON.');
  if(Number(req.headers?.['content-length']||0)>65536)return error(res,413,'Solicitação muito grande.');
  try{
    const input=typeof req.body==='string' ? JSON.parse(req.body) : req.body||{};
    const horario=await disponibilidade.readStoreStatus();
    if(!horario.aberto) return error(res,403,horario.mensagem||'Loja fechada.');
    const catalogo=await disponibilidade.readOrderCatalog();
    const payload=orders.validarPayload(input.pedido,catalogo);
    if(!['entrega','retirada'].includes(payload.atendimento.tipo)){
      return error(res,400,'Pagamento no site é para entrega e retirada.');
    }
    const canais=await disponibilidade.readServiceAvailability();
    if(canais[payload.atendimento.tipo]===false) return error(res,403,'Atendimento indisponível.');
    await orders.validarEntregaNoServidor(payload);
    // Verify the items, address and server-recomputed totals on every attempt.
    const registro=await orders.criarPedido(payload);
    const saved=registro.pedido;
    const same=JSON.stringify(saved.cliente)===JSON.stringify(payload.cliente) &&
      JSON.stringify(saved.itens)===JSON.stringify(payload.itens) &&
      saved.atendimento?.tipo===payload.atendimento.tipo &&
      JSON.stringify(saved.atendimento?.endereco||null)===JSON.stringify(payload.atendimento?.endereco||null) &&
      saved.totalCentavos===payload.totalCentavos;
    if(!same) return error(res,409,'Pedido alterado. Inicie um novo pagamento.');
    if(saved.pagamento?.status==='approved'){
      const confirmed=saved.confirmadoPath ? (await readJson(saved.confirmadoPath)).value : null;
      return res.status(200).json(respostaPublica(saved,confirmed));
    }
    if(saved.pagamento?.pagamentoId){
      const provider=await mercadoPago('/v1/payments/'+encodeURIComponent(saved.pagamento.pagamentoId));
      const checked=await conferirPagamento(provider);
      return res.status(200).json({
        ...respostaPublica(saved,checked?.confirmado),
        status:provider.status,
        qrCode:provider.point_of_interaction?.transaction_data?.qr_code||null,
        qrCodeBase64:provider.point_of_interaction?.transaction_data?.qr_code_base64||null,
      });
    }
    // The same deterministic idempotency key prevents duplicate charges on retry.
    const payRequest=paymentPayload(input.pagamento,saved);
    const provider=await mercadoPago('/v1/payments',{
      method:'POST',body:payRequest,idempotency:requestId(saved.id),
    });
    if(!provider?.id || String(provider.external_reference)!==saved.id){
      throw new Error('Pagamento sem referência válida.');
    }
    if(provider.status==='approved'){
      const verified=await mercadoPago('/v1/payments/'+encodeURIComponent(provider.id));
      const checked=await conferirPagamento(verified);
      return res.status(200).json({
        ...respostaPublica(saved,checked?.confirmado),
        status:verified.status,
      });
    }
    const latest=(await procurarPedido(saved.id)).pedido;
    if(latest.pagamento?.status!=='approved'){
      await writeJson(registro.pathname || 'pedidos/aguardando/'+saved.data+'/'+saved.id+'.json',{
        ...latest,status:'aguardando_pagamento',atualizadoEm:new Date().toISOString(),
        pagamento:{metodo:provider.payment_method_id==='pix'?'pix':'cartao',
          provedor:'mercadopago',status:provider.status,
          pagamentoId:String(provider.id)}
      },{allowOverwrite:true});
    }
    return res.status(200).json({
      id:saved.id,status:provider.status,pago:false,
      qrCode:provider.point_of_interaction?.transaction_data?.qr_code||null,
      qrCodeBase64:provider.point_of_interaction?.transaction_data?.qr_code_base64||null,
    });
  }catch(err){
    if(err?.message==='Pedido inválido.' || /inválid|incomplet|não confere|Informe|indisponível|fora da área/i.test(err.message)){
      return error(res,400,err.message);
    }
    console.error('[pagamento] falha', {code:err.code,message:err.message});
    return error(res,503,'Não foi possível processar o pagamento. Verifique antes de tentar novamente.');
  }
};
