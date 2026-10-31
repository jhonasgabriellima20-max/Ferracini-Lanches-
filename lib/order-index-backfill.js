// Backfill existing reservations without choosing between duplicate orders.
// One statement validates the complete namespace and inserts all or none.
// This creates no schema and never updates reservations or existing indexes.
const VALIDATION_CTES = `
settings AS (
  SELECT $1::text AS ns, $2::boolean AS apply
), source AS MATERIALIZED (
  SELECT s.pathname, s.value, s.value->>'id' AS id, s.value->>'data' AS day,
    settings.ns
  FROM public.ferracini_store AS s CROSS JOIN settings
  WHERE left(s.pathname,length(settings.ns || 'pedidos/aguardando/')) = settings.ns || 'pedidos/aguardando/'
), checked AS MATERIALIZED (
  SELECT source.*,
    COALESCE(
      jsonb_typeof(value) = 'object' AND jsonb_typeof(value->'id') = 'string'
      AND id ~ '^[a-f0-9]{64}$' AND jsonb_typeof(value->'data') = 'string'
      AND CASE WHEN day ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
        THEN substring(day,9,2)::integer <= extract(day FROM
          (make_date(substring(day,1,4)::integer,substring(day,6,2)::integer,1) + interval '1 month - 1 day'))
        ELSE false END
      AND pathname = ns || 'pedidos/aguardando/' || day || '/' || id || '.json',
      false
    ) AS valid
  FROM source
), indexes AS MATERIALIZED (
  SELECT s.pathname,s.value,settings.ns
  FROM public.ferracini_store AS s CROSS JOIN settings
  WHERE left(s.pathname,length(settings.ns || 'pedidos/indice/')) = settings.ns || 'pedidos/indice/'
), stats AS MATERIALIZED (
  SELECT
    (SELECT count(*) FROM checked) AS reservations,
    (SELECT count(*) FROM checked WHERE NOT valid) AS invalid_reservations,
    (SELECT count(*) FROM (SELECT id FROM source GROUP BY id HAVING count(*) > 1) AS duplicates) AS duplicate_ids,
    (SELECT count(*) FROM indexes AS i WHERE NOT EXISTS (
      SELECT 1 FROM checked AS c WHERE c.valid
      AND i.pathname = i.ns || 'pedidos/indice/' || c.id || '.json'
      AND i.value = jsonb_build_object('id',c.id,'pathname',c.pathname)
    )) AS conflicting_indices,
    (SELECT count(*) FROM checked AS c JOIN indexes AS i
      ON i.pathname = c.ns || 'pedidos/indice/' || c.id || '.json'
      WHERE c.valid AND i.value = jsonb_build_object('id',c.id,'pathname',c.pathname)
    ) AS already_indexed
)
`;
const DRY_RUN_SQL = `WITH ${VALIDATION_CTES}
SELECT stats.*, 0::bigint AS inserted,
  (stats.invalid_reservations > 0 OR stats.duplicate_ids > 0 OR stats.conflicting_indices > 0) AS blocked,
  1 AS atomic_guard
FROM stats
`;
const APPLY_SQL = `WITH ${VALIDATION_CTES}, inserted AS (
  INSERT INTO public.ferracini_store(pathname,value,created_at,updated_at)
  SELECT c.ns || 'pedidos/indice/' || c.id || '.json',
    jsonb_build_object('id',c.id,'pathname',c.pathname),now(),now()
  FROM checked AS c CROSS JOIN stats CROSS JOIN settings
  WHERE settings.apply AND c.valid AND stats.invalid_reservations = 0
    AND stats.duplicate_ids = 0 AND stats.conflicting_indices = 0
  ON CONFLICT(pathname) DO NOTHING
  RETURNING pathname
)
SELECT stats.*, (SELECT count(*) FROM inserted) AS inserted,
  (stats.invalid_reservations > 0 OR stats.duplicate_ids > 0 OR stats.conflicting_indices > 0) AS blocked,
  CASE WHEN settings.apply AND stats.invalid_reservations = 0
      AND stats.duplicate_ids = 0 AND stats.conflicting_indices = 0
    THEN 1 / CASE WHEN stats.already_indexed + (SELECT count(*) FROM inserted) = stats.reservations
      THEN 1 ELSE 0 END
    ELSE 1 END AS atomic_guard
FROM stats CROSS JOIN settings
`;

async function backfillOrderIndex(sql,{namespace='',apply=false}={}){
  if(!['','mp-preview/'].includes(namespace)) throw new Error('invalid_backfill_namespace');
  if(typeof apply !== 'boolean' || !sql || typeof sql.query !== 'function') throw new Error('invalid_backfill_options');
  const rows=await sql.query(apply?APPLY_SQL:DRY_RUN_SQL,[namespace,apply]);
  if(!Array.isArray(rows) || rows.length !== 1 || rows[0].atomic_guard !== 1) throw new Error('invalid_backfill_result');
  const result={mode:apply?'apply':'dry-run',blocked:rows[0].blocked === true};
  for(const key of ['reservations','invalid_reservations','duplicate_ids','conflicting_indices','already_indexed','inserted']){
    const value=Number(rows[0][key]);
    if(!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_backfill_result');
    result[key]=value;
  }
  return result;
}
module.exports={backfillOrderIndex};
