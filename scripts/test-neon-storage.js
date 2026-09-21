const { readJson, writeJson, listBlobs } = require('../lib/postgres-storage');

(async () => {
  const pathname = '__health__/preview-storage.json';
  const marker = {
    ok: true,
    commit: String(process.env.VERCEL_GIT_COMMIT_SHA || 'unknown'),
    environment: String(process.env.VERCEL_ENV || 'unknown'),
  };

  await writeJson(pathname, marker, { allowOverwrite: true });

  const read = await readJson(pathname);
  if(!read || read.mode !== 'postgres' || !read.value || read.value.ok !== true){
    throw new Error('neon_storage_read_failed');
  }

  const listed = await listBlobs({ prefix: '__health__/', limit: 10 });
  if(!listed || !Array.isArray(listed.blobs) || !listed.blobs.some(item => item.pathname === pathname)){
    throw new Error('neon_storage_list_failed');
  }

  console.log('NEON_STORAGE_OK');
})().catch(err => {
  console.error('NEON_STORAGE_FAIL', String(err?.message || err));
  process.exit(43);
});
