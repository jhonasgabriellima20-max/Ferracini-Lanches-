# Ferracini Lanches — política de publicação segura

## Regra principal
Evitar publicar alterações diretamente no domínio durante o atendimento da loja.

## Fluxo obrigatório
1. Alterar código em uma branch de preview.
2. Rodar a validação automática.
3. Criar deployment Preview na Vercel.
4. Conferir página inicial, cardápio, disponibilidade, retirada, entrega, frete e registro de pedidos.
5. Conferir logs do Preview.
6. Somente depois promover o deployment validado para produção.
7. Manter o deployment anterior como rollback imediato.

## Frete
- Google Routes é o provedor principal.
- Photon + OSRM é contingência.
- A taxa é arredondada para reais inteiros no navegador e conferida novamente pelo servidor.
- HTTP 422 pode representar endereço fora da área ou endereço não confirmado; nunca inventar distância.

## Pedidos e impressão
- O navegador registra o pedido em POST /api/pedidos antes de abrir o WhatsApp.
- GET e PATCH /api/pedidos exigem PRINT_AGENT_TOKEN.
- A fila é privada, idempotente e limitada contra abuso.
- O agente local deve marcar cada pedido como imprimindo, impresso ou falhou.

## Estado sincronizado
O GitHub voltou a ser a fonte versionada do projeto em 14/09/2026. O snapshot restaurado foi atualizado com a API de pedidos e com o fluxo de impressão antes da nova publicação.
