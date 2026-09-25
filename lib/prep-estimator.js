const { readJson, listBlobs } = require('./postgres-storage');

const TIME_ZONE = 'America/Sao_Paulo';
const FILA_DIR = 'pedidos/fila';
const DEFAULT_CAPACITY = 4;

const DEFAULT_PREP_MINUTES = Object.freeze({
  'Dog Simples': 8,
  'Dog Duplo': 10,
  'Dog Presunto Queijo': 11,
  'Dog Frango': 13,
  'Dog Bacon': 14,
  'Dog Frango Bacon (1 Kilo)': 18,
  'Simples Burguer': 10,
  'X-Burguer': 11,
  'X-Salada': 12,
  'X-Egg': 14,
  'X-Frango': 16,
  'X-Bacon (1 Kilo)': 18,
  'X-Tudo (2 Kilo)': 28,
  'Água com gás': 0,
  'Água sem gás': 0,
  'Refrigerante lata': 0,
  'Cerveja lata': 0,
  'Cerveja Long Neck': 0,
  'Jujutuba 2L': 0,
  'Refriko 2L': 0,
  'Coca-Cola 1L': 0,
  'Kuat 2L': 0,
  'Coca-Cola 2L': 0,
  'Suco Tampico 450 ml': 0,
  'Suco Tampico 2L': 0,
  'Del Valle 1L Laranja': 0,
  'Del Valle 1L Uva': 0,
});

const DEFAULT_GRILL_LOAD = Object.freeze({
  'Dog Simples': 0.65,
  'Dog Duplo': 0.75,
  'Dog Presunto Queijo': 0.8,
  'Dog Frango': 0.95,
  'Dog Bacon': 1.0,
  'Dog Frango Bacon (1 Kilo)': 1.3,
  'Simples Burguer': 0.8,
  'X-Burguer': 0.9,
  'X-Salada': 1.0,
  'X-Egg': 1.1,
  'X-Frango': 1.2,
  'X-Bacon (1 Kilo)': 1.35,
  'X-Tudo (2 Kilo)': 4.0,
});

function clamp(value, min, max){
  return Math.min(max, Math.max(min, value));
}

function arredondar5Acima(value){
  return Math.ceil(Math.max(0, value) / 5) * 5;
}

function partesLocais(agora = new Date()){
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(agora);
  const out = {};
  for(const part of parts){
    if(part.type !== 'literal') out[part.type] = part.value;
  }
  return {
    data: out.year + '-' + out.month + '-' + out.day,
    hora: Number(out.hour) || 0,
  };
}

