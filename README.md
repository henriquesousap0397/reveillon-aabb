# Réveillon AABB Balsas 50 anos

Hotsite oficial de **O Réveillon da Nossa História**, a festa da virada de 31/12/2026 na sede da AABB Balsas, que celebra os 50 anos do clube.

- `public/`: o site, que é a única pasta publicada
  - `public/index.html`: o site inteiro (página única)
  - `public/assets/`: imagens
  - `public/barracas/`: página de reserva de barracas (lista e fotos em `public/barracas/fotos/`)
  - `public/painel/`: painel de visitas em português
- `src/worker.js`: busca os números no Cloudflare Web Analytics para o painel (`/api/estatisticas`)
- `wrangler.jsonc`: configuração do Cloudflare (publica só a pasta `public/` e liga o `src/worker.js`)

## Publicação

Hospedado no **Cloudflare Workers**, projeto `reveillon`, ligado a este repositório (branch `main`). Toda atualização enviada para a `main` vai para o ar sozinha.

Configuração do projeto no Cloudflare (Settings → Build):

- Build command: vazio
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

Endereço: https://reveillon.aabbbalsas.workers.dev/

## Estatísticas

Visitas medidas pelo **Cloudflare Web Analytics** (gratuito, sem cookies e sem dados pessoais). O código fica no fim do `public/index.html`. Painel: Cloudflare → Analytics & Logs → Web Analytics → `reveillon.aabbbalsas.workers.dev`.

## Painel de visitas

- Endereço: https://reveillon.aabbbalsas.workers.dev/painel/ (sem senha; não aparece no Google)
- Prévia com dados de exemplo: https://reveillon.aabbbalsas.workers.dev/painel/?demo=1
- Precisa de dois **Secrets** no projeto `reveillon` do Cloudflare (Settings → Variables and Secrets):
  - `CF_API_TOKEN`: chave de API só de leitura, com a permissão **Account → Account Analytics → Read**
  - `ACCOUNT_ID`: ID da conta do Cloudflare
- Os números ficam guardados por 5 minutos para não sobrecarregar a API.

## Barracas

- Página: https://reveillon.aabbbalsas.workers.dev/barracas/
- Para marcar uma barraca como reservada, edite a lista `BARRACAS` no fim de `public/barracas/index.html` e troque `"disponivel"` por `"reservada"`.
- Link direto para uma barraca: `/barracas/#aabb-07` ou `/barracas/#metal-03`.
