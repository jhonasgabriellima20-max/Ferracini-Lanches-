const crypto = require('crypto');

const TIME_ZONE = 'America/Sao_Paulo';
const FILA_DIR = 'pedidos/fila';

function passwordOk(recebida, esperada){
  if(!recebida || !esperada) return false;
  const a = Buffer.from(String(recebida));
  const b = Buffer.from(String(esperada));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function dataOperacao(){
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function isNotFound(err){
  return err?.status === 404 || err?.statusCode === 404 || err?.code === 'not_found' || err?.code === 'BLOB_NOT_FOUND';
}

async function lerJson(pathname){
  const { get } = await import('@vercel/blob');
  try{
    const result = await get(pathname, { access: 'private', useCache: false });
    if(!result) return null;
    return JSON.parse(await new Response(result.stream).text());
  }catch(err){
    if(isNotFound(err)) return null;
    throw err;
  }
}

async function listarPedidos(data, limite){
  const { list } = await import('@vercel/blob');
  const resultado = await list({ prefix: `${FILA_DIR}/${data}/`, limit: Math.min(100, Math.max(1, limite || 50)) });
  const pedidos = [];
  for(const blob of resultado.blobs || []){
    try{
      const pedido = await lerJson(blob.pathname);
      if(pedido) pedidos.push(pedido);
    }catch(err){
      console.warn('[painel-pedidos] leitura_falhou', { pathname: blob.pathname, error: String(err) });
    }
  }
  pedidos.sort((a,b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')));
  return pedidos;
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if(req.method !== 'GET'){
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if(!adminPassword){
    return res.status(503).json({ error: 'Senha administrativa não configurada.' });
  }
  if(!passwordOk(req.headers['x-admin-password'], adminPassword)){
    return res.status(401).json({ error: 'Senha administrativa incorreta.' });
  }

  try{
    const data = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.data || '')) ? String(req.query.data) : dataOperacao();
    const pedidos = await listarPedidos(data, Number(req.query?.limit) || 50);
    return res.status(200).json({ data, pedidos, atualizadoEm: new Date().toISOString() });
  }catch(err){
    console.error('[painel-pedidos] listagem_falhou', { error: String(err) });
    return res.status(503).json({ error: 'Não foi possível carregar os pedidos agora.' });
  }
};
