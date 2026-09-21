const { readJson, writeJson, listBlobs } = require('../lib/postgres-storage');

function fail(code, label, err){
  const status = Number(err?.status || err?.statusCode || 0);
  console.error(label, { status, code: String(err?.code || ''), message: String(err?.message || err || '') });
  process.exit(code);
}

(async () => {
  const pathname = '__health__/preview-storage.json';
  const marker = {
    ok: true,
    commit: String(process.env.VERCEL_GIT_COMMIT_SHA || 'unknown'),
    environment: String(process.env.VERCEL_ENV || 'unknown'),
  };

  try{
    await writeJson(pathname, marker, { allowOverwrite: true });
  }catch(err){
    const status = Number(err?.status || err?.statusCode || 0);
    if(String(err?.message || '').toLowerCase().includes('oidc')) fail(40, 'OIDC_FAIL', err);
    if(status === 401) fail(41, 'DATA_API_401', err);
    if(status === 403) fail(42, 'DATA_API_403', err);
    if(status === 409) fail(43, 'DATA_API_409', err);
    fail(44, 'WRITE_FAIL', err);
  }

  let read;
  try{
    read = await readJson(pathname);
  }catch(err){
    fail(45, 'READ_FAIL', err);
  }
  if(!read || read.mode !== 'postgres' || !read.value || read.value.ok !== true){
    fail(46, 'READ_VERIFY_FAIL', new Error('read_value_invalid'));
  }

  let listed;
  try{
    listed = await listBlobs({ prefix: '__health__/', limit: 10 });
  }catch(err){
    fail(47, 'LIST_FAIL', err);
  }
  if(!listed || !Array.isArray(listed.blobs) || !listed.blobs.some(item => item.pathname === pathname)){
    fail(48, 'LIST_VERIFY_FAIL', new Error('list_value_invalid'));
  }

  console.log('NEON_STORAGE_OK');
})().catch(err => fail(49, 'UNKNOWN_FAIL', err));

// retry after preview RLS refresh

// retry using OIDC sub as Postgres role
