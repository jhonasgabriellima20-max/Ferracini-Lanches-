// Mercado Pago integration: credentials remain only in Vercel environment variables.
const crypto = require('node:crypto');
const {readJson, writeJson} = require('./postgres-storage');
const orders = require('../api/pedidos');

function ready(){
  return process.env.MP_PAYMENTS_ENABLED === 'true' &&
    Boolean(process.env.MP_ACCESS_TOKEN && process.env.MP_PUBLIC_KEY &&
      process.env.MP_WEBHOOK_SECRET && process.env.MP_WEBHOOK_URL);
}

function requestId(id){
  const bytes = Buffer.from(id.slice(0,32),'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const x = bytes.toString('hex');
  return [x.slice(0,8),x.slice(8,12),x.slice(12,16),x.slice(16,20),x.slice(20)].join('-');
}

async function mercadoPago(path, options={}){
  if(!process.env.MP_ACCESS_TOKEN) throw new Error('Mercado Pago não configurado.');
  const response = await fetch('https://api.mercadopago.com'+path, {
    method:options.method || 'GET',
    headers: {
      'Authorization':'Bearer '+process.env.MP_ACCESS_TOKEN,
      'Content-Type':'application/json',
      'Accept':'application/json',
      ...(options.idempotency ? {'X-Idempotency-Key':options.idempotency}:{}),
    },
    ...(options.body ? {body:JSON.stringify(options.body)}:{}),
    signal:AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(()=>({}));
  if(!response.ok){
    const e = new Error('Falha ao processar pagamento. Tente novamente.');
    e.code = 'MP_'+response.status;
    console.error('[pagamento] erro_provedor', {status:response.status, code:data?.error, cause:data?.cause?.[0]?.code});
    throw e;
  }
  return data;
}

function diaLocal(time){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',
    year:'numeric',month:'2-digit',day:'2-digit'}).format(time);
}

async function procurarPedido(id){
  if(!/^[a-f0-9]{64}$/.test(id)) return null;
  for(let d=0;d<8;d++){
    const day=diaLocal(new Date(Date.now()-d*86400000));
    const path='pedidos/aguardando/'+day+'/'+id+'.json';
    const pedido=(await readJson(path)).value;
    if(pedido) return {pedido,path};
  }
  return null;
}

function respostaPublica(pedido, confirmado){
  return {
    id:pedido.id,
    status:confirmado ? 'approved' : (pedido.pagamento?.status || 'pending'),
    pago: Boolean(confirmado),
    ...(confirmado ? {numero:confirmado.numero, confirmadoEm:confirmado.confirmadoEm}:{}),
  };
}

async function conferirPagamento(payment){
  const id=String(payment?.external_reference || '');
  const match=await procurarPedido(id);
  if(!match) return null;
  const {pedido,path}=match;
  const amount=Number(payment.transaction_amount);
  if(payment.currency_id !== 'BRL' ||
    !Number.isFinite(amount) ||
    Math.round(amount*100) !== pedido.totalCentavos ||
    String(payment.id||'').length < 1){
    console.error('[pagamento] divergencia_pedido', {id, paymentId:String(payment?.id||'').slice(0,32)});
    return null;
  }
  // Never generate a print job for unapproved, refunded or cancelled payments.
  if(payment.status !== 'approved') return {pedido, confirmado:null};
  if(pedido.pagamento?.status !== 'approved'){
    const updated={...pedido,status:'pagamento_aprovado',
      atualizadoEm:new Date().toISOString(),
      pagamento:{metodo: payment.payment_method_id === 'pix' ? 'pix':
        payment.payment_type_id === 'debit_card' ? 'debito' : 'credito',
        status:'approved', provedor:'mercadopago', pagamentoId:String(payment.id),
        aprovadoEm:payment.date_approved || new Date().toISOString()}};
    await writeJson(path,updated,{allowOverwrite:true});
  }
  const confirmado=await orders.confirmarPedido(id);
  return {pedido,confirmado};
}

module.exports={ready, requestId, mercadoPago, procurarPedido, conferirPagamento, respostaPublica};
