const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const page of ['index.html','mesa.html']) {
  const html = fs.readFileSync(path.join(__dirname,'..',page),'utf8');
  assert.match(html, /id="btnEnviarPedido"[\s\S]{0,120}Confirmar pedido/);
  assert.doesNotMatch(html, /WhatsApp|wa\.me|linkWhatsappCopia/i);
  assert.match(html, /const clientRequestId = clientRequestIdAtual \|\| criarIdPedido\(\);/);
  assert.match(html, /clientRequestIdAtual = clientRequestId;/);
  assert.match(html, /await registrarPedidoNoSistema\(payload\)/);
  assert.match(html, /btnEnviarPedidoEl\.disabled = false;\s*btnEnviarPedidoEl\.textContent = 'Confirmar pedido'/);
  assert.match(html, /data\?\.storageDegraded \|\| !data\?\.pedido\?\.id/);
  if(page==='index.html'){
    assert.match(html,/aguardando_pagamento/);
    assert.match(html,/montarPagamentoCartao/);
  } else {
    assert.match(html, /!?\['pendente','imprimindo','impresso','falhou'\]/);
  }
  assert.match(html, /Guarde o número da comanda/);
  assert.match(html, /checkoutConfirmEl\.style\.display = 'block'/);
  assert.match(html, /btnEnviarPedidoEl\.style\.display = 'none'/);
  assert.match(html, /Object\.keys\(cart\)\.forEach/);
  assert.doesNotMatch(html, /window\.location\.assign\(destinoWhatsApp\)/);
  assert.doesNotMatch(html, /registroFallbackWhatsapp/);
  assert.doesNotMatch(html, /a loja confirma a comanda ao receber esta mensagem/);
  assert.match(html, /confirmada no sistema!/);
}
const server=fs.readFileSync(path.join(__dirname,'..','api','pedidos.js'),'utf8');
const panel=fs.readFileSync(path.join(__dirname,'..','api','painel-pedidos.js'),'utf8');
assert.doesNotMatch(server, /storage_indisponivel_fallback_whatsapp/);
assert.doesNotMatch(server, /status:\s*'whatsapp'/);
assert.match(server, /pedidoConfirmado: false/);
assert.match(panel, /if\(req\.method !== 'GET'\)/);
assert.doesNotMatch(panel, /req\.method === 'POST'/);
console.log('OK: pedidos sem WhatsApp, confirmacao no sistema e painel sem aceite manual');
