// Fila de impressao exclusiva: sem impacto no POST de pedidos.
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

function authorized(req) {
  const expected = process.env.PRINT_AGENT_TOKEN || '';
  const header = String(req.headers.authorization || '').trim();
  const received = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || '';
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function environment() {
  const connection = process.env.PRINT_QUEUE_DATABASE_URL || '';
  const cutoff = process.env.PRINT_QUEUE_START_AT || '';
  const parsed = new Date(cutoff);
  if (!connection || !cutoff || !Number.isFinite(parsed.getTime())) return null;
  return { sql: neon(connection), cutoff: parsed.toISOString() };
}

function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Authorization');
  if (!['GET', 'PATCH'].includes(req.method)) {
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: 'Metodo nao permitido.' });
  }
  if (!authorized(req)) return res.status(401).json({ error: 'Agente nao autorizado.' });
  const env = environment();
  if (!env) return res.status(503).json({ error: 'Fila de impressao ainda nao ativada.' });

  try {
    if (req.method === 'GET') {
      const requested = Number(req.query?.limit);
      const limit = Number.isInteger(requested) && requested >= 1
        ? Math.min(50, requested) : 25;
      // Filtra no PostgreSQL e evita reler os primeiros 100 pedidos do dia.
      const rows = await env.sql.query(
        "SELECT pathname, value FROM public.ferracini_store " +
        "WHERE pathname LIKE 'pedidos/fila/%' AND created_at >= $1 " +
        "AND value->>'status' = 'pendente' " +
        "ORDER BY created_at ASC, pathname ASC LIMIT $2",
        [env.cutoff, limit]
      );
      return res.status(200).json({
        pedidos: rows.map((row) => ({ ...row.value, pathname: row.pathname })),
        atualizadoEm: new Date().toISOString()
      });
    }

    if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
      return res.status(415).json({ error: 'Envie JSON.' });
    }
    const data = body(req);
    const pathname = String(data.pathname || '').trim();
    const status = String(data.status || '').trim();
    if (!/^pedidos\/fila\/\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9._-]+\.json$/.test(pathname) ||
        !['imprimindo', 'impresso', 'falhou'].includes(status)) {
      return res.status(400).json({ error: 'Pedido ou status invalido.' });
    }

    // Atualizacao condicional atomica impede que dois agentes reivindiquem
    // a mesma comanda simultaneamente.
    const from = status === 'imprimindo' ? 'pendente' : 'imprimindo';
    const timestamp = new Date().toISOString();
    const attemptsIncrement = status === 'imprimindo' ? 1 : 0;
    const printerError = String(data.erro || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 280);
    const rows = await env.sql.query(
      "UPDATE public.ferracini_store SET " +
      "value = value || jsonb_build_object('status', $1::text, 'atualizadoEm', $2::text, " +
      "'tentativasImpressao', COALESCE((value->>'tentativasImpressao')::integer, 0) + $3::integer) " +
      "|| CASE WHEN $1::text = 'impresso' THEN jsonb_build_object('impressoEm', $2::text) " +
      "WHEN $1::text = 'falhou' THEN jsonb_build_object('erroImpressao', $4::text) " +
      "ELSE '{}'::jsonb END, updated_at = now() " +
      "WHERE pathname = $5 AND created_at >= $6 AND value->>'status' = $7 RETURNING pathname",
      [status, timestamp, attemptsIncrement, printerError, pathname, env.cutoff, from]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: 'Comanda ja reivindicada ou em outro estado.' });
    }
    return res.status(200).json({ ok: true, status });
  } catch (err) {
    console.error('[fila-impressao]', err?.message || err);
    return res.status(503).json({ error: 'Fila indisponivel. Pedido preservado no banco.' });
  }
};
