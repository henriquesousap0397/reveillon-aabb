// Worker do hotsite do Réveillon AABB 50 anos.
// - Serve o site (pasta public/) normalmente.
// - Em /api/mesas, /api/reservas e /api/admin, cuida das reservas de mesas do salão (src/mesas.js).
// - Em /api/estatisticas, busca no Cloudflare Web Analytics os números de visitas
//   e devolve um resumo para o painel em /painel/.
//
// Precisa de dois "Secrets" configurados no projeto "reveillon" do Cloudflare:
//   CF_API_TOKEN  -> chave com permissão "Account Analytics: Read" (só leitura)
//   ACCOUNT_ID    -> ID da conta do Cloudflare

const HOST = "reveillon.aabbbalsas.workers.dev"; // site medido
const INICIO = "2026-11-03";                      // data de lançamento (horário de Balsas)
const FUSO_HORAS = -3;                            // Balsas/MA: UTC-3, sem horário de verão
const JANELA_DIAS = 7;                            // consulta em blocos de 7 dias
const CACHE_SEGUNDOS = 300;                       // guarda o resumo por 5 minutos

import { rotaMesas } from "./mesas.js";
export { Mesas } from "./mesas.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/estatisticas") return estatisticas(request, env, ctx);
    const mesas = await rotaMesas(request, env);
    if (mesas) return mesas;
    return env.ASSETS.fetch(request);
  },
};

function json(dados, status = 200, cache = false) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache ? `public, max-age=${CACHE_SEGUNDOS}` : "no-store",
    },
  });
}

async function estatisticas(request, env, ctx) {
  if (!env.CF_API_TOKEN || !env.ACCOUNT_ID) {
    return json({ erro: "configuracao", mensagem: "Faltam os Secrets CF_API_TOKEN e ACCOUNT_ID no projeto do Cloudflare." }, 503);
  }

  const cache = caches.default;
  const chave = new Request(new URL("/api/estatisticas?cache=v1", request.url).toString());
  const guardado = await cache.match(chave);
  if (guardado) return guardado;

  try {
    const resumo = await montarResumo(env);
    const resposta = json(resumo, 200, true);
    ctx.waitUntil(cache.put(chave, resposta.clone()));
    return resposta;
  } catch (e) {
    return json({ erro: "api", mensagem: String(e && e.message ? e.message : e) }, 502);
  }
}

// Converte "AAAA-MM-DD" (meia-noite em Balsas) para o instante em UTC.
function meiaNoiteLocal(dataISO) {
  return new Date(Date.parse(dataISO + "T00:00:00Z") - FUSO_HORAS * 3600 * 1000);
}

// Data local (Balsas) de um instante UTC, no formato AAAA-MM-DD.
function dataLocal(instante) {
  return new Date(instante.getTime() + FUSO_HORAS * 3600 * 1000).toISOString().slice(0, 10);
}

const CONSULTA = `
query Painel($conta: String!, $inicio: Time!, $fim: Time!, $host: string!) {
  viewer {
    accounts(filter: { accountTag: $conta }) {
      hora: rumPageloadEventsAdaptiveGroups(
        limit: 1000
        filter: { AND: [{ datetime_geq: $inicio, datetime_lt: $fim }, { requestHost: $host }] }
        orderBy: [datetimeHour_ASC]
      ) { count sum { visits } dimensions { datetimeHour } }
      origem: rumPageloadEventsAdaptiveGroups(
        limit: 100
        filter: { AND: [{ datetime_geq: $inicio, datetime_lt: $fim }, { requestHost: $host }] }
        orderBy: [sum_visits_DESC]
      ) { count sum { visits } dimensions { refererHost } }
      aparelho: rumPageloadEventsAdaptiveGroups(
        limit: 10
        filter: { AND: [{ datetime_geq: $inicio, datetime_lt: $fim }, { requestHost: $host }] }
        orderBy: [sum_visits_DESC]
      ) { count sum { visits } dimensions { deviceType } }
    }
  }
}`;