function dataAnterior(data){
  const d = new Date(data + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function tempoPadrao(nome){
  if(Object.hasOwn(DEFAULT_PREP_MINUTES, nome)) return DEFAULT_PREP_MINUTES[nome];
  if(/agua|refrigerante|cerveja|suco|coca|kuat|refriko|jujutuba|del valle/i.test(String(nome || ''))) return 0;
  return 12;
}

function tempoItem(nome, config = {}){
  const configured = Number(config.temposPreparo?.[nome]);
  if(Number.isFinite(configured)) return clamp(Math.round(configured), 0, 90);
  return tempoPadrao(nome);
}

function cargaItem(nome){
  if(Object.hasOwn(DEFAULT_GRILL_LOAD, nome)) return DEFAULT_GRILL_LOAD[nome];
  return tempoPadrao(nome) === 0 ? 0 : 1;
}

function capacidade(config = {}){
  const value = Number(config.capacidadeChapa);
  return Number.isFinite(value) ? clamp(value, 2, 6) : DEFAULT_CAPACITY;
}

function estatisticasPedido(itens, config = {}){
  let trabalho = 0;
  let maiorTempo = 0;
  let quantidadeLanches = 0;

  for(const item of Array.isArray(itens) ? itens : []){
    const qtd = clamp(Math.trunc(Number(item?.quantidade) || 0), 0, 50);
    if(qtd <= 0) continue;
    const nome = String(item?.nome || '');
    const minutos = tempoItem(nome, config);
    const carga = cargaItem(nome);
    if(minutos <= 0 || carga <= 0) continue;
    trabalho += minutos * carga * qtd;
    maiorTempo = Math.max(maiorTempo, minutos);
    quantidadeLanches += qtd;
  }

  return { trabalho, maiorTempo, quantidadeLanches };
}

async function listarPedidosRecentes(agora = new Date()){
  const local = partesLocais(agora);
  const datas = [local.data];
  if(local.hora < 4) datas.unshift(dataAnterior(local.data));

  const pedidos = [];
  for(const data of datas){
    const resultado = await listBlobs({ prefix: FILA_DIR + '/' + data + '/', limit: 1000 });
    for(const blob of resultado.blobs || []){
      try{
        const pedido = (await readJson(blob.pathname)).value;
        if(pedido?.criadoEm) pedidos.push(pedido);
      }catch(err){
        console.warn('[estimativa] pedido_ignorado', { pathname: blob.pathname, error: String(err) });
      }
    }
  }

  return pedidos;
}

function calcularFila(pedidos, agora, config = {}){
  const cap = capacidade(config);
  const agoraMs = agora.getTime();
  const ordenados = (pedidos || [])
    .map(pedido => ({ pedido, ts: new Date(pedido?.criadoEm || '').getTime() }))
    .filter(entry => Number.isFinite(entry.ts) && entry.ts <= agoraMs)
    .sort((a,b) => a.ts - b.ts);

  let trabalhoPendente = 0;
  let ultimoTs = null;
  let pedidosComCozinha = 0;

  for(const entry of ordenados){
    if(ultimoTs !== null){
      const minutosPassados = Math.max(0, (entry.ts - ultimoTs) / 60000);
      trabalhoPendente = Math.max(0, trabalhoPendente - (minutosPassados * cap));
    }
    const stats = estatisticasPedido(entry.pedido.itens, config);
    if(stats.trabalho > 0){
      trabalhoPendente += stats.trabalho;
      pedidosComCozinha += 1;
    }
    ultimoTs = entry.ts;
  }

  if(ultimoTs !== null){
    const minutosPassados = Math.max(0, (agoraMs - ultimoTs) / 60000);
    trabalhoPendente = Math.max(0, trabalhoPendente - (minutosPassados * cap));
  }

  return {
    trabalhoPendente,
    filaMinutos: Math.ceil(trabalhoPendente / cap),
    pedidosConsiderados: pedidosComCozinha,
    capacidade: cap,
  };
}

async function estimarPrazo({ itens, tipo, distanciaKm, config = {}, agora = new Date(), pedidos = null }){
  const existentes = pedidos || await listarPedidosRecentes(agora);
  const fila = calcularFila(existentes, agora, config);
  const atual = estatisticasPedido(itens, config);

  const preparoMinutos = atual.trabalho > 0
    ? Math.max(atual.maiorTempo, Math.ceil(atual.trabalho / fila.capacidade))
    : 3;

  const embalagemMinutos = atual.quantidadeLanches > 0 ? 5 : 2;
  const ajusteDemanda = config.demanda === 'alta' ? 10 : config.demanda === 'baixa' ? -5 : 0;
  const atrasoExtra = clamp(Math.round(Number(config.atrasoExtraMinutos) || 0), 0, 120);

  let deslocamentoMinutos = 0;
  if(tipo === 'entrega'){
    const km = clamp(Number(distanciaKm) || 0, 0, 35);
    deslocamentoMinutos = clamp(arredondar5Acima(20 + (km * 2)), 20, 40);
  }

  const piso = tipo === 'entrega' ? 45 : 30;
  let minimo = fila.filaMinutos + preparoMinutos + embalagemMinutos + deslocamentoMinutos + ajusteDemanda + atrasoExtra;
  minimo = arredondar5Acima(Math.max(piso, minimo));

  const margem = fila.filaMinutos >= 90 ? 20 : fila.filaMinutos >= 45 ? 15 : 10;
  let maximo = arredondar5Acima(minimo + margem);
  minimo = clamp(minimo, piso, 300);
  maximo = clamp(Math.max(minimo + 5, maximo), minimo + 5, 320);

  return {
    estimativaMinutos: { minimo, maximo },
    filaMinutos: fila.filaMinutos,
    preparoMinutos,
    deslocamentoMinutos,
    pedidosConsiderados: fila.pedidosConsiderados,
    quantidadeLanches: atual.quantidadeLanches,
  };
}

module.exports = {
  DEFAULT_PREP_MINUTES,
  tempoPadrao,
  estatisticasPedido,
  calcularFila,
  estimarPrazo,
};
