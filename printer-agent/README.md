# Ferracini Lanches — impressão automática local (sem PrintNode)

Programa para **Windows + Bematech MP-2500 TH**. O notebook consulta a fila exclusiva
/api/fila-impressao e envia os pedidos confirmados ao spooler do Windows.

## Segurança e condições antes de ativar

**Não execute o agente em uma loja aberta enquanto os 3 itens abaixo não estiverem configurados e testados.**

- No projeto Vercel de produção: PRINT_AGENT_TOKEN (chave forte/aleatória), PRINT_QUEUE_DATABASE_URL (conexão Neon como segredo, nunca no código/HTML) e PRINT_QUEUE_START_AT (UTC ISO 8601, ex.: 2026-10-10T21:00:00Z). Este último é o instante real de ativação e impede a impressão de pedidos antigos.
- Instale a nova rota api/fila-impressao.js e a dependência Neon.
- Faça teste de ponta a ponta com pedido fictício antes de servir clientes.

## Instalação no notebook

1. Confira que a Bematech imprime a página de teste pelo Windows.
2. Copie a pasta printer-agent para C:\FerraciniPrintAgent e **não mova depois**.
3. Dê dois cliques em Ferracini-Impressao.cmd.
4. Escolha 1 - Configurar impressora e token; selecione MP-2500 TH.
5. Aceite intervalo **5 segundos** e largura **42 caracteres** para bobina de 80 mm.
6. Cole PRINT_AGENT_TOKEN no prompt; será cifrado para o usuário atual do Windows e não aparecerá na tela. Nunca compartilhe a chave no chat.
7. Escolha 2 - Imprimir teste e confira o papel.
8. Após a rota e as variáveis funcionarem e o teste real de pedido passar, escolha 3 - Instalar início automático com Windows.
9. Escolha 4 - Iniciar agente agora para operar. Quando o Windows iniciar a sessão novamente, o agente inicia no login (requer notebook ligado e sessão iniciada).

## Comportamento da fila

- A consulta retorna **somente pedidos pendentes**, até 25 a cada chamada; itens já impressos não ocupam espaço na busca.
- Cada pedido passa por uma reivindicação **atômica** (pendente -> imprimindo) para que agentes concorrentes não imprimam o mesmo pedido.
- Depois de enviar ao spooler do Windows, o status muda para impresso.
- Se a impressora/driver rejeitar o trabalho, o pedido fica falhou, com erro salvo; **não** é reenviado automaticamente para evitar duplicação.
- Se o notebook desligar depois da reivindicação ou o servidor não confirmar o estado, uma comanda pode permanecer imprimindo. Um operador deve conferir o papel e o log antes de reprocessá-la.
- Impressão física exatamente uma vez **não pode ser garantida** apenas pelo retorno do spooler; é indispensável supervisão e procedimento de recuperação.
- O agente grava config.json, token.dat, ferracini-print.log no próprio notebook; **não** subir arquivos locais nem tokens ao GitHub.
- Custos: sem mensalidade de aplicativo de impressão. Internet, energia, papel e hospedagem/banco ainda podem gerar despesas.

## Capacidade pretendida

Meta de dimensionamento: **90 pedidos por hora**. O código evita o teto anterior de 100 registros lidos por consulta, mas a capacidade real só estará validada depois do teste de carga do servidor e da impressora física.

## Manutenção

No menu use 5 - Abrir arquivo de log para diagnosticar. Em caso de mensagem de falha ou comanda imprimindo travada, confira impressora/spooler e histórico antes de qualquer reimpressão. Sem confirmação manual da cozinha: o recebimento ocorre na fila quando o sistema registra o pedido.

## Novo modelo visual: negrito, ícones e taxa de serviço

- Comanda, data e hora, cliente, itens e quantidades, taxa de serviço e total recebem destaque em **negrito**. O total fica com fonte maior.
- Ícones/emojis são incluídos na impressão Windows por padrão. A Bematech MP-2500 TH e seu driver podem não reproduzir todos os símbolos; confirme com a **comanda fictícia de teste**, sem criar pedido ou alterar a fila.
- Para imprimir sem emojis, no `config.json` existente defina `"useEmojis": false` e reinicie o agente. Os títulos e valores continuam em negrito.
- Em **comer no local**, a comanda mostra mesa e taxa de serviço de R$ 3,00 quando o pedido contém `taxaServicoCentavos: 300`, mas não imprime o bloco de forma de pagamento.
- Não existe alteração na API, fila, token ou ordem dos pedidos: é somente o formato local do recibo.

