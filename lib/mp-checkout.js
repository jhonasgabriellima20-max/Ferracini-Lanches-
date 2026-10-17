const crypto = require('crypto');
const { readJson, writeJson } = require('./postgres-storage');
const TZ = 'America/Sao_Paulo';
const DAY_MS = 86400000;

function enabled() {
  const hasKeys=Boolean(process.env.MP_PUBLIC_KEY && process.env.MP_ACCESS_TOKEN);
  // Preview: test credentials with polling, never use the production webhook secret.
  // Production: fail closed without a configured webhook signature secret.
  const signatureReady = process.env.VERCEL_ENV === 'preview' || Boolean(process.env.MP_WEBHOOK_SECRET);
  return process.env.MP_CARD_CHECKOUT_ENABLED === 'true' && hasKeys && signatureReady;
}
function identifier(value) { return /^[a-f0-9]{64}$/.test(String(value || '')); }
function currentDate(offset=0) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'})
    .format(new Date(Date.now() - offset * DAY_MS));
}
async function findOrder(id) {
  if(!identifier(id)) return null;
  for(let offset=0;offset<=2;offset++) {
    const prefix=process.env.VERCEL_ENV === 'preview' ? 'mp-preview/' : '';
    const path=prefix+'pedidos/aguardando/'+currentDate(offset)+'/'+id+'.json';
    const {value}=await readJson(path);
    if(value) return {order:value,path};
  }
  return null;
}
async function requestMP(path,options={}) {
  if(!process.env.MP_ACCESS_TOKEN) throw new Error('mp_not_configured');
  const response=await fetch('https://api.mercadopago.com'+path,{
    ...options,
    headers:{
      Authorization:'Bearer '+process.env.MP_ACCESS_TOKEN,
      Accept:'application/json',
      ...(options.headers||{})
    },
    signal:AbortSignal.timeout(15000)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) {
    const error=new Error('mercadopago_response_'+response.status);
    error.status=response.status;
    throw error;
  }
  return data;
}
function orderId(value) { return /^[a-zA-Z0-9_-]{10,80}$/.test(String(value||'')); }
async function getOrder(id) {
  if(!orderId(id)) throw new Error('invalid_order_id');
  return requestMP('/v1/orders/'+id);
}
function moneyCents(value) {
  if(!/^[0-9]{1,8}(?:\.[0-9]{1,2})?$/.test(String(value??''))) return null;
  const [reais,centavos='']=String(value).split('.');
  return Number(reais)*100+Number(centavos.padEnd(2,'0'));
}
function validOrder(mpOrder,localOrder) {
  const payment=mpOrder?.transactions?.payments?.[0];
  const tipo=localOrder?.pagamento?.metodo === 'credito' ? 'credit_card' : 'debit_card';
  return mpOrder?.type==='online' &&
    mpOrder?.processing_mode==='automatic' &&
    mpOrder?.status==='processed' && mpOrder?.status_detail==='accredited' &&
    mpOrder?.external_reference===localOrder.id &&
    Array.isArray(mpOrder?.transactions?.payments) && mpOrder.transactions.payments.length===1 &&
    moneyCents(mpOrder?.total_amount)===localOrder.totalCentavos &&
    moneyCents(mpOrder?.total_paid_amount)===localOrder.totalCentavos &&
    payment?.status==='processed' && payment?.status_detail==='accredited' &&
    payment?.payment_method?.type===tipo &&
    moneyCents(payment?.amount)===localOrder.totalCentavos &&
    moneyCents(payment?.paid_amount)===localOrder.totalCentavos;
}
function rejected(mpOrder) {
  return ['failed','canceled','refunded','charged_back'].includes(mpOrder?.status);
}
async function reconcile(mpOrder) {
  const id=String(mpOrder?.external_reference||'');
  const found=await findOrder(id);
  if(!found || !['credito','debito'].includes(found.order.pagamento?.metodo)) return null;
  // Do not trust the webhook body or an id from the browser. The API response is authoritative.
  if(!validOrder(mpOrder,found.order))
    return {status:rejected(mpOrder)?'rejected':'pending'};
  const saved={
    ...found.order,
    pagamento:{
      ...found.order.pagamento,
      status:'approved',
      mpOrderId:String(mpOrder.id),
      aprovadoEm:found.order.pagamento?.aprovadoEm||new Date().toISOString()
    },
    atualizadoEm:new Date().toISOString()
  };
  await writeJson(found.path,saved,{allowOverwrite:true});
  // This operation is idempotent, using the unique path for the order in the print queue.
  const confirmed=await require('../api/pedidos').confirmarPedido(id);
  return {status:'approved',pedido:{
    id:confirmed.id,numero:confirmed.numero,referencia:confirmed.referencia,
    criadoEm:confirmed.criadoEm,estimativaMinutos:confirmed.atendimento?.estimativaMinutos||null
  }};
}
function safeMethod(value) { return /^[a-z0-9_]{2,35}$/.test(String(value||'')); }
function requestId(id) {
  const hex=crypto.createHash('sha256').update('ferracini-order-'+id).digest('hex');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32);
}
async function submitPayment(id,form) {
  if(!enabled()) throw new Error('mp_not_configured');
  const found=await findOrder(id);
  if(!found || !['credito','debito'].includes(found.order.pagamento?.metodo))
    throw new Error('pedido_nao_encontrado');
  const previous=found.order.pagamento?.mpOrderId;
  if(previous) return (await reconcile(await getOrder(previous)))||{status:'pending'};
  if(!form || typeof form!=='object' ||
     !/^[a-zA-Z0-9_-]{10,250}$/.test(String(form.token||'')) ||
     !safeMethod(form.payment_method_id) ||
     !Number.isInteger(form.installments)||form.installments<1||form.installments>12 ||
     !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(form.payer?.email||'')) ||
     String(form.payer.email).length>250) throw new Error('cartao_invalido');
  const amount=(found.order.totalCentavos/100).toFixed(2);
  const body={
    type:'online',
    processing_mode:'automatic',
    total_amount:amount,
    external_reference:id,
    payer:{
      email:form.payer.email,
      ...(form.payer.identification?.type&&form.payer.identification?.number?{
        identification:{
          type:String(form.payer.identification.type).slice(0,10),
          number:String(form.payer.identification.number).replace(/\D/g,'').slice(0,20)
        }
      }:{})
    },
    transactions:{payments:[{
      amount,
      payment_method:{
        id:form.payment_method_id,
        type:found.order.pagamento.metodo==='credito'?'credit_card':'debit_card',
        token:form.token,
        installments:form.installments
      }
    }]}
  };
  // Same local order => same idempotency key, including network retries.
  const created=await requestMP('/v1/orders',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-Idempotency-Key':requestId(id)},
    body:JSON.stringify(body)
  });
  if(!orderId(created.id)) throw new Error('mp_order_missing_id');
  // Save only order ID, no token or complete card number.
  await writeJson(found.path,{
    ...found.order,
    pagamento:{...found.order.pagamento,mpOrderId:String(created.id),status:created.status},
    atualizadoEm:new Date().toISOString()
  },{allowOverwrite:true});
  const confirmed=await getOrder(created.id);
  return (await reconcile(confirmed))||{status:'pending'};
}
module.exports={enabled,identifier,findOrder,requestMP,getOrder,reconcile,submitPayment,validOrder,requestId,moneyCents,rejected};