# Réveillon AABB Balsas 50 anos

Hotsite oficial de **O Réveillon da Nossa História**, a festa da virada de 31/12/2026 na sede da AABB Balsas, que celebra os 50 anos do clube.

- `public/`: o site, que é a única pasta publicada
  - `public/index.html`: o site inteiro (página única)
  - `public/assets/`: imagens
  - `public/barracas/`: página de reserva de barracas (lista e fotos em `public/barracas/fotos/`)
  - `public/mesas/`: reserva de mesas com mapa interativo; `public/mesas/admin/`: painel administrativo das mesas
  - `public/painel/`: painel de visitas em português
- `src/mesas.js`: sistema de reservas de mesas (Durable Object `Mesas`)
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

## Ingressos

- Lote antecipado até 15/12: associado R$ 50, não associado R$ 70.
- Os botões "Comprar ingresso" abrem o WhatsApp da secretaria com uma mensagem pronta. Para ligar, preencha `WHATSAPP` no script de `public/index.html` (DDI+DDD+número, só dígitos). Enquanto estiver vazio, os botões levam ao Instagram @aabb.balsas.

## Mesas

- Página: https://reveillon.aabbbalsas.workers.dev/mesas/ · Admin: https://reveillon.aabbbalsas.workers.dev/mesas/admin/
- 40 mesas (Gold 01–15, Marrom 16–30, Royal 31–40), 6 lugares, até 2 cadeiras extras (estoque por setor: 30/30/10).
- As reservas ficam num Durable Object do Cloudflare (`src/mesas.js`), que atende um pedido por vez: duas pessoas nunca reservam a mesma mesa.
- Reserva nova fica "aguardando pagamento" pelo prazo configurado (padrão 24h). Se não for confirmada, a mesa volta a ficar livre sozinha.
- O Secret **`ADMIN_SENHA`** (Settings → Variables and Secrets) é a senha do **administrador principal**: no painel, deixe o usuário em branco e use essa senha.
- Pelo painel, administradores cadastram outros usuários (operador ou administrador). O sistema gera uma senha provisória (vale 7 dias) e a pessoa cria a própria senha no primeiro acesso. Também geram nova senha provisória, desativam e removem acessos. Senhas guardadas só como hash (PBKDF2). Sessão de 12h. Toda ação fica no histórico com o nome de quem fez.
- Operador: vende mesas no painel ("+ Nova venda" ou tocando numa mesa livre do mapa), confirma pagamentos, valida associados, ajusta cadeiras, prorroga e cancela. Administrador: também preços, estoque, bloqueio de mesas, abrir/fechar vendas, usuários e apagar reservas.
- Dados pessoais (nome, WhatsApp, e-mail e CPF do associado) só aparecem no admin e na planilha exportada. O CPF é conferido pelos dígitos verificadores; a secretaria valida a associação pelo nome + CPF. Apagar as reservas depois do evento (botão "Apagar" em reservas canceladas, ou pedir ao desenvolvedor).
- Para testar localmente: crie `.dev.vars` com `ADMIN_SENHA=...` e rode `npx wrangler dev`.