## Marmitex Mini e Média na comanda

- Marmitas cadastradas no cardápio seguem **a mesma fila automática** dos lanches, depois que o pedido estiver confirmado/liberado pelas regras existentes. Não há segunda impressora ou cobrança adicional por modalidade.
- A impressão identifica pelo nome `Marmitex` ou `Marmita` (ou pela categoria `marmitex` quando informada), usando o ícone 🍱; os lanches continuam com 🍔.
- A comanda mostra quantidade, nome, observações e total de cada item. O pedido pode conter marmitas e lanches juntos.
- O menu **2 - Imprimir teste** gera **duas comandas fictícias** usando exatamente o mesmo modelo universal: uma para ENTREGA (com taxa de entrega) e outra para MESA (com taxa de serviço). Ambas contêm Marmitex Mini, Marmitex Média, X-SALADA, Brigadeiro e Pudim. Os preços dos testes são ilustrativos e **não** alteram os valores do painel.
- Marmitex sem preço definido permanece indisponível para compras. O responsável cadastra os preços e a descrição no painel antes da primeira venda.
- Doces e sobremesas cadastrados no painel compartilham a mesma fila e a mesma comanda dos demais produtos. O servidor valida a categoria antes da impressão. Doces aparecem como `DOCE - Nome` com 🍬, sobremesas como `SOBREMESA - Nome` com 🍰, marmitas 🍱 e lanches 🍔.
- A taxa de entrega 🛵 aparece **somente para entrega**, quando cobrada; a taxa de serviço ➕ aparece **quando registrada no pedido**. Subtotal, total, observações, horário, atendimento e forma de pagamento continuam no mesmo layout. Os itens e as taxas nunca são inventados pelo agente.
- Há **um único modelo**, independentemente de horário, categoria ou tipo de atendimento; não é necessário trocar a impressão entre o almoço e a noite.
- A impressão de símbolos e emojis depende do suporte real do driver Bematech/Windows e precisa ser confirmada na impressora. Mesmo sem emoji, `DOCE -` e `SOBREMESA -` permanecem legíveis.
- **O arquivo local do notebook não é atualizado sozinho por um commit no GitHub.** Substitua apenas `C:\FerraciniPrintAgent\FerraciniPrintAgent.ps1` pela nova versão do repositório; não toque em `config.json`, `token.dat`, arquivos `.cmd` ou log. Reinicie o agente/Windows para carregar o novo layout.
- Verifique a saída física na Bematech. O retorno do spooler não garante por si só a impressão no papel.

### Atualizar o notebook já instalado

1. Preferencialmente, baixe e execute `Atualizar-Comanda-Ferracini.cmd` do repositório no **notebook Windows**, com o agente parado; ele faz backup e atualiza somente o `FerraciniPrintAgent.ps1`, preservando configuração, token e logs. É uma atualização única, não uma troca a cada período do dia.
2. Como alternativa manual, mantenha uma cópia de segurança do arquivo `FerraciniPrintAgent.ps1` atual.
3. Baixe a nova versão de `printer-agent/FerraciniPrintAgent.ps1` deste repositório e substitua **somente** esse arquivo na pasta instalada, normalmente `C:\FerraciniPrintAgent`.
4. **Não** apague nem substitua `config.json`, `token.dat`, os arquivos `.cmd` nem o log. Não é preciso gerar outro token.
5. Reinicie o agente (ou Windows) com a Bematech ligada e conectada; a inicialização automática existente passa a usar o novo script.
6. No menu existente, escolha **2 — Imprimir teste** e confira ambas as comandas e símbolos no papel. Os testes não vão para o servidor.
7. Antes de atender clientes, confira se a impressão de um pedido legítimo funciona. Se as figuras saírem como quadradinhos, desative somente `useEmojis` no `config.json`, mantendo o negrito.
