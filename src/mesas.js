// ===== Reservas de mesas do Réveillon AABB 50 anos =====
// Um único Durable Object guarda o estado de todas as reservas. Ele atende um pedido
// de cada vez, então duas pessoas nunca conseguem reservar a mesma mesa ao mesmo tempo.
//
// Rotas públicas:   GET  /api/mesas            -> mapa, preços e estoque (sem dados pessoais)
//                   POST /api/mesas/reservar   -> cria uma reserva "aguardando pagamento"
// Rotas do admin:   GET  /api/admin/mesas      -> tudo, com dados dos compradores
//                   POST /api/admin/mesas      -> ações (confirmar, cancelar, preços, etc.)
//                   GET  /api/admin/mesas.csv  -> exportação
// O admin envia a senha no cabeçalho "x-admin-senha". A senha fica no Secret ADMIN_SENHA.

import { DurableObject } from "cloudflare:workers";

const FUSO_HORAS = -3; // Balsas/MA

export const SETORES = {
  gold:   { nome: "Gold",   mesas: [1, 15],  cadeira: "Cadeiras Tiffany douradas", local: "mais próximo do palco" },
  marrom: { nome: "Marrom", mesas: [16, 30], cadeira: "Cadeiras Tiffany marrons",  local: "área intermediária" },
  royal:  { nome: "Royal",  mesas: [31, 40], cadeira: "Cadeiras Royal douradas",   local: "área posterior do salão" },
};

const CONFIG_PADRAO = {
  precos: {
    gold:   { associado: 500, nao_associado: 800 },
    marrom: { associado: 460, nao_associado: 700 },
    royal:  { associado: 420, nao_associado: 600 },
  },
  preco_cadeira: 50,
  estoque_cadeiras: { gold: 30, marrom: 30, royal: 10 },
  max_cadeiras_por_mesa: 2,
  lugares_por_mesa: 6,
  prazo_pagamento_horas: 24,
  vendas_abertas: true,
};

const PAGAMENTOS = { pix: "Pix", cartao: "Cartão de crédito (até 3x)", secretaria: "Outra condição (secretaria)" };
const TIPOS = { associado: "Associado", nao_associado: "Não associado" };

