// ===== Reservas de mesas do Réveillon AABB 50 anos =====
// Um único Durable Object guarda o estado de todas as reservas. Ele atende um pedido
// de cada vez, então duas pessoas nunca conseguem reservar a mesma mesa ao mesmo tempo.
//
// Rotas públicas:   GET  /api/mesas            -> mapa, preços e estoque (sem dados pessoais)
//                   POST /api/mesas/reservar   -> cria uma reserva "aguardando pagamento"
// Rotas do admin:   GET  /api/admin/mesas      -> tudo, com dados dos compradores
//                   POST /api/admin/mesas      -> ações (confirmar, cancelar, preços, etc.)
//                   GET  /api/admin/mesas.csv  -> exportação
//                   POST /api/admin/login      -> entra e recebe um token de sessão (12h)
// O Secret ADMIN_SENHA é a senha do administrador principal (usuário em branco). Pelo painel,
// administradores cadastram outros usuários (operador ou administrador). As senhas desses usuários
// são guardadas só como hash PBKDF2, nunca em texto.

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

const PAPEIS = { admin: "Administrador", operador: "Operador" };
// ----- Barracas -----
const BARRACAS = [
  ...["01", "02", "03", "04", "06", "07", "08", "09", "11", "12", "13", "14", "15", "16"].map((n) => ({ id: "aabb-" + n, tipo: "aabb", nome: "Barraca " + n })),
  ...["01", "02", "03", "04", "05", "06"].map((n) => ({ id: "metal-" + n, tipo: "metal", nome: "Metal " + n })),
];
const BARRACA = Object.fromEntries(BARRACAS.map((b) => [b.id, b]));
// Barracas já vendidas antes do sistema (registradas uma vez, na primeira execução).
const BARRACAS_JA_VENDIDAS = ["aabb-01", "aabb-02", "aabb-03", "aabb-04", "aabb-06", "aabb-07", "aabb-08"];

const SO_ADMIN = new Set(["barraca_apagar", "barraca_bloquear", "barraca_desbloquear", "apagar", "bloquear", "desbloquear", "config", "usuario_criar", "usuario_senha", "usuario_papel", "usuario_ativo", "usuario_remover"]);
const SESSAO_MS = 12 * 3600000;

