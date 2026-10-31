# Mercado Pago — correções sobre o Ferracini atual

Este pacote incorpora a integração de cartão ao `main` `1f4fb57c951bfb0a7c7f5dba61d3dde91f3aa4b4` (28/10/2026), preservando suas regras. Substitui a preparação antiga baseada em `03c23d0`: **não instalar o ZIP antigo de 23/10 como substituição do site atual**. Uma nova versão de `main` exige revisão antes de integrar este pacote. Código preparado e testes locais não significam publicação ou cobrança real validada.

## Comportamento preservado

- Frete de R$ 3,00/km, cotação assinada vinculada ao endereço e taxas existentes.
- Escolha industrializado/artesanal, com acréscimo de R$ 9,00 por lanche e R$ 36,00 no combo de quatro.
- Categorias, adicionais, observações, disponibilidade, fechamento, histórico e layout da comanda.
- Numeração diária por expediente: o dia muda às 06h de São Paulo, sem reiniciar à meia-noite.
- Dinheiro e cartões presenciais permanecem. Crédito/débito são presenciais por padrão; quando a integração estiver configurada, o cliente pode escolher explicitamente pagar pelo site. O servidor só exige aprovação online para pedidos com esse fluxo. Mesa continua com pagamento no local. Por solicitação do responsável, Pix foi retirado das opções do site principal e da página de mesa; pedidos históricos continuam com sua identificação original.

## Correções da auditoria

1. O servidor recalcula o pedido, reserva seu identificador e mantém pagamentos online fora da cozinha até consultar a Orders API e verificar referência, modalidade e valor integral.
2. Uma tentativa de cobrança é registrada por inserção exclusiva. Somente o primeiro processo pode criar a cobrança. Repetições consultam o resultado; não sobrescrevem a reserva nem fazem novo POST ao provedor. A chave de idempotência continua determinística.
3. Tentativa, ID do provedor e rejeição conhecida usam registros imutáveis. Não contêm token do cartão, e-mail ou documento do pagador. O formulário seguro é do Mercado Pago.
4. Rejeições de validação reconhecidas (como `property_value`) continuam recuperáveis após recarregar a página; uma nova tentativa exige ação explícita. HTTP 409, erro desconhecido e timeout permanecem em conciliação e nunca autorizam automaticamente outra cobrança.
5. O índice permanente de reservas abrange também pagamentos presenciais, impedindo que o mesmo identificador de um pedido novo nesta versão gere outra comanda em um expediente posterior. Registros online também têm índice próprio para confirmação/estorno tardio.
6. A rota legada PATCH de pedidos usa as mesmas transições atômicas da fila dedicada. Não permite recolocar `impresso` em `pendente`. O ACK depois de uma reivindicação continua permitido, mesmo que um cancelamento chegue depois, para registrar o trabalho já enviado ao spooler.
7. Webhooks verificam HMAC e o ID assinado, consultam o provedor e suportam repetição. Cancelamentos e estornos deixam bloqueio permanente que uma resposta antiga não pode remover.
8. O workflow usa Node 22, instala pelo lockfile e executa todos os testes de pedidos, catálogo, frete, expediente, pagamento, SQL e navegador. As falhas históricas do Actions não foram atribuídas a uma causa sem acesso aos seus logs.

## Instalação e testes do código

Na raiz, com Node 22:

```bash
npm ci
npm run validate
npm test
npm run test:browser
npm run check:payments
```

