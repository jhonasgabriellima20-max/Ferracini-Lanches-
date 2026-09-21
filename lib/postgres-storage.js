const STORAGE_FUNCTION_URL = 'https://br-shiny-snow-awm66ato-ferracinistore.compute.c-12.us-east-1.aws.neon.tech/';

function storageError(message, cause){
  const error = new Error(message || 'postgres_storage_unavailable');
  error.code = 'STORAGE_UNAVAILABLE';
  if(cause) error.cause = cause;
  return error;
}

let oidcModulePromise;
async function getOidcToken(){
  try{
    oidcModulePromise ||= import('@vercel/oidc');
    const { getVercelOidcToken } = await oidcModulePromise;
    const token = await getVercelOidcToken();
    if(!token) throw new Error('missing_oidc_token');
    return token;
  }catch(err){
    oidcModulePromise = null;
    throw storageError('vercel_oidc_unavailable', err);
  }
}

async function callStorage(payload){
  const token = await getOidcToken();
  let response;
  try{
    response = await fetch(STORAGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }catch(err){
    throw storageError('neon_function_fetch_failed', err);
  }

  const text = await response.text().catch(() => '');
  let data = null;
  if(text){
    try{ data = JSON.parse(text); }catch{ data = null; }
  }

  if(!response.ok){
    const error = new Error(
      String(data?.error || `neon_function_${response.status}`)
    );
    error.status = response.status;
    if(response.status === 409) error.code = 'conflict';
    throw error;
  }
  return data;
}

function isStorageUnavailable(err){
  if(err?.code === 'STORAGE_UNAVAILABLE') return true;
  const status = Number(err?.status || err?.statusCode || 0);
  if([401,403,408,429].includes(status) || status >= 500) return true;
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('oidc') ||
    message.includes('neon_function') ||
    message.includes('fetch failed') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('enotfound');
}

async function readJson(pathname){
  try{
    const data = await callStorage({ op:'read', pathname:String(pathname || '') });
    return { value: data?.value ?? null, mode:'postgres' };
  }catch(err){
    if(isStorageUnavailable(err)) throw err;
    throw storageError('database_read_failed', err);
  }
}

async function writeJson(pathname, value, options = {}){
  try{
    await callStorage({
      op:'write',
      pathname:String(pathname || ''),
      value,
      allowOverwrite: options.allowOverwrite === true,
    });
    return { mode:'postgres' };
  }catch(err){
    if(err?.code === 'conflict' || Number(err?.status || 0) === 409){
      const conflict = new Error('storage_conflict');
      conflict.code = 'conflict';
      conflict.status = 409;
      throw conflict;
    }
    if(isStorageUnavailable(err)) throw err;
    throw storageError('database_write_failed', err);
  }
}

async function listBlobs(options = {}){
  try{
    const prefix = String(options.prefix || '');
    const limit = Math.min(1000, Math.max(1, Number(options.limit) || 100));
    const data = await callStorage({ op:'list', prefix, limit });
    return {
      blobs: Array.isArray(data?.blobs) ? data.blobs : [],
      hasMore: false,
      cursor: null,
    };
  }catch(err){
    if(isStorageUnavailable(err)) throw err;
    throw storageError('database_list_failed', err);
  }
}

module.exports = {
  isStorageUnavailable,
  readJson,
  writeJson,
  listBlobs,
};
