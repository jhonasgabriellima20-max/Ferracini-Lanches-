// Immutable payment facts. Insert-only writes provide cross-instance exclusion
// without overwriting a reservation read before another worker approved it.
const { readJson, writeJson } = require('./postgres-storage');

function path(kind, id) {
  if(!/^[a-f0-9]{64}$/.test(String(id || ''))) throw new Error('invalid_order_id');
  const namespace = process.env.VERCEL_ENV === 'preview' ? 'mp-preview/' : '';
  return namespace + 'pedidos/pagamento-' + kind + '/' + id + '.json';
}
function attemptPath(id) { return path('tentativa', id); }
function providerPath(id) { return path('provedor', id); }
function validationPath(id) { return path('validacao-recusada', id); }
function isConflict(error) { return error?.status === 409 || error?.statusCode === 409 || error?.code === 'conflict'; }
async function insertOnce(pathname, value) {
  try {
    await writeJson(pathname, value, {allowOverwrite:false});
    return {created:true, value};
  } catch(error) {
    if(!isConflict(error)) throw error;
    const {value:existing} = await readJson(pathname);
    if(!existing) throw new Error('mp_state_conflict_missing');
    return {created:false, value:existing};
  }
}
async function claimAttempt(id, legacyStartedAt) {
  // Older releases persisted the uncertainty marker in the reservation itself.
  // That marker means a request may already have charged; never issue it again.
  if(legacyStartedAt) return {created:false, value:{id, iniciadaEm:legacyStartedAt}};
  const result = await insertOnce(attemptPath(id), {id, iniciadaEm:new Date().toISOString()});
  if(result.value.id !== id || !Number.isFinite(Date.parse(result.value.iniciadaEm))) throw new Error('mp_attempt_state_invalid');
  return result;
}
async function bindProvider(id, mpOrderId) {
  if(!/^[a-zA-Z0-9_-]{10,80}$/.test(String(mpOrderId || ''))) throw new Error('invalid_order_id');
  const result = await insertOnce(providerPath(id), {id, mpOrderId});
  if(result.value.id !== id || result.value.mpOrderId !== mpOrderId) throw new Error('mp_order_id_conflict');
  return result.value;
}
async function hydrate(order) {
  if(order?.pagamento?.fluxo !== 'mercadopago') return order;
  const [{value:attempt}, {value:provider}] = await Promise.all([
    readJson(attemptPath(order.id)), readJson(providerPath(order.id)),
  ]);
  const pagamento = {...order.pagamento};
  if(attempt) {
    if(attempt.id !== order.id || !Number.isFinite(Date.parse(attempt.iniciadaEm))) throw new Error('mp_attempt_state_invalid');
    pagamento.tentativaIniciadaEm = attempt.iniciadaEm;
  }
  if(provider) {
    if(provider.id !== order.id || !/^[a-zA-Z0-9_-]{10,80}$/.test(String(provider.mpOrderId || '')) ||
       (pagamento.mpOrderId && pagamento.mpOrderId !== provider.mpOrderId)) throw new Error('mp_order_id_conflict');
    pagamento.mpOrderId = provider.mpOrderId;
  }
  return {...order, pagamento};
}
function validationResponse(hint) {
  const detail = hint === 'email' ? 'Confira o e-mail informado no pagamento.'
    : hint === 'installments' ? 'Confira as parcelas. Débito aceita somente pagamento à vista.'
    : 'Confira os dados do cartão, e-mail e modalidade.';
  return {status:'validation_rejected', needsNewOrder:true,
    error:detail + ' O Mercado Pago rejeitou os dados desta tentativa. Confira o extrato antes de iniciar outra tentativa.'};
}
async function recordValidationFailure(id, error) {
  const hint = ['email','installments','payment_method'].includes(error?.providerHint) ? error.providerHint : 'unspecified';
  const result = await insertOnce(validationPath(id), {id, status:'validation_rejected', hint, criadoEm:new Date().toISOString()});
  if(result.value.id !== id || result.value.status !== 'validation_rejected') throw new Error('mp_validation_state_invalid');
  return validationResponse(result.value.hint);
}
async function readValidationFailure(id) {
  const {value} = await readJson(validationPath(id));
  if(!value) return null;
  if(value.id !== id || value.status !== 'validation_rejected') throw new Error('mp_validation_state_invalid');
  return validationResponse(value.hint);
}
function unknownResponse() {
  return {status:'processing_unknown', retrySameAttempt:false,
    message:'Esta cobrança foi iniciada, mas ainda não foi possível verificar o resultado. Não faça outra cobrança; consulte novamente ou entre em contato com a loja.'};
}
module.exports = {attemptPath, providerPath, validationPath, claimAttempt, bindProvider, hydrate, recordValidationFailure, readValidationFailure, unknownResponse};
