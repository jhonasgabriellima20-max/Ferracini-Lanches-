# Ferracini Lanches — base de segurança

Este pacote foi preparado para migrar o projeto do fluxo de deploy manual para um fluxo seguro com GitHub + Preview da Vercel.

- `main`: somente versões validadas.
- `preview`: alterações e testes.
- Nunca publicar direto na produção durante o atendimento.
- Sempre testar o Preview antes de promover.
- Armazenamento de produção: Neon/Postgres. O Vercel Blob legado não faz parte do fluxo de pedidos/comandas.

Leia `DEPLOYMENT-SAFETY.md` e `PRODUCTION-SYNC-NOTE.md` antes de conectar este repositório ao domínio oficial.