A suíte de navegador inicia seu próprio servidor e usa Chromium existente em `/usr/bin/chromium`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` ou o Chromium do Playwright. Se necessário, execute `npx playwright install --with-deps chromium`. O SDK e as respostas Mercado Pago são simulados; nenhuma dessas suítes cria cobrança. Os testes da fila executam SQL PostgreSQL em memória (PGlite), incluindo cancelamento, assinatura de webhook, concorrência e ACK.

## Configuração para Preview real

Conferir os bindings existentes na Vercel antes de cadastrar valores. Não colocar segredos no código ou em mensagens:

| Variável | Finalidade |
| --- | --- |
| `MP_CARD_CHECKOUT_ENABLED` | Ausente/`false` desativa novas cobranças online, mantendo o fluxo presencial. Habilitar `true` primeiro somente no Preview autorizado. |
| `MP_PUBLIC_KEY` | Chave pública da aplicação Mercado Pago. |
| `MP_ACCESS_TOKEN` | Token privado da mesma aplicação/conta recebedora. |
| `MP_WEBHOOK_SECRET` | Segredo do webhook do ambiente correspondente; obrigatório para ativar fora de Preview. |

Cadastrar no Mercado Pago o evento **Order/Pedidos** (`order`) para `/api/mp-webhook` no domínio HTTPS correspondente. Esta integração usa `/v1/orders`, não o tópico `payment` da antiga tela isolada. O Preview pode usar consulta sem segredo de webhook, mas notificações sempre exigem assinatura válida. A URL de Preview não transforma credenciais reais em credenciais de teste: usar contas, cartões e credenciais de teste confirmados no painel Mercado Pago.

Preservar a integração OIDC Vercel/Neon e os bindings existentes de `ADMIN_PASSWORD`, `PRINT_AGENT_TOKEN`, `PRINT_QUEUE_DATABASE_URL`, `PRINT_QUEUE_START_AT`, `GOOGLE_MAPS_API_KEY` e, quando configurado, `DELIVERY_QUOTE_SECRET`. Não trocar token/corte da fila sem necessidade. Os valores não foram acessados nem modificados nesta correção. O ambiente atual não fornece credenciais Vercel/Mercado Pago nem conexão com o notebook; por isso, cobrança real, banco remoto, webhook pela internet e papel continuam pendentes de validação.

Depois da configuração segura, `node scripts/validate-payments-config.js --require-enabled --check-provider` verifica presença das variáveis e faz apenas leitura da conta. Não cria cobrança nem comprova sozinho que a conta permite crédito/débito.

## Conciliação e histórico

Uma tentativa incerta **não é reenviada**, mesmo se o primeiro processo tiver parado depois de reservar a tentativa e antes de enviar ao Mercado Pago. Recuperar por consulta, webhook autenticado ou conferência operacional da conta; nunca gerar outro pedido às cegas. Não remover registros de tentativa, vínculos, índices ou bloqueios durante o período de conciliação/estornos.

Reservas ainda não enviadas expiram para iniciar pagamento após 30 minutos. O navegador guarda apenas referência opaca, modalidade, total e indicadores da tentativa, sem dados de cartão/pessoais. Desligar novas cobranças não desliga a consulta ou o webhook de cobranças já iniciadas: mantenha o token e o segredo até encerrá-las.

O índice permanente é criado para novas reservas e para reservas antigas recuperadas pelos índices já existentes ou pela busca recente de três dias. **A migração dos registros anteriores é obrigatória antes de instalar/ativar o fluxo novo**, pois pedidos antigos sem índice não podem ser considerados protegidos contra reenvio tardio.

O script preparado usa o binding existente `PRINT_QUEUE_DATABASE_URL`; `VERCEL_ENV=preview` limita a operação a `mp-preview/`. Primeiro fazer backup e usar a simulação, que apenas lê e apresenta contagens:

```bash
node scripts/backfill-order-index.js
```

No ambiente correto, com autorização para a migração, pausar e drenar novos pedidos do aplicativo antigo antes de aplicar. Não desativar pedidos no atendimento sem combinar com a loja. Somente a opção explícita grava os índices:

```bash
node scripts/backfill-order-index.js --apply
```

A aplicação valida o namespace inteiro e insere índices em uma única instrução atômica. IDs duplicados, caminhos inválidos e índices conflitantes bloqueiam todas as inserções; o script não escolhe um pedido arbitrariamente nem altera reservas, filas ou índices existentes. A repetição é idempotente. Revisar e resolver qualquer bloqueio antes da instalação, sem apagar o histórico. Nunca rodar a migração com o aplicativo antigo ainda criando pedidos, pois uma nova reserva posterior à leitura poderia ficar sem índice. O pacote não executa essa migração automaticamente, e nenhum banco remoto foi migrado aqui.

## Validação externa e publicação

1. Revisar o diff sobre o `main` atual e manter o deployment anterior identificável.
2. Simular e aplicar a migração de índices no banco de teste correspondente, resolvendo qualquer bloqueio. Criar Preview autorizado, com credenciais de teste. Seus pedidos, índices, contadores e histórico usam `mp-preview/`; a fila física recusa o Preview.
3. Testar crédito e débito aprovados, pendência, recusa, cancelamento/estorno, autenticação bancária, duas abas, duplo clique, resposta perdida, recarga, correção de `property_value` e webhook repetido. Conferir adicionais, artesanal, combo, marmitex/doces/sobremesas, serviço e cotação assinada do frete. Verificar presencial e mesa sem exigência indevida de pagamento online.
4. Conferir uma única comanda após aprovação, nenhuma antes, e nenhum novo POST após resultado incerto. Testar desligar a flag durante pendência sem perder a conciliação.
5. A produção depende de autorização específica após essas verificações e da migração do histórico no banco correto, com pedidos antigos pausados/drenados. Não enviar diretamente a `main`: o projeto pode publicar automaticamente a partir do GitHub.
6. No Windows, caso seja necessário atualizar a identificação de pagamento no recibo, fazer backup e substituir apenas `FerraciniPrintAgent.ps1`, preservando configuração, token, atalhos e logs. Não instalar o agente físico no Linux da nuvem.
7. Conferir papel na Bematech e a recuperação após falha de comunicação. Spooler aceito não garante papel impresso; um trabalho já reivindicado exige conferência antes de qualquer reprocessamento.

Para interromper novas cobranças, desativar a flag e reaplicar a configuração Vercel, mantendo as rotas e credenciais de conciliação até encerrar pendências. Reverter para uma versão antiga sem essas rotas interrompe notificações de pagamentos em andamento.

## Resultado desta preparação

Validação com Node 22.23.4: instalação `npm ci`, snapshot estático, sintaxe e `git diff --check` passaram. `npm test` reportou 32 testes aprovados, sem falhas ou pulados, incluindo 6 da migração em PostgreSQL em memória. `npm run test:browser` reportou 15 cenários aprovados no Chromium, com SDK/API simulados. O diagnóstico confirmou que novas cobranças estão desativadas nesta máquina. Nenhuma cobrança, migração remota ou impressão física foi executada.

As correções e a integração com o `main` atual foram salvas na branch local `prepare/mercadopago-20261031`. Esta preparação não inclui push, merge remoto, alteração de variáveis, publicação de Preview ou implantação no domínio oficial. O teste real depende de acesso autorizado ao projeto Vercel e dos bindings de teste, seguidos da migração e dos testes externos descritos acima.
