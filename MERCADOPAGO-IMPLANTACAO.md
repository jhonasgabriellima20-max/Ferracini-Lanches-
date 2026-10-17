# Mercado Pago: implantação segura para Ferracini

Esta branch **não está em produção**. O Access Token cadastrado na Vercel sozinho não ativa pagamentos.

## Pré-requisitos
- **Preview / testes:** credenciais **de teste** da aplicação Mercado Pago em ambiente Preview: `MP_ACCESS_TOKEN` e `MP_PUBLIC_KEY`, nunca anexar tokens a commits, prints ou mensagens.
- `MP_WEBHOOK_SECRET`: segredo de verificação da aba Webhooks do Mercado Pago.
- `MP_CARD_CHECKOUT_ENABLED=true` somente em Preview após configurar as três chaves.
- Endpoint da aplicação a cadastrar em **Webhooks** (tópico `payment`): `https://<dominio>/api/mp-webhook`.
- Na produção repetir `MP_PUBLIC_KEY` e `MP_WEBHOOK_SECRET` no ambiente Production. A variável `MP_ACCESS_TOKEN` já foi inserida, verificar se é da mesma aplicação da Public Key.

## Regras de segurança e impressão
- A interface usa o Card Payment Brick do próprio Mercado Pago; os dados completos do cartão nunca passam pela Ferracini.
- O servidor recalcula itens, entrega, adicionais e taxas; nunca aceita um valor vindo do cliente.
- Para pedidos de retirada e entrega, somente crédito e débito quando a chave `MP_CARD_CHECKOUT_ENABLED` está ativa. O Pix não é ofertado no checkout principal desta branch. Pedidos de mesa seguem o fluxo já existente.
- `POST /api/pedidos` reserva o pedido no banco em `aguardando_pagamento` **sem numerar, sem imprimir**.
- `POST /api/mp-pagamento` envia o cartão tokenizado com `X-Idempotency-Key` determinística. Consulta novamente o pagamento no Mercado Pago antes de criar a comanda.
- `POST /api/mp-webhook` verifica a assinatura HMAC e a API do Mercado Pago antes de reconhecer a aprovação. Falha de webhook **não** confirma pagamentos sem assinatura.
- Um número de comanda e entrada na fila só ocorrem depois da aprovação verificada. Pagamento recusado ou pendente não imprime.
- O endpoint `/api/mp-status` permite recuperar estados pendentes e revalidar com o Mercado Pago.

## Publicação
1. Validar CI, API, UI, valores, tentativas de cobrança duplicada, rejeição, pendência e impressão no Preview com cartões de teste do Mercado Pago.
2. Validar cartão de débito elegível na conta e fluxo real nos navegadores Safari/Chrome. Bricks não têm suporte oficial a WebViews de apps.
3. Conferir a rota `/mesa.html` separadamente, antes de eliminar o Pix de todas as superfícies.
4. Fazer teste presencial da impressora no notebook Bematech: uma comanda só após aprovação; sem comandas fantasmas.
5. Depois de aprovado, configurar credenciais, habilitar a flag de produção e fazer deploy validado fora do horário de atendimento. Reverter flag/deployment se houver falhas.

**Atenção:** a branch não desliga a impressora, não altera o banco nem publica pagamentos em produção.
