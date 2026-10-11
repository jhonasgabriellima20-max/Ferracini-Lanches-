# Ferracini — pagamento online obrigatório (pré-produção)

## Objetivo
- **Entrega e retirada**: o navegador vai para `/pagamento.html` com Mercado Pago Payment Brick (Pix, crédito, débito).
- **Comer no local (mesa)**: continua sem pagamento no site.
- **Não liberar nenhuma comanda não paga**: `POST /api/pedidos` retorna HTTP 402 para entrega e retirada; a fila só é criada após consultar o pagamento aprovado na API do Mercado Pago.
- Sem depender de cliente enviar comprovante; webhook autenticado e verificação ativa em consulta ao provedor.
- ID de pedido e de pagamento estáveis evitam duplicação mesmo com reenvios.

## Pré-requisitos para habilitar (com proprietário autorizado)
1. O proprietário entra em Mercado Pago Developers > Suas integrações e cria/autoriza uma aplicação Ferracini.
2. Configura notificações Webhooks para `https://ferracinilanches.com.br/api/mercadopago-webhook`, tipo **payments**; obtém chave secreta.
3. Em **Vercel > ferracini-lanches > Settings > Environment Variables**, incluir:
    - `MP_ACCESS_TOKEN`: token **privado** (segredo, nunca GitHub nem chat).
    - `MP_PUBLIC_KEY`: chave pública de checkout.
    - `MP_WEBHOOK_SECRET`: segredo de assinatura de webhooks (segredo).
    - `MP_WEBHOOK_URL`: `https://ferracinilanches.com.br/api/mercadopago-webhook`.
    - `MP_PAYMENTS_ENABLED`: `true`, **somente no momento da ativação**.
4. Para homologação, usar credenciais de teste e webhook adequado de ambiente separado. Não conectar teste ao banco/fila de produção.
5. Conferir conta recebedora, taxas, parcelas habilitadas, tipos de cartões aceitos e regras de devolução.

## Testes obrigatórios antes do merge e ativação
- Checkout abre corretamente em iPhone, Android, Instagram e navegador desktop.
- Pix gerado e ainda pendente: **0 comandas** na fila.
- Pix aprovado: **1 comanda**, marcando forma de pagamento.
- Cartões aprovados: **1 comanda** cada; cartão recusado: **0 comandas**.
- Mesmo webhook duas vezes: **1 comanda**.
- Valor ou referência divergentes: **0 comandas**.
- Banco ou Mercado Pago indisponível: não mostrar aprovação falsa.
- Mesa sem pagamento: continua funcionando normalmente.
- Impressora Bematech desligada: pedido já pago aguarda fila e é recuperado depois sem gerar duas impressões.

## Precauções
- **Não mesclar a branch antes da homologação**: nesta branch entrega e retirada são bloqueadas se não existir a integração com as credenciais. Isto é intencional, não é uma alteração pronta para produção.
- Nunca testar cartão/pagamento real sem anuência do proprietário.
- Revisar o retorno do Payment Brick, inclusive autenticação 3DS e políticas de conteúdo (CSP), com credenciais de teste.
- Imprimir no spooler não garante que o papel saiu; a fila e o agente têm supervisão própria.
- Em caso de rollback, manter pagamentos não confirmados bloqueados. Reverter para a versão antiga restabeleceria a impressão antes do pagamento e deve ser evitado sem decisão consciente sobre a operação.

## Referências
- https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/payment-brick/default-rendering
- https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/payment-brick/payment-submission/pix
- https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
