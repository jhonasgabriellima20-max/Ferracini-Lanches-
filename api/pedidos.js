const crypto = require('crypto');
const CATALOGO = require('./catalogo.json');
const { calcularDistanciaEndereco } = require('../lib/delivery-distance');
const { readJson, writeJson, listBlobs } = require('../lib/blob-storage');

const TIME_ZONE = 'America/Sao_Paulo';
const COUNTER_PATH = 'config/pedidos-sequencia.json';
const RESERVA_DIR = 'pedidos/reservas';
const FILA_DIR = 'pedidos/fila';
const IDEMPOTENCIA_DIR = 'pedidos/idempotencia';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ROUTE_KM = 35;
const MAX_DISTANCE_DELTA_KM = 0.35;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 15;
const buckets = globalThis.__ferraciniPedidosRateBuckets || new Map();
globalThis.__ferraciniPedidosRateBuckets = buckets;

function dataOperacao(){
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}


function partesHorarioLoja(agora = new Date()){
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(agora);
  const values = {};
  parts.forEach(part => { if(part.type !== 'literal') values[part.type] = part.value; });
  const dias = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return {
    dia: dias[values.weekday],
    minutos: Number(values.hour) * 60 + Number(values.minute),
  };
}

function statusHorarioPedidos(agora = new Date()){
  const { dia, minutos } = partesHorarioLoja(agora);
  const entre = (inicio, fim) => minutos >= inicio && minutos < fim;
  let aberto = false;

  if(dia >= 1 && dia <= 4) aberto = entre(18 * 60, 23 * 60);
  if(dia === 5) aberto = minutos >= 18 * 60;
  if(dia === 6) aberto = minutos < 60 || minutos >= 18 * 60;
  if(dia === 0) aberto = minutos < 60 || entre(19 * 60, 23 * 60);

  return {
    aberto,
    mensagem: aberto
      ? 'Pedidos online abertos agora.'
      : 'Estamos fechados no momento. Horários: seg–qui 18h às 23h; sex–sáb 18h à 1h; domingo 19h às 23h.',
  };
}

