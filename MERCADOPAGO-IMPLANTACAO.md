# Pagamento automático Ferracini — pacote preparado

Código preparado na branch local `prepare/mercadopago-20261023`, a partir de `main` em `03c23d0`. A integração anterior foi recuperada do histórico (`4bd1a29`) e adaptada ao cardápio e à comanda atuais. Não foi enviado ao GitHub, publicado na Vercel nem ativado no site. A instalação e a ativação dependem de autorização posterior do responsável.

## O que este pacote entrega

- Crédito e débito pelo formulário seguro Card Payment Brick do Mercado Pago, com Orders API no servidor. O débito é à vista; o crédito permite as parcelas oferecidas pelo provedor, até 12.
- O servidor valida produtos, adicionais, preços, frete e taxas antes de reservar o pedido. Os dados completos do cartão ficam nos campos do provedor; o servidor recebe o token temporário e não o grava.
- Pedido reservado não recebe número nem entra na cozinha. A comanda só é liberada após consulta autenticada ao Mercado Pago confirmar valor integral, modalidade, referência e ID corretos. O webhook valida assinatura HMAC e horário antes de consultar o provedor.
- Tentativas repetidas usam a mesma referência e chave de idempotência. Respostas incertas ficam em acompanhamento, inclusive após recarregar a página. Não há repetição automática de cobrança.
- Autenticação bancária, quando exigida, apresenta o link HTTPS recebido do provedor. Só a aprovação posterior libera a comanda.
- Estornos/cancelamentos notificados geram bloqueio permanente da impressão pendente. Papel já impresso ou trabalho já reivindicado exige conferência da loja. Este pacote não inicia estornos, nem promete impressão física exatamente uma vez.
- O painel e a comanda identificam pagamento verificado como “PAGO PELO SITE”. Marmitex, doces, sobremesas e o layout atual permanecem.

`MP_CARD_CHECKOUT_ENABLED` ausente ou `false` conserva o fluxo manual atual. Quando `true`, entrega e retirada passam a exigir crédito/débito online; Pix manual e dinheiro não são oferecidos nessas modalidades. Mesa continua no fluxo atual de pagamento no local. Não foi implementado Pix automático.

Desligar a flag bloqueia novas cobranças; consulta e webhook de pagamentos já iniciados continuam funcionando enquanto o token e o segredo necessários estiverem disponíveis. Não remova as credenciais para interromper apenas novas vendas.

## Configuração necessária para o teste real

Verifique os bindings existentes no projeto Vercel antes de criar variáveis. Os valores não estão neste pacote nem devem ser enviados em chat.

| Variável | Uso |
| --- | --- |
| `MP_CARD_CHECKOUT_ENABLED` | Manter `false` até configurar e autorizar o ambiente de teste; `true` habilita novas cobranças. |
| `MP_PUBLIC_KEY` | Chave pública da mesma aplicação Mercado Pago. |
| `MP_ACCESS_TOKEN` | Token privado da aplicação/conta que recebe as vendas. |
| `MP_WEBHOOK_SECRET` | Segredo de assinatura da configuração de Webhooks; obrigatório para ativar fora de Preview. |

Configure no Mercado Pago o evento **Order/Pedidos** (`order`) para a rota `/api/mp-webhook` do domínio HTTPS do ambiente correto. Não use o tópico `payment` nesta integração com Orders. Confirme que chave pública e token pertencem à mesma aplicação e que a conta permite cartões de crédito/débito. Um HTTP 403 do provedor não é corrigido por este pacote.

No Preview, use contas e credenciais de teste adequadas ao Mercado Pago. A URL de Preview não transforma credenciais reais em credenciais de teste. Configure também o segredo do webhook de teste para validar notificações; o Preview permite validar por consulta mesmo sem esse segredo, mas o webhook sempre exige assinatura.

O site já depende do OIDC da Vercel para acessar a função Neon definida em `lib/postgres-storage.js`. Preserve essa integração e os bindings existentes de `ADMIN_PASSWORD`, `PRINT_AGENT_TOKEN`, `PRINT_QUEUE_DATABASE_URL`, `PRINT_QUEUE_START_AT` e, quando utilizado, `GOOGLE_MAPS_API_KEY`. Não altere o instante de ativação da fila nem gere outro token de impressão sem necessidade.

O ambiente de nuvem atual não contém as três variáveis Mercado Pago nem a identidade Vercel/Neon. O painel da Vercel não foi acessado nesta tarefa; podem existir valores lá. A verificação real do provedor, da persistência e da impressora permanece pendente. A rede da nuvem bloqueou o portal de documentação Mercado Pago; as estruturas foram conferidas no SDK oficial `mercadopago/sdk-nodejs`, commit `bf920b9415ba19986b7ffdbf83a5aa21b589a6e0`. Nenhuma verificação TLS foi desativada.

