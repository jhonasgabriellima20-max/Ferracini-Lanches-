# Sincronização com a produção

O site atual foi publicado manualmente na Vercel e não tem o GitHub como fonte oficial.

Na checagem de 13/09/2026, a produção atual continha recursos posteriores a este snapshot, incluindo:

- POST `/api/pedidos` retornando 201 em registro válido;
- GET `/api/pedidos` protegido pelo token do agente de impressão;
- registro de pedido antes de abrir o WhatsApp;
- estimativa de entrega exibida junto do frete;
- CEP e disponibilidade já ativos.

Antes de conectar este repositório à produção, sincronizar essas mudanças mais recentes e validar tudo em Preview.