export function setorDaMesa(n) {
  for (const [k, s] of Object.entries(SETORES)) if (n >= s.mesas[0] && n <= s.mesas[1]) return k;
  return null;
}
function fileira(n) { return Math.ceil(n / 5); }
function fileiraNoSetor(n) {
  const s = SETORES[setorDaMesa(n)];
  return Math.ceil((n - s.mesas[0] + 1) / 5);
}
function horaLocal(ms) {
  return new Date(ms + FUSO_HORAS * 3600000).toISOString().replace("T", " ").slice(0, 16);
}
function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function erro(msg, status = 400) { return json({ erro: msg }, status); }
function limpa(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
function codigo(mesa) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  const r = crypto.getRandomValues(new Uint8Array(4));
  for (const b of r) c += abc[b % abc.length];
  return "M" + String(mesa).padStart(2, "0") + "-" + c;
}
function senhaConfere(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

// ----- Encaminhamento a partir do Worker principal -----
export async function rotaMesas(request, env) {
  if (!env.MESAS) return erro("Sistema de mesas indisponível no momento.", 503);
  const stub = env.MESAS.get(env.MESAS.idFromName("reveillon-2027"));
  return stub.fetch(request);
}

export class Mesas extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.tentativasReserva = new Map(); // ip -> [instantes]
    this.falhasLogin = new Map();       // ip -> [instantes]
  }

  async estado() {
    const e = (await this.ctx.storage.get("estado")) || {};
    e.config = Object.assign({}, CONFIG_PADRAO, e.config || {});
    e.config.precos = Object.assign({}, CONFIG_PADRAO.precos, e.config.precos || {});
    e.config.estoque_cadeiras = Object.assign({}, CONFIG_PADRAO.estoque_cadeiras, e.config.estoque_cadeiras || {});
    e.reservas = e.reservas || [];
    e.bloqueadas = e.bloqueadas || [];
    e.historico = e.historico || [];
    return e;
  }
  async salvar(e) { await this.ctx.storage.put("estado", e); }

  // Reserva "aguardando" com prazo vencido deixa de valer (a mesa volta a ficar livre).
  ativa(r, agora) {
    if (r.status === "vendida") return true;
    if (r.status === "aguardando") return r.expira > agora;
    return false;
  }
  statusEfetivo(r, agora) {
    if (r.status === "aguardando" && r.expira <= agora) return "expirada";
    return r.status;
  }
  reservaDaMesa(e, n, agora) { return e.reservas.find((r) => r.mesa === n && this.ativa(r, agora)); }
  cadeirasUsadas(e, setor, agora, ignorar) {
    return e.reservas.filter((r) => r.setor === setor && this.ativa(r, agora) && r.codigo !== ignorar).reduce((t, r) => t + r.extras, 0);
  }
  valor(e, setor, tipo, extras) { return e.config.precos[setor][tipo] + extras * e.config.preco_cadeira; }

  publico(e, agora) {
    const mesas = [];
    for (let n = 1; n <= 40; n++) {
      const r = this.reservaDaMesa(e, n, agora);
      const setor = setorDaMesa(n);
      mesas.push({
        n, setor, fileira: fileira(n), fileira_setor: fileiraNoSetor(n),
        status: e.bloqueadas.includes(n) ? "indisponivel" : r ? (r.status === "vendida" ? "vendida" : "aguardando") : "disponivel",
      });
    }
    const setores = {};
    for (const [k, s] of Object.entries(SETORES)) {
      const usadas = this.cadeirasUsadas(e, k, agora);
      setores[k] = {
        nome: s.nome, mesas: s.mesas, cadeira: s.cadeira, local: s.local,
        precos: e.config.precos[k],
        cadeiras_total: e.config.estoque_cadeiras[k],
        cadeiras_restantes: Math.max(0, e.config.estoque_cadeiras[k] - usadas),
      };
    }
    return {
      atualizado: new Date(agora).toISOString(),
      vendas_abertas: e.config.vendas_abertas,
      preco_cadeira: e.config.preco_cadeira,
      max_cadeiras_por_mesa: e.config.max_cadeiras_por_mesa,
      lugares_por_mesa: e.config.lugares_por_mesa,
      prazo_pagamento_horas: e.config.prazo_pagamento_horas,
      setores, mesas,
    };
  }

  limite(mapa, ip, max, janelaMs, agora) {
    const lista = (mapa.get(ip) || []).filter((t) => agora - t < janelaMs);
    mapa.set(ip, lista);
    return lista.length >= max;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const corpo = request.method === "POST" ? (await request.text()).slice(0, 20000) : "";
    return this.atender({
      caminho: url.pathname,
      metodo: request.method,
      ip: request.headers.get("cf-connecting-ip") || "0",
      senha: request.headers.get("x-admin-senha") || "",
      senhaCerta: (this.env && this.env.ADMIN_SENHA) || "",
      corpo,
    });
  }

  async atender(req) {
    const agora = Date.now();
    const e = await this.estado();

    if (req.caminho === "/api/mesas" && req.metodo === "GET") return json(this.publico(e, agora));
    if (req.caminho === "/api/mesas/reservar" && req.metodo === "POST") return this.reservar(e, req, agora);

    if (req.caminho.startsWith("/api/admin/")) {
      if (!req.senhaCerta) return erro("Painel ainda não configurado: falta o Secret ADMIN_SENHA no Cloudflare.", 503);
      if (this.limite(this.falhasLogin, req.ip, 10, 15 * 60000, agora)) return erro("Muitas tentativas. Aguarde 15 minutos.", 429);
      if (!senhaConfere(req.senha, req.senhaCerta)) {
        this.falhasLogin.get(req.ip).push(agora);
        return erro("Senha incorreta.", 401);
      }
      if (req.caminho === "/api/admin/mesas" && req.metodo === "GET") return json(this.admin(e, agora));
      if (req.caminho === "/api/admin/mesas.csv" && req.metodo === "GET") return this.csv(e, agora);
      if (req.caminho === "/api/admin/mesas" && req.metodo === "POST") return this.acao(e, req, agora);
    }
    return erro("Não encontrado.", 404);
  }

  async reservar(e, req, agora) {
    let d;
    try { d = JSON.parse(req.corpo || "{}"); } catch { return erro("Pedido inválido."); }
    if (d.site) return erro("Pedido inválido."); // campo-armadilha contra robôs
    if (!e.config.vendas_abertas) return erro("As vendas de mesas estão encerradas no momento.");
    if (this.limite(this.tentativasReserva, req.ip, 5, 3600000, agora)) return erro("Muitas reservas seguidas deste aparelho. Fale com a secretaria.", 429);

    const mesa = Number(d.mesa);
    const setor = setorDaMesa(mesa);
    if (!Number.isInteger(mesa) || !setor) return erro("Mesa inválida.");
    const tipo = d.tipo === "associado" ? "associado" : d.tipo === "nao_associado" ? "nao_associado" : null;
    if (!tipo) return erro("Informe se você é associado ou não associado.");
    const extras = Number(d.extras || 0);
    if (!Number.isInteger(extras) || extras < 0 || extras > e.config.max_cadeiras_por_mesa) return erro("Quantidade de cadeiras adicionais inválida.");
    const nome = limpa(d.nome, 80);
    if (nome.length < 5 || !/\s/.test(nome)) return erro("Informe seu nome completo.");
    const whatsapp = String(d.whatsapp || "").replace(/\D/g, "");
    if (whatsapp.length < 10 || whatsapp.length > 13) return erro("Informe um WhatsApp válido, com DDD.");
    const email = limpa(d.email, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return erro("E-mail inválido.");
    const matricula = limpa(d.matricula, 30);
    if (tipo === "associado" && matricula.length < 2) return erro("Informe o número da sua carteirinha ou matrícula de associado.");
    const pagamento = PAGAMENTOS[d.pagamento] ? d.pagamento : null;
    if (!pagamento) return erro("Escolha a forma de pagamento.");
    if (d.consentimento !== true) return erro("É preciso concordar com o uso dos dados para a reserva.");

    if (e.bloqueadas.includes(mesa)) return erro("Esta mesa não está disponível.", 409);
    if (this.reservaDaMesa(e, mesa, agora)) return erro("Esta mesa acabou de ser reservada por outra pessoa. Escolha outra.", 409);
    const restantes = e.config.estoque_cadeiras[setor] - this.cadeirasUsadas(e, setor, agora);
    if (extras > restantes) return erro(restantes > 0 ? `Restam apenas ${restantes} cadeira(s) adicional(is) neste setor.` : "As cadeiras adicionais deste setor esgotaram.", 409);

    const r = {
      codigo: codigo(mesa), mesa, setor, tipo, extras,
      valor: this.valor(e, setor, tipo, extras),
      nome, whatsapp, email, matricula: tipo === "associado" ? matricula : "",
      associado_validado: false,
      pagamento, status: "aguardando",
      criado: agora, atualizado: agora,
      expira: agora + e.config.prazo_pagamento_horas * 3600000,
      obs: "",
    };
    e.reservas.push(r);
    e.historico.push({ t: agora, acao: "reserva", codigo: r.codigo, mesa });
    await this.salvar(e);
    this.tentativasReserva.get(req.ip).push(agora);
    return json({
      ok: true, codigo: r.codigo, mesa, setor: SETORES[setor].nome, tipo: TIPOS[tipo], extras,
      lugares: e.config.lugares_por_mesa + extras, valor: r.valor, pagamento: PAGAMENTOS[pagamento],
      expira: new Date(r.expira).toISOString(), prazo_horas: e.config.prazo_pagamento_horas,
    });
  }

  admin(e, agora) {
    const reservas = e.reservas.map((r) => Object.assign({}, r, {
      status_efetivo: this.statusEfetivo(r, agora),
      setor_nome: SETORES[r.setor].nome, tipo_nome: TIPOS[r.tipo], pagamento_nome: PAGAMENTOS[r.pagamento],
      criado_local: horaLocal(r.criado), expira_local: horaLocal(r.expira),
    })).sort((a, b) => b.criado - a.criado);
    const rel = { setores: {}, confirmado: 0, a_receber: 0, vendidas: 0, aguardando: 0, livres: 0, indisponiveis: e.bloqueadas.length, pessoas: 0 };
    for (const k of Object.keys(SETORES)) rel.setores[k] = { nome: SETORES[k].nome, vendidas: 0, aguardando: 0, livres: 0, confirmado: 0, a_receber: 0, cadeiras_usadas: 0, cadeiras_total: e.config.estoque_cadeiras[k] };
    for (let n = 1; n <= 40; n++) {
      const s = setorDaMesa(n), r = this.reservaDaMesa(e, n, agora), rs = rel.setores[s];
      if (e.bloqueadas.includes(n)) continue;
      if (!r) { rs.livres++; rel.livres++; continue; }
      rs.cadeiras_usadas += r.extras;
      rel.pessoas += e.config.lugares_por_mesa + r.extras;
      if (r.status === "vendida") { rs.vendidas++; rel.vendidas++; rs.confirmado += r.valor; rel.confirmado += r.valor; }
      else { rs.aguardando++; rel.aguardando++; rs.a_receber += r.valor; rel.a_receber += r.valor; }
    }
    return { ...this.publico(e, agora), config: e.config, reservas, relatorio: rel, bloqueadas: e.bloqueadas };
  }

  async acao(e, req, agora) {
    let d;
    try { d = JSON.parse(req.corpo || "{}"); } catch { return erro("Pedido inválido."); }
    const acha = () => e.reservas.find((r) => r.codigo === d.codigo);
    const reg = (acao, extra) => e.historico.push(Object.assign({ t: agora, acao }, extra || {}));
    const r = d.codigo ? acha() : null;
    if (d.codigo && !r) return erro("Reserva não encontrada.", 404);

    switch (d.acao) {
      case "confirmar": {
        if (r.status === "cancelada") return erro("Reserva cancelada não pode ser confirmada.");
        const outra = this.reservaDaMesa(e, r.mesa, agora);
        if (outra && outra.codigo !== r.codigo) return erro(`A mesa ${r.mesa} já está com a reserva ${outra.codigo}.`, 409);
        const rest = e.config.estoque_cadeiras[r.setor] - this.cadeirasUsadas(e, r.setor, agora, r.codigo);
        if (r.extras > rest) return erro("Não há cadeiras adicionais suficientes no setor para confirmar esta reserva.", 409);
        r.status = "vendida"; break;
      }
      case "voltar_aguardando": r.status = "aguardando"; r.expira = agora + e.config.prazo_pagamento_horas * 3600000; break;
      case "prorrogar": r.expira = Math.max(r.expira, agora) + 24 * 3600000; if (r.status !== "vendida") r.status = "aguardando"; break;
      case "cancelar": r.status = "cancelada"; break;
      case "validar_associado": r.associado_validado = !!d.valor; break;
      case "mudar_tipo": {
        const tipo = d.valor === "associado" ? "associado" : "nao_associado";
        r.tipo = tipo; r.valor = this.valor(e, r.setor, tipo, r.extras); if (tipo !== "associado") r.associado_validado = false; break;
      }
      case "cadeiras": {
        const extras = Number(d.valor);
        if (!Number.isInteger(extras) || extras < 0 || extras > e.config.max_cadeiras_por_mesa) return erro("Quantidade inválida.");
        const rest = e.config.estoque_cadeiras[r.setor] - this.cadeirasUsadas(e, r.setor, agora, r.codigo);
        if (extras > rest) return erro(`Restam ${rest} cadeira(s) adicional(is) no setor.`, 409);
        r.extras = extras; r.valor = this.valor(e, r.setor, r.tipo, extras); break;
      }
      case "obs": r.obs = limpa(d.valor, 300); break;
      case "apagar": e.reservas = e.reservas.filter((x) => x.codigo !== d.codigo); reg("apagar", { codigo: d.codigo }); await this.salvar(e); return json({ ok: true });
      case "bloquear": {
        const n = Number(d.mesa);
        if (!setorDaMesa(n)) return erro("Mesa inválida.");
        if (this.reservaDaMesa(e, n, agora)) return erro("A mesa tem reserva ativa. Cancele antes de bloquear.", 409);
        if (!e.bloqueadas.includes(n)) e.bloqueadas.push(n);
        reg("bloquear", { mesa: n }); await this.salvar(e); return json({ ok: true });
      }
      case "desbloquear": e.bloqueadas = e.bloqueadas.filter((n) => n !== Number(d.mesa)); reg("desbloquear", { mesa: Number(d.mesa) }); await this.salvar(e); return json({ ok: true });
      case "config": {
        const c = d.valor || {};
        const num = (v, min, max) => { const x = Number(v); return Number.isFinite(x) && x >= min && x <= max ? Math.round(x * 100) / 100 : null; };
        for (const k of Object.keys(SETORES)) {
          if (c.precos && c.precos[k]) for (const t of Object.keys(TIPOS)) { const v = num(c.precos[k][t], 0, 100000); if (v !== null) e.config.precos[k][t] = v; }
          if (c.estoque_cadeiras && c.estoque_cadeiras[k] != null) { const v = num(c.estoque_cadeiras[k], 0, 500); if (v !== null) e.config.estoque_cadeiras[k] = Math.round(v); }
        }
        if (c.preco_cadeira != null) { const v = num(c.preco_cadeira, 0, 10000); if (v !== null) e.config.preco_cadeira = v; }
        if (c.prazo_pagamento_horas != null) { const v = num(c.prazo_pagamento_horas, 1, 720); if (v !== null) e.config.prazo_pagamento_horas = Math.round(v); }
        if (typeof c.vendas_abertas === "boolean") e.config.vendas_abertas = c.vendas_abertas;
        reg("config"); await this.salvar(e); return json({ ok: true, config: e.config });
      }
      default: return erro("Ação desconhecida.");
    }
    r.atualizado = agora;
    reg(d.acao, { codigo: r.codigo });
    await this.salvar(e);
    return json({ ok: true });
  }

  csv(e, agora) {
    const cab = ["codigo", "mesa", "setor", "tipo", "associado_validado", "matricula", "nome", "whatsapp", "email", "cadeiras_adicionais", "lugares", "valor", "pagamento", "status", "criado", "prazo_pagamento", "observacao"];
    const esc = (v) => { const s = String(v == null ? "" : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const linhas = e.reservas.slice().sort((a, b) => a.mesa - b.mesa).map((r) => [
      r.codigo, r.mesa, SETORES[r.setor].nome, TIPOS[r.tipo], r.associado_validado ? "sim" : "não", r.matricula, r.nome, r.whatsapp, r.email,
      r.extras, e.config.lugares_por_mesa + r.extras, String(r.valor).replace(".", ","), PAGAMENTOS[r.pagamento], this.statusEfetivo(r, agora),
      horaLocal(r.criado), horaLocal(r.expira), r.obs,
    ].map(esc).join(";"));
    return new Response("﻿" + [cab.join(";"), ...linhas].join("\r\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="reservas-mesas-reveillon-aabb.csv"', "cache-control": "no-store" },
    });
  }
}
