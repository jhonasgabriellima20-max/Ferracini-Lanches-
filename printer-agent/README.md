# Ferracini Lanches — agente de impressão

Este diretório contém o programa local que consulta a fila protegida de pedidos do site e envia as comandas para a impressora instalada no Windows.

## O que já está pronto

- Busca automática dos pedidos pendentes em `https://ferracinilanches.com.br/api/pedidos`.
- Autenticação por `PRINT_AGENT_TOKEN`.
- Token salvo criptografado pelo Windows para o usuário que configurou o agente.
- Impressão de número da comanda, cliente, telefone, mesa/retirada/entrega, endereço, itens, adicionais, observações, subtotal, taxa de entrega, total, pagamento e troco.
- Atualização do status da fila para evitar impressão duplicada por duas instâncias do agente.
- Inicialização automática junto com o Windows.
- Log local para diagnóstico.

## Instalação no notebook da loja

1. Instale o driver oficial da impressora e confirme que ela aparece em **Configurações > Bluetooth e dispositivos > Impressoras e scanners**.
2. Copie a pasta `printer-agent` para um local fixo, recomendado: `C:\FerraciniPrintAgent`.
3. Abra `Ferracini-Impressao.cmd` com duplo clique.
4. Escolha **1 — Configurar impressora e token**.
5. Selecione a impressora da lista.
6. Para uma impressora térmica de 80 mm, deixe inicialmente **42 caracteres**. Para papel mais largo, esse valor poderá ser aumentado depois do teste.
7. Cole o valor de `PRINT_AGENT_TOKEN` quando solicitado. Ele não será exibido na tela e será armazenado criptografado pelo Windows.
8. Volte ao menu e escolha **2 — Imprimir teste**.
9. No driver da impressora, ajuste largura do papel, margens e corte automático conforme o modelo comprado.
10. Quando o teste estiver correto, escolha **3 — Instalar início automático com Windows**.
11. Escolha **4 — Iniciar agente agora** somente para testar imediatamente. Depois de instalado no início automático, o agente inicia sozinho quando o usuário entrar no Windows.

## Arquivos locais que não devem ser enviados ao GitHub

O programa cria no próprio notebook:

- `config.json` — nome da impressora e preferências.
- `token.dat` — token criptografado pelo Windows.
- `ferracini-print.log` — histórico de funcionamento/erros.

Nunca envie `token.dat` a terceiros e nunca coloque o `PRINT_AGENT_TOKEN` dentro do código-fonte.

## No dia da instalação

Será necessário ter fisicamente o notebook e a impressora para concluir três pontos que não podem ser definidos antes de saber o modelo/driver instalado: selecionar o nome exato da impressora no Windows, acertar a largura/corte do papel e fazer a primeira impressão real.

O Pix não faz parte deste agente e pode ser integrado ao site separadamente depois.
