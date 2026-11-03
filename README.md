# Réveillon AABB Balsas 50 anos

Hotsite oficial de **O Réveillon da Nossa História**, a festa da virada de 31/12/2026 na sede da AABB Balsas, que celebra os 50 anos do clube.

- `public/`: o site, que é a única pasta publicada
  - `public/index.html`: o site inteiro (página única)
  - `public/assets/`: imagens
- `wrangler.jsonc`: configuração do Cloudflare (diz para publicar só a pasta `public/`)

## Publicação

Hospedado no **Cloudflare Workers**, projeto `reveillon`, ligado a este repositório (branch `main`). Toda atualização enviada para a `main` vai para o ar sozinha.

Configuração do projeto no Cloudflare (Settings → Build):

- Build command: vazio
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

Endereço: https://reveillon.aabbbalsas.workers.dev/
