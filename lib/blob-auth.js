function blobAuthOptions(){
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();
  if(token) return { token };

  const oidcToken = String(process.env.VERCEL_OIDC_TOKEN || '').trim();
  const storeId = String(process.env.BLOB_STORE_ID || '').trim();
  if(oidcToken && storeId) return { oidcToken, storeId };

  return {};
}

module.exports = { blobAuthOptions };
