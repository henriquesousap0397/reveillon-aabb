# Réveillon AABB Balsas 50 anos

Hotsite oficial de **O Réveillon da Nossa História**, a festa da virada de 31/12/2026 na sede da AABB Balsas, que celebra os 50 anos do clube.

- `public/`: o site, que é a única pasta publicada
  - `public/index.html`: o site inteiro (página única)
  - `public/assets/`: imagens
  - `public/barracas/`: página de reserva de barracas (lista e fotos em `public/barracas/fotos/`)
  - `public/painel/`: painel de visitas em português
  - `public/mesas/`: reserva de mesas do salão (mapa, reserva, acompanhamento e painel em `public/mesas/admin/`)
- `src/mesas.js`: sistema de reservas de mesas (Durable Object com banco SQLite)
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

## Mesas do salão

- Página pública: https://reveillon.aabbbalsas.workers.dev/mesas/
- Acompanhar reserva: `/mesas/reserva/?c=CODIGO`
- **Painel:** https://reveillon.aabbbalsas.workers.dev/mesas/admin/

### Ativar (uma vez)

1. No Cloudflare, projeto `reveillon` → **Settings → Variables and Secrets → Add** → tipo **Secret**, nome `ADMIN_SENHA`, com uma senha forte (mínimo 12 caracteres). Ela é a senha do painel.
2. Entre no painel, confira preços, estoques e a chave Pix em **Configurações** e ligue a chave **Vendas abertas no site**. Enquanto estiver desligada, o mapa mostra "Reservas em breve" e ninguém consegue reservar.

O banco de dados é criado sozinho na primeira publicação (Durable Object `Mesas`, configurado no `wrangler.jsonc`).

### Como funciona

- 40 mesas: Gold 01–15, Marrom 16–30, Royal 31–40. Seis lugares, até 2 cadeiras adicionais por mesa (R$ 50), estoque por setor (30/30/10).
- Preços iniciais: Gold R$ 500 / R$ 800, Marrom R$ 460 / R$ 700, Royal R$ 420 / R$ 600 (associado / não associado). Mudam no painel.
- Um pedido de cada vez: duas pessoas não conseguem reservar a mesma mesa nem passar do estoque de cadeiras.
- **Não associado:** a reserva fica "aguardando pagamento" e o site gera o Pix (copia e cola + QR Code) com o valor exato.
- **Associado:** fica "aguardando validação". A secretaria confere a matrícula no painel (**Validar associado** ou **Cobrar como não associado**) e o Pix aparece na página de acompanhamento.
- A secretaria confere o extrato e clica em **Confirmar pagamento**. A mesa fica "vendida" no mapa.
- Prazo: 24 h para pagar e 48 h para validar (ajustáveis). Vencido o prazo, a mesa volta a ficar disponível sozinha.
- Painel: resumo de arrecadação e ocupação por setor, venda pela secretaria, cadeiras adicionais depois da compra, cancelar, reativar, estender prazo, bloquear mesas, mensagem pronta no WhatsApp para o comprador e exportação em CSV (abre no Excel/Planilhas).
- Limite de 4 reservas ativas por CPF.

### Dados pessoais

Nome, CPF, telefone, e-mail e matrícula ficam só no banco do Cloudflare e aparecem só no painel (com senha) e na planilha exportada. O site público mostra apenas o primeiro nome na página de acompanhamento de quem tem o código. Depois do evento, exporte o que for necessário para a prestação de contas e apague o restante.