async function consultar(env, inicio, fim) {
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: JSON.stringify({
      query: CONSULTA,
      variables: { conta: env.ACCOUNT_ID, inicio: inicio.toISOString(), fim: fim.toISOString(), host: HOST },
    }),
  });
  const corpo = await r.json().catch(() => null);
  if (!r.ok || !corpo) throw new Error(`Cloudflare respondeu ${r.status}`);
  if (corpo.errors && corpo.errors.length) throw new Error(corpo.errors[0].message);
  const conta = corpo.data && corpo.data.viewer && corpo.data.viewer.accounts && corpo.data.viewer.accounts[0];
  if (!conta) throw new Error("Conta não encontrada. Confira o ACCOUNT_ID.");
  return conta;
}

function nomeOrigem(host) {
  const h = (host || "").toLowerCase().replace(/^www\./, "");
  if (!h) return "Acesso direto";
  if (h === HOST) return null; // navegação dentro do próprio site
  if (h.includes("instagram")) return "Instagram";
  if (h.includes("whatsapp") || h === "wa.me") return "WhatsApp";
  if (h.includes("linktr.ee") || h === "tr.ee") return "Linktree";
  if (h.includes("facebook") || h === "fb.com" || h === "fb.me") return "Facebook";
  if (h.includes("google")) return "Google";
  if (h.includes("t.co") || h.includes("twitter") || h === "x.com") return "X (Twitter)";
  if (h.includes("tiktok")) return "TikTok";
  if (h.includes("youtube")) return "YouTube";
  return h;
}

const APARELHOS = { mobile: "Celular", desktop: "Computador", tablet: "Tablet" };

async function montarResumo(env) {
  const agora = new Date();
  const hoje = dataLocal(agora);
  const porDia = new Map();   // data local -> { visitas, visualizacoes }
  const origens = new Map();
  const aparelhos = new Map();

  // Preenche todos os dias desde o lançamento, mesmo os sem visita.
  for (let d = meiaNoiteLocal(INICIO); dataLocal(d) <= hoje; d = new Date(d.getTime() + 86400000)) {
    porDia.set(dataLocal(d), { visitas: 0, visualizacoes: 0 });
  }

  // Consulta em blocos para respeitar os limites da API.
  const blocos = [];
  for (let ini = meiaNoiteLocal(INICIO); ini < agora; ini = new Date(ini.getTime() + JANELA_DIAS * 86400000)) {
    const fim = new Date(Math.min(ini.getTime() + JANELA_DIAS * 86400000, agora.getTime()));
    blocos.push([ini, fim]);
  }
  const resultados = await Promise.all(blocos.map(([i, f]) => consultar(env, i, f)));

  for (const conta of resultados) {
    for (const g of conta.hora || []) {
      const dia = dataLocal(new Date(g.dimensions.datetimeHour));
      const item = porDia.get(dia) || { visitas: 0, visualizacoes: 0 };
      item.visitas += g.sum.visits;
      item.visualizacoes += g.count;
      porDia.set(dia, item);
    }
    for (const g of conta.origem || []) {
      const nome = nomeOrigem(g.dimensions.refererHost);
      if (!nome) continue;
      origens.set(nome, (origens.get(nome) || 0) + g.sum.visits);
    }
    for (const g of conta.aparelho || []) {
      const nome = APARELHOS[g.dimensions.deviceType] || "Outros";
      aparelhos.set(nome, (aparelhos.get(nome) || 0) + g.sum.visits);
    }
  }

  const dias = [...porDia.entries()].sort().map(([data, v]) => ({ data, ...v }));
  const seteDiasAtras = dataLocal(new Date(meiaNoiteLocal(hoje).getTime() - 6 * 86400000));
  const soma = (lista, campo) => lista.reduce((t, d) => t + d[campo], 0);
  const ordenar = (m) => [...m.entries()].map(([nome, visitas]) => ({ nome, visitas })).filter((o) => o.visitas > 0).sort((a, b) => b.visitas - a.visitas);

  return {
    atualizado: agora.toISOString(),
    inicio: INICIO,
    hoje,
    totais: {
      hoje: (porDia.get(hoje) || { visitas: 0 }).visitas,
      semana: soma(dias.filter((d) => d.data >= seteDiasAtras), "visitas"),
      visitas: soma(dias, "visitas"),
      visualizacoes: soma(dias, "visualizacoes"),
    },
    dias,
    origens: ordenar(origens),
    aparelhos: ordenar(aparelhos),
  };
}
