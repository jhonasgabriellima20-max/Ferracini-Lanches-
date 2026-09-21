function storageError(message, cause){
  const error = new Error(message || 'postgres_storage_unavailable');
  error.code = 'STORAGE_UNAVAILABLE';
  if(cause) error.cause = cause;
  return error;
}

function connectionString(){
  const value = String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
  if(!value) throw storageError('database_connection_missing');
  return value;
}

let sqlPromise;
async function getSql(){
  if(!sqlPromise){
    sqlPromise = import('@neondatabase/serverless')
      .then(({ neon }) => neon(connectionString()))
      .catch(err => {
        sqlPromise = null;
        throw storageError('database_driver_unavailable', err);
      });
  }
  return sqlPromise;
}

let schemaPromise;
async function ensureSchema(){
  if(!schemaPromise){
    schemaPromise = (async () => {
      const sql = await getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS ferracini_store (
          pathname TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      return sql;
    })().catch(err => {
      schemaPromise = null;
      if(err?.code === 'STORAGE_UNAVAILABLE') throw err;
      throw storageError('database_schema_unavailable', err);
    });
  }
  return schemaPromise;
}

function isConflict(err){
  return String(err?.code || '') === '23505' ||
    Number(err?.status || err?.statusCode || 0) === 409;
}

function isStorageUnavailable(err){
  if(err?.code === 'STORAGE_UNAVAILABLE') return true;
  const status = Number(err?.status || err?.statusCode || 0);
  if(status === 429 || status >= 500) return true;
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('database_connection_missing') ||
    message.includes('fetch failed') ||
    message.includes('connection') ||
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
    const sql = await ensureSchema();
    const rows = await sql`
      SELECT value
      FROM ferracini_store
      WHERE pathname = ${pathname}
      LIMIT 1
    `;
    return {
      value: rows.length ? normalizeValue(rows[0].value) : null,
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
    const sql = await ensureSchema();
    const body = JSON.stringify(value);

    if(allowOverwrite){
      await sql`
        INSERT INTO ferracini_store (pathname, value)
        VALUES (${pathname}, CAST(${body} AS JSONB))
        ON CONFLICT (pathname)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
    }else{
      try{
        await sql`
          INSERT INTO ferracini_store (pathname, value)
          VALUES (${pathname}, CAST(${body} AS JSONB))
        `;
      }catch(err){
        if(isConflict(err)){
          const conflict = new Error('storage_conflict');
          conflict.code = 'conflict';
          conflict.status = 409;
          throw conflict;
        }
        throw err;
      }
    }

    return { mode: 'postgres' };
  }catch(err){
    if(err?.code === 'conflict' || Number(err?.status || 0) === 409) throw err;
    if(isStorageUnavailable(err)) throw err;
    throw storageError('database_write_failed', err);
  }
}

async function listBlobs(options = {}){
  try{
    const sql = await ensureSchema();
    const prefix = String(options.prefix || '');
    const limit = Math.min(1000, Math.max(1, Number(options.limit) || 100));
    const rows = await sql`
      SELECT
        pathname,
        updated_at AS "uploadedAt",
        OCTET_LENGTH(value::text) AS size
      FROM ferracini_store
      WHERE starts_with(pathname, ${prefix})
      ORDER BY pathname ASC
      LIMIT ${limit}
    `;

    return {
      blobs: rows.map(row => ({
        pathname: row.pathname,
        uploadedAt: row.uploadedAt instanceof Date ? row.uploadedAt.toISOString() : String(row.uploadedAt || ''),
        size: Number(row.size) || 0,
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
