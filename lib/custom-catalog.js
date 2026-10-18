const crypto = require('crypto');
const base = require('../api/catalogo.json');

const key = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function validPrice(value) {
  return Number.isInteger(value) && value >= 100 && value <= 50000;
}

function validateItem(raw, ingredientIds = []) {
  if (!raw || !['dog', 'x', 'bebidas', 'adicional'].includes(raw.categoria)) fail('Escolha a categoria do item.');
  const nome = typeof raw.nome === 'string' ? raw.nome.trim().replace(/\s+/g, ' ') : '';
  if (nome.length < 2 || nome.length > 80 || /[\u0000-\u001f<>]/.test(nome) || ['__proto__','constructor','prototype'].includes(nome.toLowerCase())) fail('Informe um nome de 2 a 80 caracteres, sem símbolos HTML.');
  if (!validPrice(raw.precoCentavos)) fail('Informe um preço entre R$ 1,00 e R$ 500,00.');
  const descricao = typeof raw.descricao === 'string' ? raw.descricao.trim() : '';
  if (descricao.length > 300 || /[\u0000-\u001f<>]/.test(descricao)) fail('A descrição deve ter até 300 caracteres, sem símbolos HTML.');
  const ingredientes = Array.isArray(raw.ingredientes) ? [...new Set(raw.ingredientes)] : [];
  if (ingredientes.length > 30 || ingredientes.some(id => !ingredientIds.includes(id))) fail('Selecione ingredientes válidos.');
  return { nome, categoria: raw.categoria, precoCentavos: raw.precoCentavos, descricao, ingredientes };
}

function allNames(items = []) {
  return [...Object.keys(base.produtos), ...Object.keys(base.adicionais), ...items.map(item => item.nome)];
}

function canonicalName(items, rawName) {
  const requested = typeof rawName === 'string' ? rawName.trim().replace(/\s+/g, ' ') : '';
  if (!requested) return null;
  return allNames(items).find(name => key(name) === key(requested)) || null;
}

function addItem(items, raw, ingredientIds) {
  if (items.length >= 60) fail('Limite de 60 itens cadastrados atingido.');
  const item = validateItem(raw, ingredientIds);
  if (canonicalName(items, item.nome)) fail('Já existe um item com esse nome.', 409);
  return [...items, { ...item, id: 'novo_' + crypto.randomUUID().replace(/-/g, '') }];
}

function editItemPrice(items, overrides = {}, raw = {}) {
  const nome = canonicalName(items, raw.nome);
  if (!nome) fail('Item não encontrado.', 404);
  if (!validPrice(raw.precoCentavos)) fail('Informe um preço entre R$ 1,00 e R$ 500,00.');
  return { ...overrides, [nome]: raw.precoCentavos };
}

function excludeItem(items, excluded = [], raw = {}) {
  const nome = canonicalName(items, raw.nome);
  if (!nome) fail('Item não encontrado.', 404);
  const byKey = new Map(excluded.map(item => [key(item), item]));
  byKey.set(key(nome), nome);
  return [...byKey.values()];
}

function restoreItem(items, excluded = [], raw = {}) {
  const nome = canonicalName(items, raw.nome);
  if (!nome) fail('Item não encontrado.', 404);
  return excluded.filter(item => key(item) !== key(nome));
}

function effectivePrice(name, fallback, overrides = {}) {
  const override = overrides[name];
  return validPrice(override) ? override : fallback;
}

function orderCatalog(items = [], overrides = {}, excluded = []) {
  const excludedKeys = new Set(excluded.map(key));
  const produtos = {};
  const adicionais = {};

  for (const [nome, produto] of Object.entries(base.produtos)) {
    if (excludedKeys.has(key(nome))) continue;
    produtos[nome] = {
      ...produto,
      precoCentavos: effectivePrice(nome, produto.precoCentavos, overrides),
    };
  }

  for (const [nome, precoCentavos] of Object.entries(base.adicionais)) {
    if (excludedKeys.has(key(nome))) continue;
    adicionais[nome] = effectivePrice(nome, precoCentavos, overrides);
  }

  for (const item of items) {
    if (!item || excludedKeys.has(key(item.nome))) continue;
    const precoCentavos = effectivePrice(item.nome, item.precoCentavos, overrides);
    if (item.categoria === 'adicional') adicionais[item.nome] = precoCentavos;
    else produtos[item.nome] = { precoCentavos, aceitaAdicionais: item.categoria !== 'bebidas' };
  }

  return { produtos, adicionais };
}

module.exports = { addItem, editItemPrice, excludeItem, restoreItem, orderCatalog, validPrice };