## Verificação reproduzível do código

Use Node 22. Na raiz do repositório:

```bash
npm ci
npm run validate
npm test
npm run test:browser
npm run check:payments
```

Os testes de navegador usam Chromium existente em `/usr/bin/chromium`, o caminho `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, ou o Chromium do Playwright. Caso nenhum esteja instalado, execute `npx playwright install --with-deps chromium`. A suíte inicia seu próprio servidor temporário e simula o SDK e as respostas de pagamento, sem cobranças.

`npm test` inclui testes das regras de cobrança, assinatura, recuperação, rollback, catálogo e da SQL efetivamente executada pela fila usando PostgreSQL em memória (PGlite). Isso não substitui a verificação do Neon real. `npm run check:payments` apenas informa a configuração; a ausência da flag mantém cobranças desligadas. Depois da autorização e da configuração segura, `node scripts/validate-payments-config.js --require-enabled --check-provider` verifica presença das variáveis e faz apenas uma consulta de leitura à conta. Esse comando não cobra nem valida por si só a capacidade de receber cartões.

Nesta preparação, a instalação com `npm ci`, a validação do snapshot, os 17 testes reportados por `npm test` e os 10 testes de navegador passaram, sem testes pulados. O provedor é simulado nessas suítes; nenhuma cobrança real foi realizada. A verificação de configuração habilitada falhou como esperado por ausência de flag/credenciais neste ambiente. O agente PowerShell foi verificado pelo teste de layout, sem execução em Windows ou impressão física.

## Instalação, somente quando autorizada

1. Confirmar a versão atual de `main` e revisar mudanças que tenham ocorrido depois deste pacote. Preservar o deployment anterior para rollback.
2. Enviar a branch preparada para revisão e criar um Preview conforme `DEPLOYMENT-SAFETY.md`. Não mesclar diretamente em `main`: a configuração atual da Vercel pode publicar automaticamente um push.
3. Configurar os bindings de teste e a notificação no Preview; habilitar a flag somente nele. Pedidos, sequência, histórico e estimativa de Preview usam `mp-preview/`; a API física de impressão recusa execução em Preview. Isso não substitui usar credenciais de teste.
4. Testar no Preview: crédito aprovado, débito aprovado, recusa, pendência, autenticação do banco, formulário em celular e computador, recarga da página, perda de resposta, duplo clique e repetição do webhook. Conferir valor do pedido com produtos adicionais, marmitex, doces/sobremesas, serviço e frete. Confirmar que não há comanda antes da aprovação e que há somente uma depois.
5. Validar assinatura do webhook e recuperação com a página fechada; desligar a flag durante uma pendência e confirmar que a reconciliação continua. Simular estorno na conta de teste e conferir o bloqueio.
6. Com autorização de produção e fora do atendimento, configurar as credenciais da conta correta e promover o deployment validado. A flag pode permanecer `false` durante a instalação; ativá-la é uma ação separada.
7. No Windows, se for desejada a indicação “PAGO PELO SITE” no papel, fazer backup e substituir somente `C:\FerraciniPrintAgent\FerraciniPrintAgent.ps1`. Preservar `config.json`, `token.dat`, arquivos `.cmd` e logs; reiniciar o agente. Conferir fisicamente uma única comanda após aprovação. Não instalar o agente físico no Linux da nuvem.

Para interromper novas cobranças, definir a flag como `false` e reaplicar a configuração da Vercel. Manter o código de reconciliação e as credenciais até encerrar pagamentos pendentes. Reverter para um deployment anterior que não contém as rotas Mercado Pago interrompe essas notificações; não faça esse rollback sem conciliar os pagamentos em andamento.

## Operação e recuperação

O navegador guarda somente referência opaca, modalidade, total, identificador da tentativa e indicador de envio, sem dados pessoais/cartão. Resposta incerta oferece consulta, sem nova cobrança automática. Uma tentativa sem ID de provedor não pode ser reenviada depois de 30 minutos; deve ser conciliada no painel Mercado Pago e pelos webhooks, sem gerar outro pedido às cegas. Reservas ainda não enviadas expiram para iniciar pagamento após 30 minutos. A loja não deve apagar registros, índices ou bloqueios de pagamento durante o período de conciliação/estornos.

Pagamentos recusados permitem uma nova tentativa explícita; falha de rede não equivale a recusa. Uma comanda já reivindicada pode ter sido impressa antes de uma notificação de estorno: confira papel, extrato e histórico antes de qualquer ação manual. O acesso à conta, permissões reais do Mercado Pago, OIDC/Neon, confirmação do banco e impressão física só podem ser considerados validados depois dos testes externos acima.
