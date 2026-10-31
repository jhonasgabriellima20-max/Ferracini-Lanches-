// A permanent insert-only index keeps a clientRequestId attached to the same
// reservation across operational days, including presencial orders.
const { readJson, writeJson } = require('./postgres-storage');
const { storageNamespace, findOrder } = require('./mp-checkout');

function identifier(id){ return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id); }
function indexPath(id){
  if(!identifier(id)) throw new Error('invalid_reservation_id');
  return storageNamespace() + 'pedidos/indice/' + id + '.json';
}
function validPath(pathname, id){
  const prefix = storageNamespace() + 'pedidos/aguardando/';
  return typeof pathname === 'string' && pathname.startsWith(prefix) &&
    new RegExp('^\\d{4}-\\d{2}-\\d{2}/' + id + '\\.json$').test(pathname.slice(prefix.length));
}
function validateIndex(index, id){
  if(index?.id !== id || !validPath(index.pathname, id)) throw new Error('invalid_reservation_index');
  return index.pathname;
}
async function readIndexed(index, id){
  const path = validateIndex(index, id);
  const {value:order} = await readJson(path);
  if(!order || order.id !== id) throw new Error('reservation_index_missing_order');
  return {order, path};
}
async function bind(order, path){
  if(!identifier(order?.id) || !validPath(path, order.id)) throw new Error('invalid_reservation_index');
  try{
    await writeJson(indexPath(order.id), {id:order.id,pathname:path}, {allowOverwrite:false});
    return {order,path};
  }catch(error){
    if(error?.status !== 409 && error?.statusCode !== 409 && error?.code !== 'conflict') throw error;
    const {value:index} = await readJson(indexPath(order.id));
    // If two days race, only the insert-only index winner may be confirmed.
    return readIndexed(index, order.id);
  }
}
async function find(id){
  if(!identifier(id)) return null;
  const {value:index} = await readJson(indexPath(id));
  if(index){
    const found = await readIndexed(index,id);
    // Preserve the payment module's authoritative overlay for online orders.
    return found.order.pagamento?.fluxo === 'mercadopago' ? (await findOrder(id)) || found : found;
  }
  // Existing records are indexed on first recovery; no production backfill is
  // performed automatically by importing or starting this module.
  const found = await findOrder(id);
  return found ? bind(found.order,found.path) : null;
}
module.exports = {find,bind,indexPath};
