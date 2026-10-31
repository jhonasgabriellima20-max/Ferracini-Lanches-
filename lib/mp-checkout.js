const crypto = require('node:crypto');
const { readJson, writeJson } = require('./postgres-storage');
const paymentState = require('./mp-state');
const TZ = 'America/Sao_Paulo';
const DAY_MS = 86400000;
// Only objects returned by our authenticated provider lookup can recover an
// absent provider ID. No browser or webhook payload carries this authority.
const authoritativeOrders = new WeakSet();

function enabled() {
  const hasKeys = Boolean(process.env.MP_PUBLIC_KEY && process.env.MP_ACCESS_TOKEN);
  const signatureReady = process.env.VERCEL_ENV === 'preview' || Boolean(process.env.MP_WEBHOOK_SECRET);
  return process.env.MP_CARD_CHECKOUT_ENABLED === 'true' && hasKeys && signatureReady;
}
// Disabling new sales must not strand charges already accepted by the provider.
// Reconciliation needs only the merchant API credential; signed webhooks still
// require MP_WEBHOOK_SECRET independently in their boundary validator.
function canReconcile() { return Boolean(process.env.MP_ACCESS_TOKEN); }
function storageNamespace() { return process.env.VERCEL_ENV === 'preview' ? 'mp-preview/' : ''; }
function paymentBlockPath(id) {
  if(!identifier(id)) throw new Error('invalid_order_id');
  return storageNamespace() + 'pedidos/pagamento-bloqueado/' + id + '.json';
}
function identifier(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function currentDate(offset = 0) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:TZ, year:'numeric', month:'2-digit', day:'2-digit'})
    .format(new Date(Date.now() - offset * DAY_MS));
}
function orderIndexPath(id) {
  if(!identifier(id)) throw new Error('invalid_order_id');
  return storageNamespace() + 'pedidos/pagamento-indice/' + id + '.json';
}
function validPendingPath(path, id) {
  const prefix = storageNamespace() + 'pedidos/aguardando/';
  return typeof path === 'string' && path.startsWith(prefix) &&
    new RegExp('^\\d{4}-\\d{2}-\\d{2}/' + id + '\\.json$').test(path.slice(prefix.length));
}
async function ensureOrderIndex(order, path) {
  if(!isOnline(order)) return;
  if(!identifier(order.id) || !validPendingPath(path, order.id)) throw new Error('invalid_order_index_path');
  try {
    await writeJson(orderIndexPath(order.id), {id:order.id, pathname:path}, {allowOverwrite:false});
  } catch(error) {
    if(error?.status !== 409 && error?.statusCode !== 409) throw error;
    // A permanent index is never silently redirected to a different reservation.
    const {value:existing} = await readJson(orderIndexPath(order.id));
    if(existing?.id !== order.id || existing.pathname !== path) throw new Error('mp_order_index_conflict');
  }
}
async function findOrder(id) {
  if(!identifier(id)) return null;
  const {value:index} = await readJson(orderIndexPath(id));
  if(index) {
    if(index.id !== id || !validPendingPath(index.pathname, id)) throw new Error('invalid_order_index_path');
    const {value} = await readJson(index.pathname);
    if(value) {
      if(value.id !== id || !isOnline(value)) throw new Error('mp_order_index_mismatch');
      return {order:await paymentState.hydrate(value), path:index.pathname};
    }
  }
  // Compatibility for reservations created before the permanent index existed.
  for(let offset = 0; offset <= 2; offset++) {
    const path = storageNamespace() + 'pedidos/aguardando/' + currentDate(offset) + '/' + id + '.json';
    const {value} = await readJson(path);
    if(value) return {order:await paymentState.hydrate(value), path};
  }
  return null;
}
function safeError(error) {
  // Network exceptions and storage failures may contain URLs, credentials or payer data.
  const safe = value => /^[a-zA-Z0-9_.-]{1,85}$/.test(String(value || '')) ? String(value) : 'unspecified';
  return {
    reason:safe(error?.code), operation:safe(error?.operation),
    providerCode:safe(error?.providerCode), providerField:safe(error?.providerField),
    providerHint:safe(error?.providerHint), providerRequestId:safe(error?.providerRequestId),
    status:Number.isInteger(error?.status) ? error.status : undefined
  };
}
async function requestMP(path, options = {}) {
  if(!process.env.MP_ACCESS_TOKEN) throw new Error('mp_not_configured');
  if(!/^\/v1\/orders(?:\/[a-zA-Z0-9_-]{10,80})?$/.test(path)) throw new Error('invalid_mp_path');
  const response = await fetch('https://api.mercadopago.com' + path, {
    ...options,
    headers:{ ...(options.headers || {}), Authorization:'Bearer ' + process.env.MP_ACCESS_TOKEN, Accept:'application/json' },
    redirect:'error', signal:AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if(!response.ok) {
    const error = new Error('mercadopago_response_' + response.status);
    error.status = response.status;
    error.operation = options.method === 'POST' ? 'create_order' : 'fetch_order';
    const rawCode = String(data?.errors?.[0]?.code || data?.code || data?.error || 'unknown');
    error.providerCode = /^[a-zA-Z0-9_.-]{1,70}$/.test(rawCode) ? rawCode : 'unspecified';
    const descriptions = JSON.stringify({message:data?.message, errors:Array.isArray(data?.errors) ? data.errors.slice(0,5) : []}).toLowerCase().slice(0,3500);
    error.providerField = ['payer.email','payer.identification','payment_method.id','payment_method.type','payment_method.token','payment_method.installments','transactions.payments','total_amount','external_reference'].find(field => descriptions.includes(field)) || 'unspecified';
    error.providerHint = error.providerField === 'payer.email' || /email domain|email address|invalid email|e-mail|forbidden domain|blacklisted domain/.test(descriptions) ? 'email'
      : /installment|parcelas/.test(descriptions) ? 'installments'
      : /payment_method|card token|cart[aã]o/.test(descriptions) ? 'payment_method' : 'unspecified';
    const requestId = String(response.headers.get('x-request-id') || '');
    error.providerRequestId = /^[a-zA-Z0-9_.-]{1,80}$/.test(requestId) ? requestId : 'not_provided';
    throw error;
  }
  return data;
}
function orderId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{10,80}$/.test(value); }
async function getOrder(id) {
  if(!orderId(id)) throw new Error('invalid_order_id');
  const order = await requestMP('/v1/orders/' + id);
  if(String(order?.id) !== id) throw new Error('mp_order_id_mismatch');
  authoritativeOrders.add(order);
  return order;
}
function moneyCents(value) {
  if(!/^[0-9]{1,8}(?:\.[0-9]{1,2})?$/.test(String(value ?? ''))) return null;
  const [reais, centavos = ''] = String(value).split('.');
  return Number(reais) * 100 + Number(centavos.padEnd(2,'0'));
}
function orderMatches(mpOrder, localOrder) {
  const payment = mpOrder?.transactions?.payments?.[0];
  const method = localOrder?.pagamento?.metodo;
  return ['credito','debito'].includes(method) &&
    localOrder?.pagamento?.fluxo === 'mercadopago' && orderId(mpOrder?.id) &&
    Number.isSafeInteger(localOrder.totalCentavos) && localOrder.totalCentavos > 0 &&
    mpOrder?.type === 'online' && mpOrder?.processing_mode === 'automatic' &&
    mpOrder?.external_reference === localOrder.id &&
    (!mpOrder.currency_id || mpOrder.currency_id === 'BRL') &&
    (!mpOrder.currency || mpOrder.currency === 'BRL') &&
    Array.isArray(mpOrder?.transactions?.payments) && mpOrder.transactions.payments.length === 1 &&
    moneyCents(mpOrder.total_amount) === localOrder.totalCentavos &&
    payment?.payment_method?.type === (method === 'credito' ? 'credit_card' : 'debit_card') &&
    moneyCents(payment.amount) === localOrder.totalCentavos &&
    (method !== 'debito' || payment.payment_method.installments === 1);
}
function validOrder(mpOrder, localOrder) {
  const payment = mpOrder?.transactions?.payments?.[0];
  return orderMatches(mpOrder, localOrder) && !rejected(mpOrder) &&
    mpOrder.id === localOrder.pagamento.mpOrderId &&
    mpOrder.status === 'processed' && mpOrder.status_detail === 'accredited' &&
    moneyCents(mpOrder.total_paid_amount) === localOrder.totalCentavos &&
    payment.status === 'processed' && payment.status_detail === 'accredited' &&
    moneyCents(payment.paid_amount) === localOrder.totalCentavos;
}
function rejected(mpOrder) {
  const states = ['failed','canceled','cancelled','refunded','charged_back','partially_refunded'];
  return states.includes(mpOrder?.status) || states.includes(mpOrder?.status_detail) ||
    (mpOrder?.transactions?.payments || []).some(payment => states.includes(payment?.status) || states.includes(payment?.status_detail) || (moneyCents(payment?.refunded_amount) || 0) > 0) ||
    (mpOrder?.transactions?.refunds || []).some(refund => refund.status === 'processed');
}
function actionRequired(mpOrder) {
  const payment = mpOrder?.transactions?.payments?.[0];
  if(payment?.status !== 'action_required' || payment?.status_detail !== 'pending_challenge') return null;
  let actionUrl;
  try {
    const url = new URL(payment.payment_method?.transaction_security?.url);
    if(url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.') && !/^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) actionUrl=url.href;
  } catch {}
  return {status:'action_required', requiresBankAuthentication:true, ...(actionUrl ? {actionUrl} : {}),
    message:'Seu banco exige autenticação para concluir o pagamento. Não faça outro pedido enquanto esta tentativa estiver em análise.'};
}
function isOnline(order) { return order?.pagamento?.fluxo === 'mercadopago' && ['credito','debito'].includes(order.pagamento.metodo); }
async function reconcile(mpOrder) {
  let found = await findOrder(String(mpOrder?.external_reference || ''));
  if(!found || !isOnline(found.order)) return null;
  // An authenticated webhook can recover a lost creation response. Bind only an
  // authoritative provider order matching this exact server-priced reservation.
  if(!found.order.pagamento.mpOrderId) {
    if(!authoritativeOrders.has(mpOrder) || !found.order.pagamento.tentativaIniciadaEm || !orderMatches(mpOrder, found.order)) return null;
    await paymentState.bindProvider(found.order.id, mpOrder.id);
    found = await findOrder(found.order.id);
    if(!found || !isOnline(found.order)) return null;
  }
  if(String(mpOrder?.id) !== found.order.pagamento.mpOrderId) return null;
  // Also migrate an older reservation's persisted provider ID into immutable
  // storage so a later stale cache write cannot remove the binding.
  await paymentState.bindProvider(found.order.id, mpOrder.id);
  if(!validOrder(mpOrder, found.order)) {
    if(rejected(mpOrder)) {
      const updatedAt = new Date().toISOString();
      // Insert-only tombstone survives stale read/write races. No approval path
      // ever removes or overwrites it, including a delayed approved webhook.
      try {
        await writeJson(paymentBlockPath(found.order.id), {id:found.order.id, mpOrderId:mpOrder.id, criadoEm:updatedAt, reason:'provider_reversal'}, {allowOverwrite:false});
      } catch(error) { if(error?.status !== 409 && error?.statusCode !== 409) throw error; }
      const pagamento = {...found.order.pagamento, status:'rejected', verified:false, verificadoEm:updatedAt};
      // If a reversal arrives after release, stop a still-pending receipt. Already
      // printed receipts require operator follow-up; never silently reprint them.
      const queuePath = found.order.confirmadoPath;
      const expectedQueue = storageNamespace() + 'pedidos/fila/';
      if(typeof queuePath === 'string' && queuePath.startsWith(expectedQueue) && queuePath.endsWith('/' + found.order.id + '.json')) {
        const {value:queued} = await readJson(queuePath);
        if(queued) await writeJson(queuePath, {
          ...queued, pagamento, atualizadoEm:updatedAt,
          status:queued.status === 'pendente' ? 'bloqueado_pagamento' : queued.status
        }, {allowOverwrite:true});
      }
      await writeJson(found.path, {...found.order, pagamento, atualizadoEm:updatedAt}, {allowOverwrite:true});
      return {status:'rejected'};
    }
    return actionRequired(mpOrder) || {status:'pending'};
  }
  const {value:blocked} = await readJson(paymentBlockPath(found.order.id));
  if(blocked) return {status:'rejected'};
  // Preserve confirmation markers and locally recorded reversals while an
  // asynchronous provider lookup is in flight. Storage has no CAS primitive;
  // the print queue also rechecks the authoritative source before claiming.
  const latest = await findOrder(found.order.id);
  if(!latest || latest.order.pagamento?.mpOrderId !== mpOrder.id) return null;
  found = latest;
  // A locally recorded reversal is not undone by an older approved notification.
  if(found.order.pagamento.status === 'rejected') return {status:'rejected'};
  const saved = {
    ...found.order,
    pagamento:{...found.order.pagamento, status:'approved', verified:true,
      aprovadoEm:found.order.pagamento.aprovadoEm || new Date().toISOString(), verificadoEm:new Date().toISOString()},
    atualizadoEm:new Date().toISOString()
  };
  await writeJson(found.path, saved, {allowOverwrite:true});
  const confirmed = await require('../api/pedidos').confirmarPedido(found.order.id);
  return {status:'approved', pedido:{
    id:confirmed.id, numero:confirmed.numero, referencia:confirmed.referencia,
    criadoEm:confirmed.criadoEm, status:confirmed.status,
    pagamento:{fluxo:'mercadopago', status:'approved', verified:true, mpOrderId:saved.pagamento.mpOrderId},
    estimativaMinutos:confirmed.atendimento?.estimativaMinutos || null
  }};
}
function safeMethod(value) { return typeof value === 'string' && /^[a-z0-9_]{2,35}$/.test(value); }
function requestId(id) {
  const hex = crypto.createHash('sha256').update('ferracini-order-' + storageNamespace() + id).digest('hex');
  return hex.slice(0,8) + '-' + hex.slice(8,12) + '-4' + hex.slice(13,16) + '-a' + hex.slice(17,20) + '-' + hex.slice(20,32);
}
async function submitPayment(id, form) {
  if(!enabled()) throw new Error('mp_not_configured');
  const found = await findOrder(id);
  if(!found || !isOnline(found.order)) throw new Error('pedido_nao_encontrado');
  const {value:blocked} = await readJson(paymentBlockPath(found.order.id));
  if(blocked) return {status:'rejected'};
  const previous = found.order.pagamento.mpOrderId;
  if(previous) return (await reconcile(await getOrder(previous))) || {status:'pending'};
  const validation = await paymentState.readValidationFailure(id);
  if(validation) return validation;
  const attemptStarted = found.order.pagamento.tentativaIniciadaEm;
  if(attemptStarted) {
    // An interrupted first request may have reached the provider. Only an
    // authoritative lookup/webhook may recover it; never POST again blindly.
    throw new Error('mp_attempt_requires_reconciliation');
  }
  const createdAt = Date.parse(found.order.criadoEm);
  if(!Number.isFinite(createdAt) || (!found.order.pagamento.tentativaIniciadaEm && Date.now() - createdAt > 30 * 60 * 1000)) throw new Error('pedido_expirado');
  const expectedType = found.order.pagamento.metodo === 'credito' ? 'credit_card' : 'debit_card';
  if(!form || typeof form !== 'object' ||
     !/^[a-zA-Z0-9_-]{10,250}$/.test(String(form.token || '')) || !safeMethod(form.payment_method_id) ||
     !Number.isInteger(form.installments) || form.installments < 1 || form.installments > 12 ||
     (found.order.pagamento.metodo === 'debito' && form.installments !== 1) ||
     form.payment_type_id !== expectedType ||
     !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(form.payer?.email || '')) || String(form.payer.email).length > 250)
    throw new Error('cartao_invalido');
  const amount = (found.order.totalCentavos / 100).toFixed(2);
  const identification = form.payer.identification;
  const body = {
    type:'online', processing_mode:'automatic', total_amount:amount, external_reference:id,
    payer:{ email:form.payer.email,
      ...(identification?.type && identification?.number ? {identification:{
        type:String(identification.type).slice(0,10), number:String(identification.number).replace(/\D/g,'').slice(0,20)
      }} : {}) },
    transactions:{payments:[{amount, payment_method:{
      id:form.payment_method_id, type:expectedType, token:form.token, installments:form.installments
    }}]}
  };
  // Insert-only claim elects one worker across serverless instances. Unlike a
  // whole-reservation prewrite, a delayed loser cannot erase an approved state.
  const claim = await paymentState.claimAttempt(id);
  if(!claim.created) {
    const current = await findOrder(id);
    if(current?.order.pagamento.mpOrderId) return (await reconcile(await getOrder(current.order.pagamento.mpOrderId))) || {status:'pending'};
    return (await paymentState.readValidationFailure(id)) || paymentState.unknownResponse();
  }
  let created;
  try {
    created = await requestMP('/v1/orders', {
      method:'POST', headers:{'Content-Type':'application/json', 'X-Idempotency-Key':requestId(id)}, body:JSON.stringify(body)
    });
  } catch(error) {
    if(error?.operation === 'create_order' && error?.status === 400 &&
       ['property_value','required_properties','unsupported_properties','malformed_syntax'].includes(error.providerCode)) {
      // Persist only a safe classification of this definitive validation reply.
      // Network errors, 409, permissions and unknown results never allow a new
      // order. Store before answering so reload retains the same conclusion.
      const result = await paymentState.recordValidationFailure(id, error);
      const current = await findOrder(id);
      if(current?.order.pagamento.mpOrderId) return (await reconcile(await getOrder(current.order.pagamento.mpOrderId))) || {status:'pending'};
      return result;
    }
    throw error;
  }
  if(!orderId(created?.id)) throw new Error('mp_order_missing_id');
  await paymentState.bindProvider(id, created.id);
  return (await reconcile(await getOrder(created.id))) || {status:'pending'};
}
module.exports = {enabled, canReconcile, storageNamespace, paymentBlockPath, orderIndexPath, ensureOrderIndex, identifier, findOrder, requestMP, getOrder, reconcile, submitPayment, validOrder, requestId, moneyCents, rejected, safeError,
  attemptPath:paymentState.attemptPath, providerPath:paymentState.providerPath, validationPath:paymentState.validationPath,
  readValidationFailure:paymentState.readValidationFailure, unknownResponse:paymentState.unknownResponse};
