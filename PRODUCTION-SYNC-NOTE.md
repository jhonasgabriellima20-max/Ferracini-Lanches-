# Sincronização com a produção

Sincronização concluída em 14/09/2026.

O repositório agora contém o fluxo vigente:

- POST /api/pedidos com validação, idempotência e fila privada;
- GET e PATCH /api/pedidos protegidos pelo token do agente de impressão;
- registro do pedido antes de abrir o WhatsApp;
- estimativa de entrega exibida junto do frete;
- CEP e disponibilidade ativos;
- arredondamento do frete idêntico no navegador e no servidor;
- cabeçalhos de segurança e validação automática no GitHub.

A publicação automática fica desativada durante manutenção e só deve ser reativada após a validação passar.
