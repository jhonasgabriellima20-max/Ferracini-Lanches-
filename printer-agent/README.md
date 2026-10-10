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
