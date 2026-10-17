const crypto = require('crypto');
const { readJson, writeJson } = require('./postgres-storage');

const TZ = 'America/Sao_Paulo';
const DAY_MS = 86400000;
function enabled(){
  return process.env.MP_CARD_CHECKOUT_ENABLED === 'true' &&
    Boolean(process.env.MP_PUBLIC_KEY && process.env.MP_ACCESS_TOKEN);
}
function identifier(value){ return /^[a-f0-9]{64}$/.test(String(value || '')); }
function currentDate(offset=0){
  return new Intl.DateTimeFormat('en-CA', {timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'})
    .format(new Date(Date.now() - offset * DAY_MS));
}
async function findOrder(id){
  if(!identifier(id)) return null;
  for(let offset=0; offset<=2; offset++){
    const path = 'pedidos/aguardando/' + currentDate(offset) + '/' + id + '.json';
    const { value } = await readJson(path);
    if(value) return { order:value, path };
  }
  return null;
}
async function requestMP(path, options={}){
  if(!process.env.MP_ACCESS_TOKEN) throw new Error('mp_not_configured');
  const response = await fetch('https://api.mercadopago.com' + path, {
    ...options,
    headers:{
      Authorization:'Bearer ' + process.env.MP_ACCESS_TOKEN,
      Accept:'application/json',
      ...(options.headers || {}),
    },
    signal:AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(()=>({}));
  if(!response.ok){
    const error = new Error('mercadopago_response_' + response.status);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function getPayment(paymentId){
  if(!/^\d{1,24}$/.test(String(paymentId || ''))) throw new Error('invalid_payment_id');
  return requestMP('/v1/payments/' + paymentId);
}
function validPayment(payment, order){
  return payment?.status === 'approved' &&
    payment?.currency_id === 'BRL' &&
    payment?.external_reference === order.id &&
    Number.isFinite(Number(payment?.transaction_amount)) &&
    Math.round(Number(payment.transaction_amount)*100) === order.totalCentavos &&
    payment?.payment_type_id === (order.pagamento?.metodo === 'credito' ? 'credit_card' : 'debit_card');
}
async function reconcile(payment){
  const id = String(payment?.external_reference || '');
  const found = await findOrder(id);
  if(!found || !['credito','debito'].includes(found.order.pagamento?.metodo)) return null;
  if(!validPayment(payment, found.order)) return {status:'aguardando_pagamento'};
  const saved = {
    ...found.order,
    pagamento:{
      ...found.order.pagamento,
      status:'approved',
      mpPaymentId:String(payment.id),
      aprovadoEm: new Date().toISOString(),
    },
    atualizadoEm:new Date().toISOString(),
  };
  await writeJson(found.path,saved,{allowOverwrite:true});
  // Confirmar pedido grava a fila determinística e o número só após pagamento aprovado.
  const confirmed = await require('../api/pedidos').confirmarPedido(id);
  return {status:'approved',pedido:{
    id:confirmed.id,numero:confirmed.numero,referencia:confirmed.referencia,
    criadoEm:confirmed.criadoEm,estimativaMinutos:confirmed.atendimento?.estimativaMinutos || null
  }};
}
function safeMethod(value){ return /^[a-z0-9_]{2,35}$/.test(String(value || '')); }
function requestId(id){
  const hex=crypto.createHash('sha256').update('ferracini-mp-' + id).digest('hex');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32);
}
async function submitPayment(id, form){
  if(!enabled()) throw new Error('mp_not_configured');
  const found=await findOrder(id);
  if(!found || !['credito','debito'].includes(found.order.pagamento?.metodo))
    throw new Error('pedido_nao_encontrado');
  const previous=found.order.pagamento?.mpPaymentId;
  if(previous){
    const payment=await getPayment(previous);
    return (await reconcile(payment)) || {status:payment.status || 'pending'};
  }
  if(!form || typeof form !== 'object' ||
     !/^[a-zA-Z0-9_-]{10,250}$/.test(String(form.token || '')) ||
     !safeMethod(form.payment_method_id) ||
     !Number.isInteger(form.installments) || form.installments < 1 || form.installments > 12 ||
     !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(form.payer?.email || '')) ||
     String(form.payer.email).length>250) throw new Error('cartao_invalido');

  const body={
    token:form.token,
    transaction_amount:found.order.totalCentavos/100,
    installments:form.installments,
    payment_method_id:form.payment_method_id,
    description:'Ferracini Lanches - pedido ' + found.order.referencia,
    external_reference: id,
    payer:{
      email:form.payer.email,
      ...(form.payer.identification?.type && form.payer.identification?.number ? {
        identification:{
          type:String(form.payer.identification.type).slice(0,10),
          number:String(form.payer.identification.number).replace(/\D/g,'').slice(0,20)
        }
      }:{})
    },
    ...(form.issuer_id && /^\d{1,16}$/.test(String(form.issuer_id))?{issuer_id:String(form.issuer_id)}:{}),
  };
  // A mesma referência sempre usa a mesma chave para impedir cobrança duplicada.
  const created=await requestMP('/v1/payments',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-Idempotency-Key':requestId(id)},
    body:JSON.stringify(body),
  });
  if(!created.id) throw new Error('mp_payment_no_id');
  await writeJson(found.path,{
    ...found.order,pagamento:{...found.order.pagamento,mpPaymentId:String(created.id),status:created.status},
    atualizadoEm:new Date().toISOString(),
  },{allowOverwrite:true});
  const payment=await getPayment(created.id);
  if(payment.status==='approved') return reconcile(payment);
  return {status:payment.status === 'rejected' ? 'rejected':'pending',detail:String(payment.status_detail||'').slice(0,80)};
}
module.exports={enabled,identifier,findOrder,requestMP,getPayment,reconcile,submitPayment,validPayment,requestId};
