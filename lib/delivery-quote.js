/**
 * Cotacao de frete assinada e vinculada ao endereco.
 * Impede que um segundo calculo de rota mude o valor ja exibido ao cliente.
 * Ideal: DELIVERY_QUOTE_SECRET dedicado. Compatibilidade: a chave privada do
 * Google Maps, que ja existe no servidor, tambem permite validar a assinatura.
 */
const crypto = require('node:crypto');
const { normalizarEndereco, MAX_ROUTE_KM } = require('./delivery-distance');

const TTL_MS = 20 * 60 * 1000;

function assinaturaChave() {
  return process.env.DELIVERY_QUOTE_SECRET || process.env.GOOGLE_MAPS_API_KEY || '';
}

function normalizarCampo(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, ' ')
    .replace(/\\s+/g, ' ').trim();
}

function hashEndereco(raw) {
  const e = normalizarEndereco(raw);
  const campos = [
    normalizarCampo(e.rua),
    normalizarCampo(e.numero),
    normalizarCampo(e.bairro),
    normalizarCampo(e.cidade),
    e.cep,
  ];
  return crypto.createHash('sha256').update(campos.join('|')).digest('hex');
}

function assinarCotacao(endereco, distanciaKm, agora = Date.now()) {
  const chave = assinaturaChave();
  if (!chave) return null;
  const km = Math.round(Number(distanciaKm) * 100) / 100;
  if (!Number.isFinite(km) || km <= 0 || km > MAX_ROUTE_KM) {
    throw new Error('distancia_invalida_para_cotacao');
  }
  const dados = Buffer.from(JSON.stringify({
    v: 1,
    km,
    enderecoHash: hashEndereco(endereco),
    expira: agora + TTL_MS,
  })).toString('base64url');
  const assinatura = crypto.createHmac('sha256', chave).update(dados).digest('base64url');
  return dados + '.' + assinatura;
}

function validarCotacao(token, endereco, distanciaKm, agora = Date.now()) {
  const chave = assinaturaChave();
  if (!chave || typeof token !== 'string' || token.length > 1000) return false;
  const partes = token.split('.');
  if (partes.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(partes[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(partes[1])) return false;
  const esperado = crypto.createHmac('sha256', chave).update(partes[0]).digest();
  const recebido = Buffer.from(partes[1], 'base64url');
  if (recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) return false;

  try {
    const dados = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8'));
    const km = Math.round(Number(distanciaKm) * 100) / 100;
    return dados.v === 1 &&
      Number.isSafeInteger(dados.expira) &&
      dados.expira > agora && dados.expira <= agora + TTL_MS &&
      typeof dados.enderecoHash === 'string' &&
      dados.enderecoHash === hashEndereco(endereco) &&
      Number.isFinite(km) && km > 0 && km <= MAX_ROUTE_KM &&
      dados.km === km;
  } catch {
    return false;
  }
}

module.exports = { TTL_MS, assinarCotacao, validarCotacao };
