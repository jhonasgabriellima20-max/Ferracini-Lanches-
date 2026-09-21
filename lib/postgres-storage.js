const DATA_API_URL = 'https://ep-soft-mud-aczjydzb.apirest.sa-east-1.aws.neon.tech/ferracini/rest/v1';

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

async function requestDataApi(pathname, options = {}){
  let token;
  try{
    token = await getOidcToken();
  }catch(err){
    throw err;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(options.headers || {}),
  };
  if(options.body !== undefined && !headers['Content-Type']){
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try{
    response = await fetch(`${DATA_API_URL}${pathname}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }catch(err){
    throw storageError('data_api_fetch_failed', err);
  }

  if(!response.ok){
    const detail = await response.text().catch(() => '');
    const error = new Error(`data_api_${response.status}${detail ? `:${detail.slice(0,180)}` : ''}`);
    error.status = response.status;
    if(response.status === 409) error.code = 'conflict';
    throw error;
  }

  if(response.status === 204) return null;
  const text = await response.text();
  if(!text) return null;
  try{ return JSON.parse(text); }
  catch(err){ throw storageError('data_api_invalid_json', err); }
}

function isStorageUnavailable(err){
  if(err?.code === 'STORAGE_UNAVAILABLE') return true;
  const status = Number(err?.status || err?.statusCode || 0);
  if([401, 403, 408, 429].includes(status) || status >= 500) return true;
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('oidc') ||
    message.includes('data_api') ||
    message.includes('fetch failed') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('enotfound');
}

function normalizeValue(value){
  if(typeof value !== 'string') return value;
  try{ return JSON.parse(value); }catch{ return value; }
}

async function readJson(pathname){
  try{
    const params = new URLSearchParams({
      select: 'value',
      pathname: `eq.${pathname}`,
      limit: '1',
    });
    const rows = await requestDataApi(`/ferracini_store?${params.toString()}`);
    return {
      value: Array.isArray(rows) && rows.length ? normalizeValue(rows[0].value) : null,
      mode: 'postgres',
    };
  }catch(err){
    if(isStorageUnavailable(err)) throw err;
    throw storageError('database_read_failed', err);
  }
}

async function writeJson(pathname, value, options = {}){
  const allowOverwrite = options.allowOverwrite === true;
  try{
    const suffix = allowOverwrite ? '?on_conflict=pathname' : '';
    const prefer = allowOverwrite
      ? 'resolution=merge-duplicates,return=minimal'
      : 'return=minimal';

    await requestDataApi(`/ferracini_store${suffix}`, {
      method: 'POST',
      headers: { Prefer: prefer },
      body: { pathname, value },
    });

    return { mode: 'postgres' };
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
    const params = new URLSearchParams({
      select: 'pathname,updated_at,value',
      pathname: `like.${prefix}*`,
      order: 'pathname.asc',
      limit: String(limit),
    });
    const rows = await requestDataApi(`/ferracini_store?${params.toString()}`);

    return {
      blobs: (Array.isArray(rows) ? rows : []).map(row => ({
        pathname: String(row.pathname || ''),
        uploadedAt: String(row.updated_at || ''),
        size: Buffer.byteLength(JSON.stringify(row.value ?? null)),
      })),
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
