const crypto = require('crypto');

const COUNTER_PATH = 'config/comanda-sequencia.json';
const RESERVA_DIR = 'comandas';
const TIME_ZONE = 'America/Sao_Paulo';

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

function isConflict(err){
  const nome = String(err?.name || '').toLowerCase();
  const codigo = String(err?.code || '').toLowerCase();
  const mensagem = String(err?.message || '').toLowerCase();
  return err?.status === 409 || err?.statusCode === 409 ||
    nome.includes('alreadyexists') || nome.includes('conflict') ||
    codigo.includes('already') || codigo.includes('conflict') ||
    mensagem.includes('already exists') || mensagem.includes('already been uploaded') || mensagem.includes('conflict');
}

async function lerUltimo(dataAtual){
  const { get } = await import('@vercel/blob');
  try{
    const result = await get(COUNTER_PATH, { access: 'private', useCache: false });
    if(!result) return 0;
    const text = await new Response(result.stream).text();
    const data = JSON.parse(text);
    if(data?.data !== dataAtual) return 0;
    return Number.isSafeInteger(data?.ultimo) && data.ultimo >= 0 ? data.ultimo : 0;
  }catch(err){
    if(isNotFound(err)) return 0;
    throw err;
  }
}

async function reservarNumero(numero, dataAtual){
  const { put } = await import('@vercel/blob');
  const codigo = String(numero).padStart(2, '0');
  const token = crypto.randomUUID();
  await put(`${RESERVA_DIR}/${dataAtual}/${String(numero).padStart(8,'0')}.json`, JSON.stringify({
    numero,
    codigo,
    data: dataAtual,
    token,
    criadoEm: new Date().toISOString()
  }), {
    access: 'private',
    contentType: 'application/json; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  return codigo;
}

async function salvarUltimo(numero, dataAtual){
  const { put } = await import('@vercel/blob');
  await put(COUNTER_PATH, JSON.stringify({ data: dataAtual, ultimo: numero, updatedAt: new Date().toISOString() }), {
    access: 'private',
    contentType: 'application/json; charset=utf-8',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if(req.method !== 'POST'){
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  try{
    const dataAtual = dataOperacao();
    let candidato = (await lerUltimo(dataAtual)) + 1;
    for(let tentativas = 0; tentativas < 50; tentativas++, candidato++){
      try{
        const codigo = await reservarNumero(candidato, dataAtual);
        try{ await salvarUltimo(candidato, dataAtual); }catch(err){ console.warn('Comanda reservada, mas contador não atualizou:', err); }
        return res.status(200).json({ numero: candidato, codigo, data: dataAtual });
      }catch(err){
        if(isConflict(err)) continue;
        throw err;
      }
    }
    return res.status(503).json({ error: 'Não foi possível gerar a numeração da comanda agora.' });
  }catch(err){
    console.error('Falha ao gerar comanda:', err);
    return res.status(503).json({ error: 'Não foi possível gerar a comanda. Tente novamente.' });
  }
};
