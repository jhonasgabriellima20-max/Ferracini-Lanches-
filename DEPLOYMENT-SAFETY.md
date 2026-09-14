# Ferracini Lanches — política de publicação segura

## Regra principal
Nunca publicar alteração diretamente no domínio de produção durante o atendimento da loja.

## Fluxo obrigatório
1. Alterar código em uma branch `preview/*` ou `preview`.
2. Rodar validação automática.
3. Criar deployment Preview na Vercel.
4. Conferir página inicial, cardápio, disponibilidade, retirada, entrega, frete e registro de pedidos.
5. Conferir logs do Preview.
6. Somente depois promover o deployment validado para produção.
7. Manter o deployment anterior como rollback imediato.

## Frete
- Google Routes é o provedor principal.
- Photon + OSRM é apenas contingência.
- HTTP 200 ou uma distância plausível não provam que o número exato da casa foi confirmado.
- HTTP 422 deve ser classificado: pode ser bloqueio esperado de cidade fora da área ou falha real de endereço válido.
- Nunca inventar distância quando os provedores não confirmarem o endereço.

## Produção de referência ao criar esta pasta
- Domínio: https://ferracinilanches.com.br
- Deployment observado como estável: dpl_9rzLFfwnDRYBRz369vYzNJ8ZGQMp
- Estado observado: READY / domínio 200 OK

## Atenção sobre este snapshot
Este pacote foi salvo antes da última evolução do registro automático de pedidos. A produção atual possui `/api/pedidos` e lógica posterior ao antigo `/api/comanda`. Portanto, este snapshot é backup de recuperação e base de versionamento; não deve ser promovido diretamente sem sincronizar a API de pedidos que está atualmente em produção.
