const { dataOperacao } = require('../assets/dia-operacao');
const crypto = require('crypto');
const CATALOGO = require('./catalogo.json');
const { calcularDistanciaEndereco } = require('../lib/delivery-distance');
const { validarCotacao } = require('../lib/delivery-quote');
const reservations = require('../lib/order-reservations');
const { calcularTempoInternoLanches, calcularFilaTempoInterno, listarPedidosRecentes, estimarPrazo } = require('../lib/prep-estimator');
const { isStorageUnavailable: isDatabaseUnavailable, readJson, writeJson, listBlobs } = require('../lib/postgres-storage');

const TIME_ZONE = 'America/Sao_Paulo';
// Preview reservations and counters must never reach the live kitchen.
const STORAGE_NAMESPACE = process.env.VERCEL_ENV === 'preview' ? 'mp-preview/' : '';
const COUNTER_PATH = STORAGE_NAMESPACE + 'config/pedidos-sequencia.json';
const RESERVA_DIR = STORAGE_NAMESPACE + 'pedidos/reservas';
const FILA_DIR = STORAGE_NAMESPACE + 'pedidos/fila';
const AGUARDANDO_DIR = STORAGE_NAMESPACE + 'pedidos/aguardando';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ROUTE_KM = 35;
const MAX_DISTANCE_DELTA_KM = 0.35;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 15;
const buckets = globalThis.__ferraciniPedidosRateBuckets || new Map();
globalThis.__ferraciniPedidosRateBuckets = buckets;




