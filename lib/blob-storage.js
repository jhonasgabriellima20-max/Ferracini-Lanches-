const crypto = require('crypto');

function deriveStoreIdFromToken(token){
  const value = String(token || '').trim();
  const match = value.match(/^vercel_blob_rw_([^_]+)_/i);
  return match?.[1] || '';
}

async function runtimeOidcToken(){
  const envToken = String(process.env.VERCEL_OIDC_TOKEN || '').trim();
  if(envToken) return envToken;
  try{
    const { getVercelOidcToken } = await import('@vercel/oidc');
    return String(await getVercelOidcToken({
      project: 'prj_KzbF8mN8dUsf6bZV3a8a8wxBTRAg',
      team: 'team_GObmx1bMb8GYVLduQk8qb93g',
    }) || '').trim();
  }catch(err){
    console.warn('[blob-storage] oidc_indisponivel', { error: String(err) });
    return '';
  }
}

async function authCandidates(){
  const candidates = [];
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();
  const oidcToken = await runtimeOidcToken();
  const configuredStoreId = String(process.env.BLOB_STORE_ID || '').trim();
  const derivedStoreId = deriveStoreIdFromToken(token);
  const storeIds = [...new Set([configuredStoreId, derivedStoreId].filter(Boolean))];

  for(const storeId of storeIds){
    if(oidcToken) candidates.push({ oidcToken, storeId });
  }
  if(token) candidates.push({ token });
  candidates.push({});
  return candidates;
}

function isAuthError(err){
  const status = Number(err?.status || err?.statusCode || 0);
  const message = String(err?.message || err || '').toLowerCase();
  return status === 401 || status === 403 ||
    message.includes('401') || message.includes('403') ||
    message.includes('forbidden') || message.includes('unauthorized');
}

function isNotFound(err){
  const status = Number(err?.status || err?.statusCode || 0);
  const code = String(err?.code || '').toLowerCase();
  return status === 404 || code === 'not_found' || code === 'blob_not_found';
}

function encryptionSecret(){
  return String(
    process.env.STORAGE_ENCRYPTION_KEY ||
    process.env.PRINT_AGENT_TOKEN ||
    process.env.ADMIN_PASSWORD ||
    ''
  ).trim();
}

function encryptionKey(){
  const secret = encryptionSecret();
  if(!secret){
    const err = new Error('storage_encryption_secret_missing');
    err.code = 'STORAGE_ENCRYPTION_SECRET_MISSING';
    throw err;
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function encodeJson(pathname, value){
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(pathname, 'utf8'));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    __ferraciniEncrypted: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

function decodeJson(pathname, text){
  const parsed = JSON.parse(text);
  if(!parsed || parsed.__ferraciniEncrypted !== 1) return parsed;
  if(parsed.alg !== 'aes-256-gcm') throw new Error('storage_encryption_algorithm_invalid');

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(parsed.iv, 'base64')
  );
  decipher.setAAD(Buffer.from(pathname, 'utf8'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(clear);
}

async function callWithAuth(fn){
  let lastAuthError;
  for(const auth of await authCandidates()){
    try{
      return await fn(auth);
    }catch(err){
      if(!isAuthError(err)) throw err;
      lastAuthError = err;
    }
  }
  throw lastAuthError || new Error('blob_auth_failed');
}

async function getBlob(pathname, access){
  const { get } = await import('@vercel/blob');
  try{
    return await callWithAuth(auth =>
      get(pathname, { access, useCache: false, ...auth })
    );
  }catch(err){
    if(isNotFound(err)) return null;
    throw err;
  }
}

async function readJson(pathname){
  let privateError;
  try{
    const result = await getBlob(pathname, 'private');
    if(result){
      return {
        value: decodeJson(pathname, await new Response(result.stream).text()),
        mode: 'private',
      };
    }
  }catch(err){
    if(!isAuthError(err)) throw err;
    privateError = err;
  }

  try{
    const result = await getBlob(pathname, 'public');
    if(!result) return { value: null, mode: 'public-encrypted' };
    return {
      value: decodeJson(pathname, await new Response(result.stream).text()),
      mode: 'public-encrypted',
    };
  }catch(err){
    if(isNotFound(err)) return { value: null, mode: 'public-encrypted' };
    if(privateError && isAuthError(err)) err.privateError = privateError;
    throw err;
  }
}

async function putBlob(pathname, body, access, options){
  const { put } = await import('@vercel/blob');
  return callWithAuth(auth =>
    put(pathname, body, {
      access,
      contentType: 'application/json; charset=utf-8',
      addRandomSuffix: false,
      ...options,
      ...auth,
    })
  );
}

async function writeJson(pathname, value, options = {}){
  const allowOverwrite = options.allowOverwrite === true;
  try{
    await putBlob(pathname, JSON.stringify(value), 'private', { allowOverwrite });
    return { mode: 'private' };
  }catch(err){
    if(!isAuthError(err)) throw err;
  }

  const encrypted = encodeJson(pathname, value);
  await putBlob(pathname, encrypted, 'public', { allowOverwrite });
  return { mode: 'public-encrypted' };
}

async function listBlobs(options = {}){
  const { list } = await import('@vercel/blob');
  return callWithAuth(auth => list({ ...options, ...auth }));
}

module.exports = {
  isAuthError,
  isNotFound,
  readJson,
  writeJson,
  listBlobs,
};
