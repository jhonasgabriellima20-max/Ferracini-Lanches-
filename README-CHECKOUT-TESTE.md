# Ferracini — checkout transparente em HOMOLOGAÇÃO

Recurso somente na branch GitHub teste-checkout-transparente.
Não editar main, não usar deploy production nem trocar o domínio principal.

## Abrir o teste
Após a Vercel publicar a prévia desta branch:
https://<URL-DA-PREVIEW>/pagamento-teste.html

A tela é isolada do cardápio e tem preço ilustrativo fixo de R$ 5,00.
Não registra pedidos, não altera estoque, não libera fila e não imprime comandas.

## Modo demonstração visual (padrão seguro)
Sem MP_TEST_PUBLIC_KEY e MP_TEST_ACCESS_TOKEN na Vercel Preview:
- Exibe botões que simulam aprovado, recusado e pendente.
- Não captura cartão, não chama o Mercado Pago e não cria cobrança.
- A API POST devolve 503 intencionalmente.

## Modo Sandbox Mercado Pago (habilitação posterior)
1. Mercado Pago Developers > Suas integrações > Credenciais de teste.
2. Vercel > ferracini-lanches > Settings > Environment Variables:
   - MP_TEST_PUBLIC_KEY: somente Preview; chave TEST-.
   - MP_TEST_ACCESS_TOKEN: somente Preview, Sensitive; token TEST-.
   - Nunca enviar segredos no chat, GitHub ou navegador.
3. Gerar novo deployment Preview da branch de testes.
4. Usar somente os cartões de teste oficiais; conferir pagamentos de teste pelo ID.
5. Verificar que não existe comanda ou impressão no Ferracini.

Travas: API requer VERCEL_ENV=preview e VERCEL_GIT_COMMIT_REF=teste-checkout-transparente,
e usa exclusivamente variáveis MP_TEST_ prefixadas TEST-, nunca MP_ACCESS_TOKEN de produção.
É intencional que o endpoint POST não funcione fora da prévia.

## Próximo estágio após validar Sandbox
- Integrar ao carrinho real recalculando tudo no servidor, taxas e disponibilidade.
- Persistir pedido aguardando pagamento em banco ISOLADO de teste, com idempotência.
- Validar webhook assinado e consultar o pagamento por API, conferindo valor, vendedor e referência.
- Liberar a fila de impressão apenas após aprovado; pendente/recusado não imprime.
- Nunca apontar a Preview ao banco e à impressora da loja.
- Avaliar passagem à produção em etapa separada e autorizada.

Documentação:
https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/card-payment-brick/introduction
https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/integration-test/test-payment-flow
