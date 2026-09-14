# Painel de disponibilidade — Ferracini Lanches

## O que foi adicionado
- `/admin` (ou `/admin.html`) com senha.
- Liga/desliga ingredientes.
- Ao desligar um ingrediente, todos os lanches que dependem dele ficam indisponíveis automaticamente.
- O ingrediente também some dos adicionais.
- Liga/desliga lanches e bebidas individualmente.
- `/index.html` e `/mesa.html` usam a mesma disponibilidade.
- Clientes atualizam automaticamente em até 20 segundos.

## Configuração necessária na Vercel
1. No projeto `ferracini-lanches`, conecte/crie um Vercel Blob privado.
2. Em Settings > Environment Variables, crie `ADMIN_PASSWORD` com uma senha forte escolhida pelo proprietário.
3. Preserve `GOOGLE_MAPS_API_KEY` já usada para cálculo de entrega.
4. Faça um novo deploy depois dessas configurações.

O Vercel Blob atual usa autenticação OIDC quando conectado ao projeto; não é necessário colocar token do Blob no HTML.


## Numeração diária das comandas
As comandas são sequenciais dentro do dia (01, 02, 03...) e zeram automaticamente à meia-noite no horário de Brasília (America/Sao_Paulo).