function hex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function aleatorio(n) { return hex(crypto.getRandomValues(new Uint8Array(n))); }
async function hashSenha(senha, salt) {
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000 }, chave, 256);
  return hex(bits);
}
const PROVISORIA_MS = 7 * 86400000; // senha provisória vale 7 dias
function senhaProvisoria() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint8Array(8));
  let c = ""; for (let i = 0; i < 8; i++) c += abc[r[i] % abc.length] + (i === 3 ? "-" : "");
  return c;
}
function cpfValido(c) {
  c = String(c || "").replace(/\D/g, "");
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(c[i]) * (t + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(c[t])) return false;
  }
  return true;
}
function cpfFmt(c) { c = String(c || ""); return c.length === 11 ? c.slice(0, 3) + "." + c.slice(3, 6) + "." + c.slice(6, 9) + "-" + c.slice(9) : c; }
function loginValido(l) { return /^[a-z0-9._-]{3,30}$/.test(l); }

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
    e.usuarios = e.usuarios || [];
    e.sessoes = e.sessoes || {};
    e.barracas = e.barracas || [];
    e.barracas_bloq = e.barracas_bloq || [];
    if (e.config.preco_barraca == null) e.config.preco_barraca = 800;
    if (e.config.passes_barraca == null) e.config.passes_barraca = 20;
    if (!e.barracas_semeadas) {
      const t = Date.now();
      for (const id of BARRACAS_JA_VENDIDAS) {
        e.barracas.push({ codigo: "B" + id.replace(/\D/g, "").padStart(2, "0") + "-ANT" + id.slice(0, 1).toUpperCase(), barraca: id, nome: "Venda registrada antes do sistema", whatsapp: "", email: "",
          pagamento: "secretaria", status: "vendida", valor: 800, criado: t, atualizado: t, expira: t, obs: "", origem: "painel", vendido_por: "Registro inicial" });
      }
      e.barracas_semeadas = true;
      this.precisaSalvar = true;
    }
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
      token: request.headers.get("x-admin-token") || "",
      senhaCerta: (this.env && this.env.ADMIN_SENHA) || "",
      corpo,
    });
  }

  async atender(req) {
    const agora = Date.now();
    const e = await this.estado();

    if (req.caminho === "/api/mesas" && req.metodo === "GET") return json(this.publico(e, agora));
    if (req.caminho === "/api/barracas" && req.metodo === "GET") { await this.salvarSeNovo(e); return json(this.barracasPublico(e, agora)); }
    if (req.caminho === "/api/barracas/reservar" && req.metodo === "POST") return this.reservarBarraca(e, req, agora);
    if (req.caminho === "/api/mesas/reservar" && req.metodo === "POST") return this.reservar(e, req, agora);

    if (req.caminho.startsWith("/api/admin/")) {
      if (!req.senhaCerta) return erro("Painel ainda não configurado: falta o Secret ADMIN_SENHA no Cloudflare.", 503);
      if (req.caminho === "/api/admin/login" && req.metodo === "POST") return this.login(e, req, agora);
      const eu = this.sessao(e, req.token, agora);
      if (!eu) return erro("Sessão expirada. Entre de novo.", 401);
      if (req.caminho === "/api/admin/sair" && req.metodo === "POST") { delete e.sessoes[req.token]; await this.salvar(e); return json({ ok: true }); }
      if (eu.trocar_senha) {
        if (req.caminho === "/api/admin/mesas" && req.metodo === "POST") {
          let d = {}; try { d = JSON.parse(req.corpo || "{}"); } catch {}
          if (d.acao === "minha_senha") return this.acao(e, req, agora, eu);
        }
        return json({ erro: "Crie sua senha para continuar.", trocar_senha: true, eu: { ...eu, papel_nome: PAPEIS[eu.papel] } }, 428);
      }
      if (req.caminho === "/api/admin/mesas" && req.metodo === "GET") return json(this.admin(e, agora, eu));
      if (req.caminho === "/api/admin/mesas.csv" && req.metodo === "GET") return this.csv(e, agora);
      if (req.caminho === "/api/admin/barracas.csv" && req.metodo === "GET") return this.csvBarracas(e, agora);
      if (req.caminho === "/api/admin/mesas" && req.metodo === "POST") return this.acao(e, req, agora, eu);
    }
    return erro("Não encontrado.", 404);
  }

  async login(e, req, agora) {
    if (this.limite(this.falhasLogin, req.ip, 10, 15 * 60000, agora)) return erro("Muitas tentativas. Aguarde 15 minutos.", 429);
    let d; try { d = JSON.parse(req.corpo || "{}"); } catch { return erro("Pedido inválido."); }
    const login = String(d.login || "").trim().toLowerCase();
    const senha = String(d.senha || "");
    let eu = null;
    if (!login) {
      if (senhaConfere(senha, req.senhaCerta)) eu = { login: "", nome: "Administrador principal", papel: "admin" };
    } else {
      const u = e.usuarios.find((x) => x.login === login && x.ativo);
      if (u && senhaConfere(await hashSenha(u.trocar_senha ? senha.trim().toUpperCase() : senha, u.salt), u.hash)) {
        if (u.trocar_senha && u.provisoria_expira && u.provisoria_expira <= agora) return erro("Sua senha provisória expirou. Peça uma nova ao administrador.", 401);
        eu = { login: u.login, nome: u.nome, papel: u.papel, trocar_senha: !!u.trocar_senha };
      }
    }
    if (!eu) { this.falhasLogin.get(req.ip).push(agora); return erro("Usuário ou senha incorretos.", 401); }
    for (const [t, s] of Object.entries(e.sessoes)) if (s.expira <= agora) delete e.sessoes[t];
    const token = aleatorio(32);
    e.sessoes[token] = { login: eu.login, expira: agora + SESSAO_MS };
    e.historico.push({ t: agora, acao: "entrou", quem: eu.nome });
    await this.salvar(e);
    return json({ ok: true, token, eu: { ...eu, papel_nome: PAPEIS[eu.papel] } });
  }

  sessao(e, token, agora) {
    const s = token && e.sessoes[token];
    if (!s || s.expira <= agora) return null;
    if (s.login === "") return { login: "", nome: "Administrador principal", papel: "admin" };
    const u = e.usuarios.find((x) => x.login === s.login && x.ativo);
    return u ? { login: u.login, nome: u.nome, papel: u.papel, trocar_senha: !!u.trocar_senha } : null;
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
    const cpf = String(d.cpf || "").replace(/\D/g, "");
    if (tipo === "associado" && !cpfValido(cpf)) return erro("Informe um CPF válido. A secretaria usa o nome e o CPF para confirmar a associação.");
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
      nome, whatsapp, email, cpf: tipo === "associado" ? cpf : "",
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

  admin(e, agora, eu) {
    const reservas = e.reservas.map((r) => Object.assign({}, r, {
      status_efetivo: this.statusEfetivo(r, agora),
      setor_nome: SETORES[r.setor].nome, tipo_nome: TIPOS[r.tipo], pagamento_nome: PAGAMENTOS[r.pagamento],
      criado_local: horaLocal(r.criado), expira_local: horaLocal(r.expira), cpf_fmt: cpfFmt(r.cpf),
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
    const historico = e.historico.slice(-200).reverse().map((h) => ({ ...h, quando: horaLocal(h.t) }));
    const usuarios = eu.papel === "admin" ? e.usuarios.map((u) => ({ login: u.login, nome: u.nome, papel: u.papel, papel_nome: PAPEIS[u.papel], ativo: u.ativo, criado: horaLocal(u.criado), pendente: !!u.trocar_senha, provisoria_expira: u.provisoria_expira ? horaLocal(u.provisoria_expira) : "" })) : [];
    const bar = this.barracasAdmin(e, agora);
    return { ...this.publico(e, agora), barracas: bar, config: e.config, reservas, relatorio: rel, bloqueadas: e.bloqueadas, eu: { ...eu, papel_nome: PAPEIS[eu.papel] }, historico, usuarios };
  }

  async acao(e, req, agora, eu) {
    let d;
    try { d = JSON.parse(req.corpo || "{}"); } catch { return erro("Pedido inválido."); }
    if (SO_ADMIN.has(d.acao) && eu.papel !== "admin") return erro("Só administradores podem fazer isso.", 403);
    const acha = () => e.reservas.find((r) => r.codigo === d.codigo);
    const reg = (acao, extra) => e.historico.push(Object.assign({ t: agora, acao, quem: eu.nome }, extra || {}));

    if (d.acao && d.acao.startsWith("usuario_") || d.acao === "minha_senha") return this.usuarios(e, d, agora, eu, reg);
    if (d.acao === "vender") return this.vender(e, d, agora, eu, reg);
    if (d.acao && d.acao.startsWith("barraca_")) return this.acaoBarraca(e, d, agora, eu, reg);
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
        if (c.preco_barraca != null) { const v = num(c.preco_barraca, 0, 100000); if (v !== null) e.config.preco_barraca = v; }
        if (c.preco_cadeira != null) { const v = num(c.preco_cadeira, 0, 10000); if (v !== null) e.config.preco_cadeira = v; }
        if (c.prazo_pagamento_horas != null) { const v = num(c.prazo_pagamento_horas, 1, 720); if (v !== null) e.config.prazo_pagamento_horas = Math.round(v); }
        if (typeof c.vendas_abertas === "boolean") e.config.vendas_abertas = c.vendas_abertas;
        reg("config"); await this.salvar(e); return json({ ok: true, config: e.config });
      }
      default: return erro("Ação desconhecida.");
    }
    r.atualizado = agora;
    r.ultimo = { acao: d.acao, quem: eu.nome, quando: horaLocal(agora) };
    reg(d.acao, { codigo: r.codigo, mesa: r.mesa });
    await this.salvar(e);
    return json({ ok: true });
  }

  // Venda feita por operador/administrador no painel (balcão, telefone, WhatsApp).
  async vender(e, d, agora, eu, reg) {
    const mesa = Number(d.mesa), setor = setorDaMesa(mesa);
    if (!Number.isInteger(mesa) || !setor) return erro("Escolha uma mesa válida.");
    const tipo = d.tipo === "associado" ? "associado" : d.tipo === "nao_associado" ? "nao_associado" : null;
    if (!tipo) return erro("Informe se o cliente é associado ou não.");
    const extras = Number(d.extras || 0);
    if (!Number.isInteger(extras) || extras < 0 || extras > e.config.max_cadeiras_por_mesa) return erro("Quantidade de cadeiras adicionais inválida.");
    const nome = limpa(d.nome, 80);
    if (nome.length < 5 || !/\s/.test(nome)) return erro("Informe o nome completo do cliente.");
    const whatsapp = String(d.whatsapp || "").replace(/\D/g, "");
    if (whatsapp && (whatsapp.length < 10 || whatsapp.length > 13)) return erro("WhatsApp inválido. Use DDD + número, ou deixe em branco.");
    const email = limpa(d.email, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return erro("E-mail inválido.");
    const cpf = String(d.cpf || "").replace(/\D/g, "");
    if (tipo === "associado" && !cpfValido(cpf)) return erro("Informe um CPF válido do associado.");
    const pagamento = PAGAMENTOS[d.pagamento] ? d.pagamento : null;
    if (!pagamento) return erro("Escolha a forma de pagamento.");
    if (d.consentimento !== true) return erro("Confirme que o cliente autorizou o uso dos dados para a reserva.");
    if (e.bloqueadas.includes(mesa)) return erro(`A mesa ${mesa} está bloqueada. Desbloqueie antes de vender.`, 409);
    const outra = this.reservaDaMesa(e, mesa, agora);
    if (outra) return erro(`A mesa ${mesa} acabou de ser reservada (${outra.codigo}). Escolha outra.`, 409);
    const restantes = e.config.estoque_cadeiras[setor] - this.cadeirasUsadas(e, setor, agora);
    if (extras > restantes) return erro(restantes > 0 ? `Restam apenas ${restantes} cadeira(s) adicional(is) neste setor.` : "As cadeiras adicionais deste setor esgotaram.", 409);
    const pago = d.pago === true;
    const r = {
      codigo: codigo(mesa), mesa, setor, tipo, extras,
      valor: this.valor(e, setor, tipo, extras),
      nome, whatsapp, email, cpf: tipo === "associado" ? cpf : "",
      associado_validado: tipo === "associado" && d.associado_conferido === true,
      pagamento, status: pago ? "vendida" : "aguardando",
      criado: agora, atualizado: agora,
      expira: agora + e.config.prazo_pagamento_horas * 3600000,
      obs: limpa(d.obs, 300),
      origem: "painel", vendido_por: eu.nome,
      ultimo: { acao: pago ? "vender_pago" : "vender", quem: eu.nome, quando: horaLocal(agora) },
    };
    e.reservas.push(r);
    reg(pago ? "vender_pago" : "vender", { codigo: r.codigo, mesa });
    await this.salvar(e);
    return json({ ok: true, codigo: r.codigo, mesa, valor: r.valor, status: r.status });
  }

  async usuarios(e, d, agora, eu, reg) {
    const login = String(d.login || "").trim().toLowerCase();
    const u = e.usuarios.find((x) => x.login === login);
    const encerrar = (l) => { for (const [t, s] of Object.entries(e.sessoes)) if (s.login === l) delete e.sessoes[t]; };
    const senhaOk = (x) => typeof x === "string" && x.length >= 8 && x.length <= 100;
    switch (d.acao) {
      case "usuario_criar": {
        if (!loginValido(login)) return erro("Usuário inválido: use de 3 a 30 letras minúsculas, números, ponto ou traço, sem espaços.");
        if (u) return erro("Já existe um usuário com esse nome.", 409);
        const nome = limpa(d.nome, 60);
        if (nome.length < 2) return erro("Informe o nome da pessoa.");
        const papel = d.papel === "admin" ? "admin" : "operador";
        const salt = aleatorio(16), prov = senhaProvisoria();
        e.usuarios.push({ login, nome, papel, salt, hash: await hashSenha(prov, salt), ativo: true, criado: agora, trocar_senha: true, provisoria_expira: agora + PROVISORIA_MS });
        reg("usuario_criar", { alvo: nome });
        await this.salvar(e);
        return json({ ok: true, login, nome, provisoria: prov, expira: horaLocal(agora + PROVISORIA_MS) });
      }
      case "usuario_senha": {
        if (!u) return erro("Usuário não encontrado.", 404);
        const prov = senhaProvisoria();
        u.salt = aleatorio(16); u.hash = await hashSenha(prov, u.salt); u.trocar_senha = true; u.provisoria_expira = agora + PROVISORIA_MS; encerrar(u.login);
        reg("usuario_senha", { alvo: u.nome });
        await this.salvar(e);
        return json({ ok: true, login: u.login, nome: u.nome, provisoria: prov, expira: horaLocal(u.provisoria_expira) });
      }
      case "usuario_papel": {
        if (!u) return erro("Usuário não encontrado.", 404);
        u.papel = d.valor === "admin" ? "admin" : "operador";
        reg("usuario_papel", { alvo: u.nome });
        break;
      }
      case "usuario_ativo": {
        if (!u) return erro("Usuário não encontrado.", 404);
        if (u.login === eu.login) return erro("Você não pode desativar o próprio acesso.");
        u.ativo = !!d.valor; if (!u.ativo) encerrar(u.login);
        reg(u.ativo ? "usuario_reativar" : "usuario_desativar", { alvo: u.nome });
        break;
      }
      case "usuario_remover": {
        if (!u) return erro("Usuário não encontrado.", 404);
        if (u.login === eu.login) return erro("Você não pode remover o próprio acesso.");
        e.usuarios = e.usuarios.filter((x) => x.login !== login); encerrar(login);
        reg("usuario_remover", { alvo: u.nome });
        break;
      }
      case "minha_senha": {
        if (eu.login === "") return erro("A senha do administrador principal é trocada no Cloudflare (Secret ADMIN_SENHA).");
        const me = e.usuarios.find((x) => x.login === eu.login);
        const atual = me && me.trocar_senha ? String(d.atual || "").trim().toUpperCase() : String(d.atual || "");
        if (!me || !senhaConfere(await hashSenha(atual, me.salt), me.hash)) return erro("Senha atual incorreta.", 403);
        if (!senhaOk(d.senha)) return erro("A nova senha precisa ter pelo menos 8 caracteres.");
        if (String(d.senha) === atual || String(d.senha).toUpperCase() === atual) return erro("A nova senha precisa ser diferente da atual.");
        const primeira = !!me.trocar_senha;
        me.salt = aleatorio(16); me.hash = await hashSenha(d.senha, me.salt); me.trocar_senha = false; delete me.provisoria_expira;
        reg(primeira ? "primeiro_acesso" : "minha_senha");
        break;
      }
      default: return erro("Ação desconhecida.");
    }
    await this.salvar(e);
    return json({ ok: true });
  }

  // ===== Barracas =====
  async salvarSeNovo(e) { if (this.precisaSalvar) { this.precisaSalvar = false; await this.salvar(e); } }
  barracaDe(e, id, agora) { return e.barracas.find((r) => r.barraca === id && this.ativa(r, agora)); }
  barracasPublico(e, agora) {
    return {
      atualizado: new Date(agora).toISOString(),
      preco: e.config.preco_barraca, passes: e.config.passes_barraca,
      prazo_pagamento_horas: e.config.prazo_pagamento_horas, vendas_abertas: e.config.vendas_abertas,
      barracas: BARRACAS.map((b) => {
        const r = this.barracaDe(e, b.id, agora);
        return { ...b, status: e.barracas_bloq.includes(b.id) ? "indisponivel" : r ? (r.status === "vendida" ? "vendida" : "aguardando") : "disponivel" };
      }),
    };
  }
  barracasAdmin(e, agora) {
    const pub = this.barracasPublico(e, agora);
    const reservas = e.barracas.map((r) => Object.assign({}, r, {
      status_efetivo: this.statusEfetivo(r, agora), nome_barraca: (BARRACA[r.barraca] || {}).nome || r.barraca,
      pagamento_nome: PAGAMENTOS[r.pagamento], criado_local: horaLocal(r.criado), expira_local: horaLocal(r.expira),
    })).sort((a, b) => b.criado - a.criado);
    const rel = { vendidas: 0, aguardando: 0, livres: 0, indisponiveis: 0, confirmado: 0, a_receber: 0 };
    for (const b of pub.barracas) {
      if (b.status === "indisponivel") { rel.indisponiveis++; continue; }
      const r = this.barracaDe(e, b.id, agora);
      if (!r) rel.livres++;
      else if (r.status === "vendida") { rel.vendidas++; rel.confirmado += r.valor; }
      else { rel.aguardando++; rel.a_receber += r.valor; }
    }
    return { ...pub, reservas, relatorio: rel };
  }
  validaCliente(d, exigeWhats) {
    const nome = limpa(d.nome, 80);
    if (nome.length < 5 || !/\s/.test(nome)) return { erro: "Informe o nome completo." };
    const whatsapp = String(d.whatsapp || "").replace(/\D/g, "");
    if ((exigeWhats || whatsapp) && (whatsapp.length < 10 || whatsapp.length > 13)) return { erro: "Informe um WhatsApp válido, com DDD." };
    const email = limpa(d.email, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { erro: "E-mail inválido." };
    const pagamento = PAGAMENTOS[d.pagamento] ? d.pagamento : null;
    if (!pagamento) return { erro: "Escolha a forma de pagamento." };
    return { nome, whatsapp, email, pagamento };
  }
  novaBarraca(e, id, c, agora, extra) {
    const r = Object.assign({
      codigo: "B" + id.replace(/\D/g, "").padStart(2, "0") + (id.startsWith("metal") ? "M" : "") + "-" + codigo(0).slice(4),
      barraca: id, nome: c.nome, whatsapp: c.whatsapp, email: c.email, pagamento: c.pagamento,
      status: "aguardando", valor: e.config.preco_barraca, criado: agora, atualizado: agora,
      expira: agora + e.config.prazo_pagamento_horas * 3600000, obs: "", origem: "site",
    }, extra || {});
    e.barracas.push(r);
    return r;
  }
  async reservarBarraca(e, req, agora) {
    let d; try { d = JSON.parse(req.corpo || "{}"); } catch { return erro("Pedido inválido."); }
    if (d.site) return erro("Pedido inválido.");
    if (!e.config.vendas_abertas) return erro("As reservas estão encerradas no momento.");
    if (this.limite(this.tentativasReserva, req.ip, 5, 3600000, agora)) return erro("Muitas reservas seguidas deste aparelho. Fale com a secretaria.", 429);
    const id = String(d.barraca || "");
    if (!BARRACA[id]) return erro("Barraca inválida.");
    const c = this.validaCliente(d, true); if (c.erro) return erro(c.erro);
    if (d.consentimento !== true) return erro("É preciso concordar com o uso dos dados para a reserva.");
    if (e.barracas_bloq.includes(id)) return erro("Esta barraca não está disponível.", 409);
    if (this.barracaDe(e, id, agora)) return erro("Esta barraca acabou de ser reservada por outra pessoa. Escolha outra.", 409);
    const r = this.novaBarraca(e, id, c, agora);
    e.historico.push({ t: agora, acao: "reserva_barraca", codigo: r.codigo, alvo: BARRACA[id].nome });
    await this.salvar(e);
    this.tentativasReserva.get(req.ip).push(agora);
    return json({ ok: true, codigo: r.codigo, barraca: BARRACA[id].nome, valor: r.valor, passes: e.config.passes_barraca, pagamento: PAGAMENTOS[r.pagamento], expira: new Date(r.expira).toISOString() });
  }
  async acaoBarraca(e, d, agora, eu, reg) {
    const nomeB = (id) => (BARRACA[id] || {}).nome || id;
    if (d.acao === "barraca_vender") {
      const id = String(d.barraca || "");
      if (!BARRACA[id]) return erro("Escolha uma barraca válida.");
      const c = this.validaCliente(d, false); if (c.erro) return erro(c.erro);
      if (d.consentimento !== true) return erro("Confirme que o cliente autorizou o uso dos dados para a reserva.");
      if (e.barracas_bloq.includes(id)) return erro(`A ${nomeB(id)} está bloqueada.`, 409);
      const outra = this.barracaDe(e, id, agora);
      if (outra) return erro(`A ${nomeB(id)} acabou de ser reservada (${outra.codigo}).`, 409);
      const pago = d.pago === true;
      const r = this.novaBarraca(e, id, c, agora, { status: pago ? "vendida" : "aguardando", origem: "painel", vendido_por: eu.nome, obs: limpa(d.obs, 300),
        ultimo: { acao: pago ? "vender_pago" : "vender", quem: eu.nome, quando: horaLocal(agora) } });
      reg(pago ? "barraca_vender_pago" : "barraca_vender", { codigo: r.codigo, alvo: nomeB(id) });
      await this.salvar(e);
      return json({ ok: true, codigo: r.codigo, barraca: nomeB(id), valor: r.valor, status: r.status });
    }
    if (d.acao === "barraca_bloquear" || d.acao === "barraca_desbloquear") {
      const id = String(d.barraca || "");
      if (!BARRACA[id]) return erro("Barraca inválida.");
      if (d.acao === "barraca_bloquear") {
        if (this.barracaDe(e, id, agora)) return erro("A barraca tem reserva ativa. Cancele antes de bloquear.", 409);
        if (!e.barracas_bloq.includes(id)) e.barracas_bloq.push(id);
      } else e.barracas_bloq = e.barracas_bloq.filter((x) => x !== id);
      reg(d.acao, { alvo: nomeB(id) }); await this.salvar(e); return json({ ok: true });
    }
    const r = e.barracas.find((x) => x.codigo === d.codigo);
    if (!r) return erro("Reserva não encontrada.", 404);
    switch (d.acao) {
      case "barraca_confirmar": {
        if (r.status === "cancelada") return erro("Reserva cancelada não pode ser confirmada.");
        const outra = this.barracaDe(e, r.barraca, agora);
        if (outra && outra.codigo !== r.codigo) return erro(`A ${nomeB(r.barraca)} já está com a reserva ${outra.codigo}.`, 409);
        r.status = "vendida"; break;
      }
      case "barraca_voltar": r.status = "aguardando"; r.expira = agora + e.config.prazo_pagamento_horas * 3600000; break;
      case "barraca_prorrogar": r.expira = Math.max(r.expira, agora) + 24 * 3600000; if (r.status !== "vendida") r.status = "aguardando"; break;
      case "barraca_cancelar": r.status = "cancelada"; break;
      case "barraca_obs": r.obs = limpa(d.valor, 300); break;
      case "barraca_apagar": e.barracas = e.barracas.filter((x) => x.codigo !== d.codigo); reg("barraca_apagar", { codigo: d.codigo }); await this.salvar(e); return json({ ok: true });
      default: return erro("Ação desconhecida.");
    }
    r.atualizado = agora;
    r.ultimo = { acao: d.acao, quem: eu.nome, quando: horaLocal(agora) };
    reg(d.acao, { codigo: r.codigo, alvo: nomeB(r.barraca) });
    await this.salvar(e);
    return json({ ok: true });
  }
  csvBarracas(e, agora) {
    const cab = ["codigo", "barraca", "nome", "whatsapp", "email", "valor", "pagamento", "status", "criado", "prazo_pagamento", "observacao", "origem", "ultima_acao_por"];
    const esc = (v) => { const s = String(v == null ? "" : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const linhas = e.barracas.slice().sort((a, b) => a.barraca.localeCompare(b.barraca)).map((r) => [
      r.codigo, (BARRACA[r.barraca] || {}).nome || r.barraca, r.nome, r.whatsapp, r.email, String(r.valor).replace(".", ","), PAGAMENTOS[r.pagamento],
      this.statusEfetivo(r, agora), horaLocal(r.criado), horaLocal(r.expira), r.obs, r.origem === "painel" ? "Painel (" + r.vendido_por + ")" : "Site",
      r.ultimo ? r.ultimo.quem + " (" + r.ultimo.quando + ")" : "",
    ].map(esc).join(";"));
    return new Response("\ufeff" + [cab.join(";"), ...linhas].join("\r\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="reservas-barracas-reveillon-aabb.csv"', "cache-control": "no-store" },
    });
  }

  csv(e, agora) {
    const cab = ["codigo", "mesa", "setor", "tipo", "associado_validado", "cpf", "nome", "whatsapp", "email", "cadeiras_adicionais", "lugares", "valor", "pagamento", "status", "criado", "prazo_pagamento", "observacao", "origem", "ultima_acao_por"];
    const esc = (v) => { const s = String(v == null ? "" : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const linhas = e.reservas.slice().sort((a, b) => a.mesa - b.mesa).map((r) => [
      r.codigo, r.mesa, SETORES[r.setor].nome, TIPOS[r.tipo], r.associado_validado ? "sim" : "não", cpfFmt(r.cpf), r.nome, r.whatsapp, r.email,
      r.extras, e.config.lugares_por_mesa + r.extras, String(r.valor).replace(".", ","), PAGAMENTOS[r.pagamento], this.statusEfetivo(r, agora),
      horaLocal(r.criado), horaLocal(r.expira), r.obs, r.origem === "painel" ? "Painel (" + r.vendido_por + ")" : "Site", r.ultimo ? r.ultimo.quem + " (" + r.ultimo.quando + ")" : "",
    ].map(esc).join(";"));
    return new Response("﻿" + [cab.join(";"), ...linhas].join("\r\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="reservas-mesas-reveillon-aabb.csv"', "cache-control": "no-store" },
    });
  }
}