async function statusHorarioPedidos(){
  return require('./disponibilidade').readStoreStatus();
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
  return Math.ceil((distanciaKm * 3.00) - 1e-9) * 100;
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

function isStorageUnavailable(err){
  if(isDatabaseUnavailable(err)) return true;
  const status = Number(err?.status || err?.statusCode || 0);
  const message = String(err?.message || err || '').toLowerCase();
  return status === 429 || status >= 500 ||
    message.includes('storage_unavailable') ||
    message.includes('database_') ||
    message.includes('temporarily unavailable') ||
    message.includes('service unavailable') ||
    message.includes('too many requests') ||
    message.includes('timeout') ||
    message.includes('timed out');
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
  // Preserva a sequência do dia da implantação; dias novos começam em 01.
  const value = await lerJson(`${COUNTER_PATH}.${dataAtual}`) ||
    await lerJson(`${COUNTER_PATH}.${dataAtual.slice(0, 7)}`) || await lerJson(COUNTER_PATH);
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
        await gravarJson(`${COUNTER_PATH}.${dataAtual}`, {
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

function validarItem(raw, catalogo = CATALOGO){
  const nome = texto(raw?.nome, 100);
  const quantidade = inteiro(raw?.quantidade, 1, 20);
  const precoUnitarioCentavos = inteiro(raw?.precoUnitarioCentavos, 0, 100000);
  const adicionaisRaw = Array.isArray(raw?.adicionais) ? raw.adicionais : [];
  const produto = Object.hasOwn(catalogo.produtos, nome) ? catalogo.produtos[nome] : null;

  const tipoHamburguer = raw?.tipoHamburguer;
  if(produto?.temHamburguer && !['industrializado', 'artesanal'].includes(tipoHamburguer)) return null;
  if(!produto?.temHamburguer && tipoHamburguer) return null;
  const acrescimoHamburguer = tipoHamburguer === 'artesanal' ? (nome === 'PROMOÇÂO 4 X-SALADA 1 GUARATUBA .' ? 3600 : 900) : 0;
  if(!produto || quantidade === null || precoUnitarioCentavos !== produto.precoCentavos + acrescimoHamburguer ||
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
    catalogo.adicionais[item.nome] !== item.precoCentavos
  )){
    return null;
  }

  return {
    nome: tipoHamburguer ? `${nome} — ${tipoHamburguer}` : nome,
    ...(tipoHamburguer ? { tipoHamburguer } : {}),
    quantidade,
    precoUnitarioCentavos,
    adicionais,
    observacao: texto(raw?.observacao, 300),
    // A categoria e confiavel somente quando vem do catalogo do servidor.
    ...(produto.categoria ? { categoria: produto.categoria } : {}),
  };
}

function validarPayload(raw, catalogo = CATALOGO){
  if(!raw || typeof raw !== 'object') throw new Error('Pedido inválido.');
  const clientRequestId = texto(raw.clientRequestId, 128);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(clientRequestId)){
    throw new Error('Identificador do pedido inválido.');
  }

  const tipo = texto(raw.atendimento?.tipo, 20);
  if(!['retirada', 'entrega', 'mesa'].includes(tipo)) throw new Error('Tipo de atendimento inválido.');

  const nome = texto(raw.cliente?.nome, 80);
  const telefone = texto(raw.cliente?.telefone, 30);
  const telefoneDigitos = telefone.replace(/\D/g, '');
  if(nome.length < 2) throw new Error('Informe o nome do cliente.');
  if(tipo === 'mesa'){
    if(telefoneDigitos.length > 0 && (telefoneDigitos.length < 8 || telefoneDigitos.length > 15)){
      throw new Error('Informe um telefone válido ou deixe o campo em branco.');
    }
  }else if(telefoneDigitos.length < 8 || telefoneDigitos.length > 15){
    throw new Error('Informe um telefone válido.');
  }

  if(!Array.isArray(raw.itens) || raw.itens.length < 1 || raw.itens.length > 40){
    throw new Error('O pedido precisa ter entre 1 e 40 itens.');
  }
  const itens = raw.itens.map(item => validarItem(item, catalogo));
  if(itens.some(item => !item)) throw new Error('Há um item inválido no pedido.');

  const atendimento = { tipo };
  if(tipo === 'retirada' || tipo === 'mesa'){
    // Taxa fixa de serviço para retirada e consumo no local.
    atendimento.taxaServicoCentavos = 300;
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
    const cotacaoFrete = texto(raw.atendimento?.cotacaoFrete, 1000);
    if(cotacaoFrete) atendimento.cotacaoFrete = cotacaoFrete;
    atendimento.distanciaKm = Math.round(distanciaKm * 100) / 100;
    atendimento.taxaEntregaCentavos = taxaEntregaCentavos;
    atendimento.taxaServicoCentavos = taxaServicoCentavos;
  }

  const metodo = tipo === 'mesa' && !raw.pagamento?.metodo ? 'no_local' : texto(raw.pagamento?.metodo, 20);
  // "cartao" permanece aceito por compatibilidade com páginas antigas ainda abertas
  // no navegador. A interface nova envia "credito" ou "debito".
  if(!(tipo === 'mesa' && metodo === 'no_local') && !['dinheiro', 'credito', 'debito', 'cartao'].includes(metodo)) throw new Error('Forma de pagamento inválida.');
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

  // Uma cotacao assinada preserva a tarifa apresentada ao cliente, mesmo
  // que o Google encontre outra rota ao confirmar o pedido.
  if(payload.atendimento.cotacaoFrete){
    const autentica = validarCotacao(
      payload.atendimento.cotacaoFrete,
      payload.atendimento.endereco,
      payload.atendimento.distanciaKm
    );
    delete payload.atendimento.cotacaoFrete;
    if(!autentica){
      throw new Error('A cotação do frete expirou ou o endereço mudou. Calcule novamente.');
    }
    return payload;
  }

  // Compatibilidade temporaria com navegadores antigos: revalida a rota.
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

async function aplicarEstimativaInteligente(payload){
  if(!payload.atendimento) return payload;

  delete payload.atendimento.estimativaMinutos;
  delete payload.atendimento.estimativaDetalhes;

  const tempo = calcularTempoInternoLanches(payload.itens);
  payload.atendimento.tempoInternoMinutos = tempo;

  if(payload.atendimento.tipo === 'entrega'){
    try{
      const config = await require('./disponibilidade').readPrepConfig();
      const previsao = await estimarPrazo({
        itens: payload.itens,
        tipo: 'entrega',
        distanciaKm: payload.atendimento.distanciaKm,
        config,
      });
      payload.atendimento.estimativaMinutos = previsao.estimativaMinutos;
      payload.atendimento.estimativaDetalhes = {
        filaMinutos: previsao.filaMinutos,
        preparoMinutos: previsao.preparoMinutos,
        deslocamentoMinutos: previsao.deslocamentoMinutos,
        limiteAtingido: previsao.limiteAtingido,
      };
    }catch(err){
      console.warn('[pedidos] previsao_entrega_indisponivel', { error: String(err) });
    }
  }

  return payload;
}

function hashId(value){
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function criarPedido(payload){
  const data = dataOperacao();
  const id = hashId(payload.clientRequestId);
  const pathname = `${AGUARDANDO_DIR}/${data}/${id}.json`;
  const mp = require('../lib/mp-checkout');
  const previous = await reservations.find(id);
  if(previous){
    await mp.ensureOrderIndex(previous.order, previous.path);
    return { pedido: previous.order, pathname: previous.path, duplicado: true };
  }
  const agora = new Date().toISOString();
  const pedido = {
    id,
    referencia: payload.clientRequestId.replace(/[^a-zA-Z0-9]/g, '').slice(-10).toUpperCase(),
    data,
    criadoEm: agora,
    atualizadoEm: agora,
    status: payload.pagamento?.fluxo === 'mercadopago' ? 'aguardando_pagamento' : 'aguardando_whatsapp',
    tentativasImpressao: 0,
    ...payload,
  };
  try{ await gravarJson(pathname, pedido, false); }
  catch(err){
    if(!isConflict(err)) throw err;
    const existente = await lerJson(pathname);
    const selected = await reservations.bind(existente, pathname);
    await mp.ensureOrderIndex(selected.order, selected.path);
    return { pedido: selected.order, pathname:selected.path, duplicado: true };
  }
  const selected = await reservations.bind(pedido, pathname);
  await mp.ensureOrderIndex(selected.order, selected.path);
  return { pedido:selected.order, pathname:selected.path, duplicado:selected.path !== pathname };
}

async function confirmarPedido(id){
  if(!/^[a-f0-9]{64}$/.test(id)) throw new Error('Referência inválida.');
  const found = await reservations.find(id);
  let pedido = found?.order;
  const pathname = found?.path;
  if(!pedido) throw new Error('Tentativa não encontrada hoje.');
  const data = pedido.data;
  if(pedido.pagamento?.fluxo === 'mercadopago' &&
     await lerJson(`${STORAGE_NAMESPACE}pedidos/pagamento-bloqueado/${id}.json`)){
    throw new Error('Pagamento bloqueado. Consulte a loja.');
  }
  // Only server-verified online payments can receive a number or enter the queue.
  // This guard remains effective after disabling checkout during a rollback.
  if(pedido.pagamento?.fluxo === 'mercadopago' &&
     (pedido.pagamento.status !== 'approved' || pedido.pagamento.verified !== true ||
      !pedido.pagamento.mpOrderId)){
    throw new Error('Comanda aguardando pagamento aprovado.');
  }
  if(pedido.confirmadoPath){
    const confirmado = await lerJson(pedido.confirmadoPath);
    if(confirmado) return confirmado;
  }
  // A fila usa um caminho determinístico por pedido. Isso impede duas comandas
  // para o mesmo clientRequestId mesmo se houver retry/concorrrência.
  const confirmadoPath = `${FILA_DIR}/${data}/${id}.json`;
  const existenteFila = await lerJson(confirmadoPath);
  if(existenteFila){
    if(!pedido.confirmadoPath){
      const agora = new Date().toISOString();
      try{
        await gravarJson(pathname, { ...pedido, status: 'confirmado', confirmadoPath, atualizadoEm: agora }, true);
      }catch(err){
        console.warn('[pedidos] marcador_confirmacao_nao_atualizado', { id, error: String(err) });
      }
    }
    return existenteFila;
  }

  // A historical official receipt may still be read/acknowledged, but an old
  // unconfirmed presencial reservation must never bypass the online-only rule.
  if(pedido.atendimento?.tipo !== 'mesa' && pedido.pagamento?.fluxo !== 'mercadopago'){
    throw Object.assign(new Error('Esta tentativa anterior não foi confirmada. Refaça o pedido e pague pelo site.'),{code:'PAYMENT_REQUIRED'});
  }

  const sequencia = await proximoNumero(data);
  const agora = new Date().toISOString();
  const confirmado = { ...pedido, numero: sequencia.codigo, numeroSequencial: sequencia.numero,
    status: 'pendente', confirmadoEm: agora, atualizadoEm: agora };
  try{
    await gravarJson(confirmadoPath, confirmado, false);
  }catch(err){
    if(isConflict(err)){
      const vencedor = await lerJson(confirmadoPath);
      if(vencedor) return vencedor;
    }
    throw err;
  }
  await gravarJson(pathname, { ...pedido, status: 'confirmado', confirmadoPath, atualizadoEm: agora }, true);
  return confirmado;
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
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      if(body.status === 'pendente'){
        return res.status(409).json({error:'Reimpressão automática bloqueada. Confira papel e histórico antes de reprocessar uma comanda.'});
      }
      // Keep the legacy route's response shape, but use the same atomic claim
      // and ACK transitions as the current Windows agent. No read/write reset.
      let statusCode = 200;
      const relay = {
        setHeader:(name,value)=>res.setHeader(name,value),
        status(code){statusCode=code;return this;},
        async json(data){
          if(statusCode !== 200) return res.status(statusCode).json(data);
          const pedido = await lerJson(body.pathname);
          return res.status(200).json({...data,pedido});
        },
      };
      return await require('./fila-impressao')({
        ...req,body,headers:{...req.headers,authorization:'Bearer ' + tokenAgente(req)},
      },relay);
    }catch(err){
      const message = err?.message || 'Não foi possível atualizar o pedido.';
      return res.status(message === 'Pedido não encontrado.' ? 404 : 400).json({ error: message });
    }
  }

  if(req.method === 'POST'){
    const horario = await statusHorarioPedidos();
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
      if(!CATALOGO.produtos || !CATALOGO.adicionais) throw new Error('Catálogo base indisponível.');
      const catalogo = await require('./disponibilidade').readOrderCatalog();
      const payloadBase = validarPayload(body, catalogo);
      const onlineRequired = payloadBase.atendimento.tipo !== 'mesa';
      if(!onlineRequired && body?.pagamento?.fluxo === 'mercadopago'){
        return res.status(400).json({error:'Pedidos de mesa seguem o pagamento no local.'});
      }
      if(onlineRequired){
        if(!['credito','debito'].includes(payloadBase.pagamento.metodo)){
          return res.status(400).json({error:'Entrega e retirada exigem crédito ou débito pago pelo site.',pedidoConfirmado:false});
        }
        if(!require('../lib/mp-checkout').enabled()){
          return res.status(503).json({error:'Pagamento online indisponível. Nenhuma cobrança ou comanda foi criada.',pedidoConfirmado:false});
        }
        // Server-owned policy: an old page or edited payload cannot request
        // presencial processing by omitting/changing the browser's flow tag.
        payloadBase.pagamento = {metodo:payloadBase.pagamento.metodo,fluxo:'mercadopago',status:'pending',verified:false};
      }
      if(payloadBase.atendimento.tipo === 'entrega' || payloadBase.atendimento.tipo === 'retirada'){
        const canais = await require('./disponibilidade').readServiceAvailability();
        if(canais[payloadBase.atendimento.tipo] === false){
          throw new Error(payloadBase.atendimento.tipo === 'entrega'
            ? 'Entrega indisponível no momento.'
            : 'Retirada indisponível no momento.');
        }
      }
      const payloadValidado = await validarEntregaNoServidor(payloadBase);
      const payload = await aplicarEstimativaInteligente(payloadValidado);
      const registro = await criarPedido(payload);
      if(registro.pedido.pagamento?.fluxo === 'mercadopago'){
        const pending = registro.pedido;
        if(pending.pagamento.status === 'approved' && pending.pagamento.verified === true && pending.pagamento.mpOrderId){
          const confirmado = await confirmarPedido(pending.id);
          return res.status(200).json({pedido:{
            id:confirmado.id,referencia:confirmado.referencia,numero:confirmado.numero,
            criadoEm:confirmado.criadoEm,status:confirmado.status,pagamento:{status:'approved'},
          },duplicado:true,pagamentoObrigatorio:true});
        }
        return res.status(registro.duplicado ? 200 : 201).json({
          pedido:{id:pending.id,referencia:pending.referencia,criadoEm:pending.criadoEm,
            totalCentavos:pending.totalCentavos,status:'aguardando_pagamento',pagamento:{metodo:pending.pagamento.metodo}},
          pagamentoObrigatorio:true,duplicado:registro.duplicado,impressaoAtiva:false,
        });
      }
      // Apenas mesa e consultas de comandas históricas chegam ao fluxo direto.
      // Entrega/retirada online continuam reservadas até a aprovação verificada.
      const confirmado = await confirmarPedido(registro.pedido.id);
      return res.status(registro.duplicado ? 200 : 201).json({
        pedido: {
          id: confirmado.id,
          referencia: confirmado.referencia,
          numero: confirmado.numero,
          numeroSequencial: confirmado.numeroSequencial,
          data: confirmado.data,
          criadoEm: confirmado.criadoEm,
          status: confirmado.status,
          estimativaMinutos: confirmado.atendimento?.estimativaMinutos || null,
        },
        duplicado: registro.duplicado,
        impressaoAtiva: Boolean(process.env.PRINT_AGENT_TOKEN),
      });
    }catch(err){
      const message = err instanceof SyntaxError ? 'JSON inválido.' : (err?.message || 'Não foi possível registrar o pedido.');
      if(err?.code === 'PAYMENT_REQUIRED') return res.status(409).json({error:message,pedidoConfirmado:false});
      const erroDoCliente = err instanceof SyntaxError || [
        'Pedido inválido.',
        'Identificador do pedido inválido.',
        'Informe o nome do cliente.',
        'Informe um telefone válido.',
        'O pedido precisa ter entre 1 e 40 itens.',
        'Há um item inválido no pedido.',
        'Tipo de atendimento inválido.',
        'Entrega indisponível no momento.',
        'Retirada indisponível no momento.',
        'Número da mesa inválido.',
        'Endereço de entrega incompleto.',
        'A entrega automática atende somente Londrina.',
        'Frete inválido. Calcule novamente.',
        'A cotação do frete expirou ou o endereço mudou. Calcule novamente.',
        'A distância de entrega não confere. Calcule novamente.',
        'A taxa de entrega não confere. Calcule novamente.',
        'A taxa de serviço não confere. Calcule novamente.',
        'Forma de pagamento inválida.',
        'Informe um telefone válido ou deixe o campo em branco.',
        'Valor do pedido inválido.',
        'Valor do troco inválido.',
        'JSON inválido.',
      ].includes(message);
      if(erroDoCliente) return res.status(400).json({ error: message });
      if(isStorageUnavailable(err)){
        // Nunca fabricar comanda ou referencia quando nao foi possivel
        // comprovar que o pedido entrou no banco.
        console.error('[pedidos] armazenamento_indisponivel_pedido_nao_confirmado', {
          error: String(err)
        });
        res.setHeader('X-Ferracini-Storage-Degraded', '1');
        return res.status(503).json({
          error: 'Não foi possível confirmar este pedido agora. Tente novamente com o mesmo carrinho.',
          pedidoConfirmado: false,
          storageDegraded: true,
        });
      }
      console.error('[pedidos] criacao_falhou', { error: String(err), code: err?.code });
      return res.status(503).json({ error: 'Não foi possível registrar a comanda agora.' });
    }
  }

  res.setHeader('Allow', 'GET, POST, PATCH');
  return res.status(405).json({ error: 'Método não permitido.' });
};
module.exports.confirmarPedido = confirmarPedido;
