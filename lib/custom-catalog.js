const crypto = require('crypto');
const base = require('../api/catalogo.json');
const key = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function validateItem(raw, ingredientIds = []) {
  const fail = message => { const error = new Error(message); error.status = 400; throw error; };
  if (!raw || !['dog', 'x', 'bebidas', 'adicional'].includes(raw.categoria)) fail('Escolha a categoria do item.');
  const nome = typeof raw.nome === 'string' ? raw.nome.trim().replace(/\s+/g, ' ') : '';
  if (nome.length < 2 || nome.length > 80 || /[\u0000-\u001f<>]/.test(nome) || ['__proto__','constructor','prototype'].includes(nome.toLowerCase())) fail('Informe um nome de 2 a 80 caracteres, sem símbolos HTML.');
  if (!Number.isInteger(raw.precoCentavos) || raw.precoCentavos < 100 || raw.precoCentavos > 50000) fail('Informe um preço entre R$ 1,00 e R$ 500,00.');
  const descricao = typeof raw.descricao === 'string' ? raw.descricao.trim() : '';
  if (descricao.length > 300 || /[\u0000-\u001f<>]/.test(descricao)) fail('A descrição deve ter até 300 caracteres, sem símbolos HTML.');
  const ingredientes = Array.isArray(raw.ingredientes) ? [...new Set(raw.ingredientes)] : [];
  if (ingredientes.length > 30 || ingredientes.some(id => !ingredientIds.includes(id))) fail('Selecione ingredientes válidos.');
  return { nome, categoria: raw.categoria, precoCentavos: raw.precoCentavos, descricao, ingredientes };
}

function addItem(items, raw, ingredientIds) {
  if (items.length >= 60) { const e = new Error('Limite de 60 itens cadastrados atingido.'); e.status = 400; throw e; }
  const item = validateItem(raw, ingredientIds);
  const names = [...Object.keys(base.produtos), ...Object.keys(base.adicionais), ...items.map(i => i.nome)];
  if (names.some(name => key(name) === key(item.nome))) { const e = new Error('Já existe um item com esse nome.'); e.status = 409; throw e; }
  return [...items, { ...item, id: 'novo_' + crypto.randomUUID().replace(/-/g, '') }];
}

function orderCatalog(items = []) {
  const produtos = { ...base.produtos }, adicionais = { ...base.adicionais };
  for (const item of items) {
    if (item.categoria === 'adicional') adicionais[item.nome] = item.precoCentavos;
    else produtos[item.nome] = { precoCentavos: item.precoCentavos, aceitaAdicionais: item.categoria !== 'bebidas' };
  }
  return { produtos, adicionais };
}
module.exports = { addItem, orderCatalog };