function texto(value, max = 200){
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function inteiro(value, min, max){
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function taxaServicoCentavosPorDistancia(distanciaKm){
  if(!Number.isFinite(distanciaKm) || distanciaKm <= 0) return null;
  if(distanciaKm <= 5) return 300;
  if(distanciaKm <= 10) return 600;
  return 1000;
}

function taxaEntregaCentavosPorDistancia(distanciaKm){
  if(!Number.isFinite(distanciaKm) || distanciaKm <= 0) return null;
  return Math.ceil((distanciaKm * 2.30) - 1e-9) * 100;
}

function isNotFound(err){
  return err?.status === 404 || err?.statusCode === 404 ||
    err?.code === 'not_found' || err?.code === 'BLOB_NOT_FOUND';
}

function isConflict(err){
  const value = [err?.name, err?.code, err?.message].map(item => String(item || '').toLowerCase()).join(' ');
  return err?.status === 409 || err?.statusCode === 409 ||
    value.includes('already') || value.includes('conflict');
}

function secureEqual(recebido, esperado){
  if(!recebido || !esperado) return false;
  const a = Buffer.from(String(recebido));
  const b = Buffer.from(String(esperado));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenAgente(req){
  const authorization = texto(req.headers.authorization, 500);
  if(/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return texto(req.headers['x-print-agent-token'], 500);
}

function agenteAutorizado(req){
  return secureEqual(tokenAgente(req), process.env.PRINT_AGENT_TOKEN || '');
}

function origemPermitida(req){
  if(String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = texto(req.headers.origin, 300);
  if(!origin) return true;
  try{
    const url = new URL(origin);
    if(url.protocol !== 'https:' && url.hostname !== 'localhost') return false;
    return url.hostname === 'ferracinilanches.com.br' ||
      url.hostname === 'www.ferracinilanches.com.br' ||
      /^ferracini-lanches(?:-[a-z0-9-]+)?(?:-jho-n)?\.vercel\.app$/i.test(url.hostname) ||
      url.hostname === 'localhost';
  }catch{
    return false;
  }
}

function rateLimit(req){
  const now = Date.now();
  const key = texto(
    String(req.headers['x-vercel-forwarded-for'] || '').split(',')[0] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0] ||
    req.headers['x-real-ip'] ||
    'unknown',
    100
  );
  const current = buckets.get(key);
  if(!current || current.resetAt <= now){
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  current.count += 1;
  if(buckets.size > 1000){
    for(const [bucketKey, value] of buckets){
      if(value.resetAt <= now) buckets.delete(bucketKey);
    }
  }
  return {
    ok: current.count <= RATE_MAX,
    retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

async function lerJson(pathname){
  return (await readJson(pathname)).value;
}

async function gravarJson(pathname, value, allowOverwrite){
  await writeJson(pathname, value, { allowOverwrite });
}

async function lerUltimo(dataAtual){
  const value = await lerJson(COUNTER_PATH);
  if(!value || value.data !== dataAtual) return 0;
  return Number.isSafeInteger(value.ultimo) && value.ultimo >= 0 ? value.ultimo : 0;
}

async function reservarNumero(numero, dataAtual){
  const codigo = String(numero).padStart(2, '0');
  await gravarJson(
    `${RESERVA_DIR}/${dataAtual}/${String(numero).padStart(8, '0')}.json`,
    { numero, codigo, data: dataAtual, criadoEm: new Date().toISOString() },
    false
  );
  return codigo;
}

async function proximoNumero(dataAtual){
  let candidato = (await lerUltimo(dataAtual)) + 1;
  for(let tentativa = 0; tentativa < 100; tentativa++, candidato++){
    try{
      const codigo = await reservarNumero(candidato, dataAtual);
      try{
        await gravarJson(COUNTER_PATH, {
          data: dataAtual,
          ultimo: candidato,
          updatedAt: new Date().toISOString(),
        }, true);
      }catch(err){
        console.warn('[pedidos] contador_nao_atualizado', { numero: candidato, error: String(err) });
      }
      return { numero: candidato, codigo };
    }catch(err){
      if(isConflict(err)) continue;
      throw err;
    }
  }
  throw new Error('limite_de_reservas_excedido');
}

function validarItem(raw){
  const nome = texto(raw?.nome, 100);
  const quantidade = inteiro(raw?.quantidade, 1, 20);
  const precoUnitarioCentavos = inteiro(raw?.precoUnitarioCentavos, 0, 100000);
  const adicionaisRaw = Array.isArray(raw?.adicionais) ? raw.adicionais : [];
  const produto = CATALOGO.produtos[nome];

  if(!produto || quantidade === null || precoUnitarioCentavos !== produto.precoCentavos ||
     adicionaisRaw.length > 20 || (!produto.aceitaAdicionais && adicionaisRaw.length > 0)){
    return null;
  }

  const adicionais = adicionaisRaw.map(item => ({
    nome: texto(item?.nome, 80),
    precoCentavos: inteiro(item?.precoCentavos, 0, 50000),
  }));
  const nomesAdicionais = new Set(adicionais.map(item => item.nome));
  if(nomesAdicionais.size !== adicionais.length) return null;
  if(adicionais.some(item =>
    !item.nome ||
    item.precoCentavos === null ||
    CATALOGO.adicionais[item.nome] !== item.precoCentavos
  )){
    return null;
  }

  return {
    nome,
    quantidade,
    precoUnitarioCentavos,
    adicionais,
    observacao: texto(raw?.observacao, 300),
  };
}

function validarPayload(raw){
  if(!raw || typeof raw !== 'object') throw new Error('Pedido inválido.');
  const clientRequestId = texto(raw.clientRequestId, 128);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(clientRequestId)){
    throw new Error('Identificador do pedido inválido.');
  }

  const nome = texto(raw.cliente?.nome, 80);
  const telefone = texto(raw.cliente?.telefone, 30);
  const telefoneDigitos = telefone.replace(/\D/g, '');
  if(nome.length < 2) throw new Error('Informe o nome do cliente.');
  if(telefoneDigitos.length < 8 || telefoneDigitos.length > 15){
    throw new Error('Informe um telefone válido.');
  }

  if(!Array.isArray(raw.itens) || raw.itens.length < 1 || raw.itens.length > 40){
    throw new Error('O pedido precisa ter entre 1 e 40 itens.');
  }
  const itens = raw.itens.map(validarItem);
  if(itens.some(item => !item)) throw new Error('Há um item inválido no pedido.');

  const tipo = texto(raw.atendimento?.tipo, 20);
  if(!['retirada', 'entrega', 'mesa'].includes(tipo)) throw new Error('Tipo de atendimento inválido.');

  const atendimento = { tipo };
  if(tipo === 'retirada'){
    // Taxa fixa de serviço para retirada no local.
    atendimento.taxaServicoCentavos = 300;
    atendimento.estimativaMinutos = { minimo: 45, maximo: 60 };
  }
  if(tipo === 'mesa'){
    const mesa = inteiro(Number(raw.atendimento?.mesa), 1, 999);
    if(mesa === null) throw new Error('Número da mesa inválido.');
    atendimento.mesa = mesa;
  }
  if(tipo === 'entrega'){
    const endereco = {
      rua: texto(raw.atendimento?.endereco?.rua, 120),
      numero: texto(raw.atendimento?.endereco?.numero, 20),
      complemento: texto(raw.atendimento?.endereco?.complemento, 100),
      bairro: texto(raw.atendimento?.endereco?.bairro, 100),
      cidade: texto(raw.atendimento?.endereco?.cidade, 80),
      cep: texto(raw.atendimento?.endereco?.cep, 10),
    };
    if(!endereco.rua || !endereco.numero || !endereco.bairro || !endereco.cidade){
      throw new Error('Endereço de entrega incompleto.');
    }
    if(endereco.cidade.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() !== 'londrina'){
      throw new Error('A entrega automática atende somente Londrina.');
    }

    const distanciaKm = Number(raw.atendimento?.distanciaKm);
    const taxaEntregaCentavos = inteiro(raw.atendimento?.taxaEntregaCentavos, 0, 100000);
    const taxaServicoCentavos = inteiro(raw.atendimento?.taxaServicoCentavos, 0, 100000);
    if(!Number.isFinite(distanciaKm) || distanciaKm <= 0 || distanciaKm > MAX_ROUTE_KM ||
       taxaEntregaCentavos === null || taxaEntregaCentavos % 100 !== 0 ||
       taxaServicoCentavos === null || taxaServicoCentavos % 100 !== 0){
      throw new Error('Frete inválido. Calcule novamente.');
    }
    const esperado = taxaEntregaCentavosPorDistancia(distanciaKm);
    if(taxaEntregaCentavos !== esperado) throw new Error('A taxa de entrega não confere. Calcule novamente.');
    const servicoEsperado = taxaServicoCentavosPorDistancia(distanciaKm);
    if(taxaServicoCentavos !== servicoEsperado) throw new Error('A taxa de serviço não confere. Calcule novamente.');

    atendimento.endereco = endereco;
    atendimento.distanciaKm = Math.round(distanciaKm * 100) / 100;
    atendimento.taxaEntregaCentavos = taxaEntregaCentavos;
    atendimento.taxaServicoCentavos = taxaServicoCentavos;
    const minimo = inteiro(raw.atendimento?.estimativaMinutos?.minimo, 1, 240);
    const maximo = inteiro(raw.atendimento?.estimativaMinutos?.maximo, 1, 240);
    if(minimo !== null && maximo !== null && maximo >= minimo){
      atendimento.estimativaMinutos = { minimo, maximo };
    }
  }

  const metodo = texto(raw.pagamento?.metodo, 20);
  if(!['cartao', 'dinheiro'].includes(metodo)) throw new Error('Forma de pagamento inválida.');
  const pagamento = {
    metodo,
    precisaTroco: metodo === 'dinheiro' && raw.pagamento?.precisaTroco === true,
  };

  const subtotalCentavos = itens.reduce((total, item) => {
    const adicionais = item.adicionais.reduce((sum, adicional) => sum + adicional.precoCentavos, 0);
    return total + item.quantidade * (item.precoUnitarioCentavos + adicionais);
  }, 0);
  if(!Number.isSafeInteger(subtotalCentavos) || subtotalCentavos <= 0 || subtotalCentavos > 5000000){
    throw new Error('Valor do pedido inválido.');
  }
  const totalCentavos = subtotalCentavos + (atendimento.taxaEntregaCentavos || 0) + (atendimento.taxaServicoCentavos || 0);

  if(pagamento.precisaTroco){
    const trocoParaCentavos = inteiro(raw.pagamento?.trocoParaCentavos, totalCentavos, 10000000);
    if(trocoParaCentavos === null) throw new Error('Valor do troco inválido.');
    pagamento.trocoParaCentavos = trocoParaCentavos;
  }

  return {
    clientRequestId,
    origem: texto(raw.origem, 20) === 'mesa' ? 'mesa' : 'site',
    cliente: { nome, telefone },
    itens,
    atendimento,
    pagamento,
    subtotalCentavos,
    totalCentavos,
  };
}

async function validarEntregaNoServidor(payload){
  if(payload.atendimento.tipo !== 'entrega') return payload;

  let resultado;
  try{
    resultado = await calcularDistanciaEndereco(payload.atendimento.endereco);
  }catch(err){
    console.error('[pedidos] validacao_distancia_indisponivel', { error: String(err) });
    const error = new Error('Não foi possível validar a entrega agora.');
    error.code = 'DELIVERY_VALIDATION_UNAVAILABLE';
    throw error;
  }

  const distanciaServidor = Math.round(resultado.distanciaKm * 100) / 100;
  const delta = Math.abs(distanciaServidor - payload.atendimento.distanciaKm);
  if(delta > MAX_DISTANCE_DELTA_KM){
    console.warn('[pedidos] distancia_divergente', {
      cliente: payload.atendimento.distanciaKm,
      servidor: distanciaServidor,
      provider: resultado.provider,
    });
    throw new Error('A distância de entrega não confere. Calcule novamente.');
  }

  const entregaEsperada = taxaEntregaCentavosPorDistancia(distanciaServidor);
  const servicoEsperado = taxaServicoCentavosPorDistancia(distanciaServidor);
  if(payload.atendimento.taxaEntregaCentavos !== entregaEsperada){
    throw new Error('A taxa de entrega não confere. Calcule novamente.');
  }
  if(payload.atendimento.taxaServicoCentavos !== servicoEsperado){
    throw new Error('A taxa de serviço não confere. Calcule novamente.');
  }

  payload.atendimento.distanciaKm = distanciaServidor;
  payload.totalCentavos = payload.subtotalCentavos + entregaEsperada + servicoEsperado;
  if(payload.pagamento.precisaTroco && payload.pagamento.trocoParaCentavos < payload.totalCentavos){
    throw new Error('Valor do troco inválido.');
  }
  return payload;
}

function hashId(value){
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function criarPedido(payload){
  const data = dataOperacao();
  const idemPath = `${IDEMPOTENCIA_DIR}/${data}/${hashId(payload.clientRequestId)}.json`;
  const existente = await lerJson(idemPath);
  if(existente?.pathname){
    const pedidoExistente = await lerJson(existente.pathname);
    if(pedidoExistente) return { pedido: pedidoExistente, duplicado: true };
  }

  const sequencia = await proximoNumero(data);
  const id = crypto.randomUUID();
  const agora = new Date().toISOString();
  const pathname = `${FILA_DIR}/${data}/${String(sequencia.numero).padStart(8, '0')}-${id}.json`;
  const pedido = {
    id,
    numero: sequencia.codigo,
    numeroSequencial: sequencia.numero,
    data,
    criadoEm: agora,
    atualizadoEm: agora,
    status: 'pendente',
    tentativasImpressao: 0,
    ...payload,
  };

  await gravarJson(pathname, pedido, false);
  await gravarJson(idemPath, { pathname, numero: sequencia.codigo, criadoEm: agora }, true);
  return { pedido, pathname, duplicado: false };
}

async function listarPedidos(req){
  const data = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.data || ''))
    ? String(req.query.data)
    : dataOperacao();
  const limite = Math.min(100, Math.max(1, Number(req.query?.limit) || 50));
  const resultado = await listBlobs({ prefix: `${FILA_DIR}/${data}/`, limit: limite });
  const pedidos = [];
  for(const blob of resultado.blobs || []){
    try{
      const pedido = await lerJson(blob.pathname);
      if(pedido) pedidos.push({ ...pedido, pathname: blob.pathname });
    }catch(err){
      console.warn('[pedidos] leitura_item_falhou', { pathname: blob.pathname, error: String(err) });
    }
  }
  pedidos.sort((a, b) => String(a.criadoEm).localeCompare(String(b.criadoEm)));
  return pedidos;
}

async function atualizarPedido(raw){
  const pathname = texto(raw?.pathname, 500);
  if(!/^pedidos\/fila\/\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9._-]+\.json$/.test(pathname)){
    throw new Error('Pedido inválido.');
  }
  const status = texto(raw?.status, 30);
  if(!['pendente', 'imprimindo', 'impresso', 'falhou'].includes(status)){
    throw new Error('Status inválido.');
  }
  const pedido = await lerJson(pathname);
  if(!pedido) throw new Error('Pedido não encontrado.');
  pedido.status = status;
  pedido.atualizadoEm = new Date().toISOString();
  if(status === 'imprimindo' || status === 'falhou'){
    pedido.tentativasImpressao = (Number(pedido.tentativasImpressao) || 0) + 1;
  }
  if(status === 'impresso') pedido.impressoEm = pedido.atualizadoEm;
  if(status === 'falhou') pedido.erroImpressao = texto(raw?.erro, 300);
  await gravarJson(pathname, pedido, true);
  return pedido;
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Vary', 'Authorization, X-Print-Agent-Token');

  if(req.method === 'GET' || req.method === 'PATCH'){
    if(!process.env.PRINT_AGENT_TOKEN || !agenteAutorizado(req)){
      res.setHeader('WWW-Authenticate', 'Bearer realm="Ferracini Print Agent"');
      return res.status(401).json({ error: 'Token do agente de impressão inválido.' });
    }
  }

  if(req.method === 'GET'){
    try{
      return res.status(200).json({ pedidos: await listarPedidos(req), data: dataOperacao() });
    }catch(err){
      console.error('[pedidos] listagem_falhou', { error: String(err) });
      return res.status(503).json({ error: 'Não foi possível consultar a fila de impressão.' });
    }
  }

  if(req.method === 'PATCH'){
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if(!contentType.includes('application/json')){
      return res.status(415).json({ error: 'Conteúdo deve ser enviado em JSON.' });
    }
    try{
      return res.status(200).json({ pedido: await atualizarPedido(req.body || {}) });
    }catch(err){
      const message = err?.message || 'Não foi possível atualizar o pedido.';
      return res.status(message === 'Pedido não encontrado.' ? 404 : 400).json({ error: message });
    }
  }

  if(req.method === 'POST'){
    const horario = statusHorarioPedidos();
    if(!horario.aberto) return res.status(403).json({ error: horario.mensagem, pedidosAbertos: false });
    if(!origemPermitida(req)) return res.status(403).json({ error: 'Origem não permitida.' });
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if(!contentType.includes('application/json')){
      return res.status(415).json({ error: 'Conteúdo deve ser enviado em JSON.' });
    }
    const contentLength = Number(req.headers['content-length'] || 0);
    if(contentLength > MAX_BODY_BYTES) return res.status(413).json({ error: 'Pedido muito grande.' });
    const limit = rateLimit(req);
    res.setHeader('X-RateLimit-Limit', String(RATE_MAX));
    if(!limit.ok){
      res.setHeader('Retry-After', String(limit.retryAfter));
      return res.status(429).json({ error: 'Muitos pedidos em sequência. Aguarde um minuto e tente novamente.' });
    }

    try{
      let body = req.body;
      if(typeof body === 'string') body = JSON.parse(body || '{}');
      const payload = await validarEntregaNoServidor(validarPayload(body));
      const registro = await criarPedido(payload);
      return res.status(registro.duplicado ? 200 : 201).json({
        pedido: {
          id: registro.pedido.id,
          numero: registro.pedido.numero,
          data: registro.pedido.data,
          status: registro.pedido.status,
        },
        duplicado: registro.duplicado,
        impressaoAtiva: Boolean(process.env.PRINT_AGENT_TOKEN),
      });
    }catch(err){
      const message = err instanceof SyntaxError ? 'JSON inválido.' : (err?.message || 'Não foi possível registrar o pedido.');
      const erroDoCliente = err instanceof SyntaxError || [
        'Pedido inválido.',
        'Identificador do pedido inválido.',
        'Informe o nome do cliente.',
        'Informe um telefone válido.',
        'O pedido precisa ter entre 1 e 40 itens.',
        'Há um item inválido no pedido.',
        'Tipo de atendimento inválido.',
        'Número da mesa inválido.',
        'Endereço de entrega incompleto.',
        'A entrega automática atende somente Londrina.',
        'Frete inválido. Calcule novamente.',
        'A distância de entrega não confere. Calcule novamente.',
        'A taxa de entrega não confere. Calcule novamente.',
        'A taxa de serviço não confere. Calcule novamente.',
        'Forma de pagamento inválida.',
        'Valor do pedido inválido.',
        'Valor do troco inválido.',
        'JSON inválido.',
      ].includes(message);
      if(erroDoCliente) return res.status(400).json({ error: message });
      console.error('[pedidos] criacao_falhou', { error: String(err), code: err?.code });
      return res.status(503).json({ error: 'Não foi possível registrar a comanda agora.' });
    }
  }

  res.setHeader('Allow', 'GET, POST, PATCH');
  return res.status(405).json({ error: 'Método não permitido.' });
};
