// Reservas de mesas do salão: Réveillon AABB 50 anos.
//
// Tudo passa por um único Durable Object ("Mesas"), que atende um pedido de cada vez.
// É isso que impede duas pessoas de reservarem a mesma mesa ao mesmo tempo e mantém
// o estoque de cadeiras adicionais correto. Os dados ficam no banco SQLite do próprio objeto.
//
// Rotas públicas:
//   GET  /api/mesas                 mapa: preços, status de cada mesa e cadeiras restantes
//   POST /api/reservas              cria uma reserva
//   GET  /api/reservas/<codigo>     acompanha uma reserva (e mostra o Pix quando liberado)
// Rotas do painel (exigem login com a senha do Secret ADMIN_SENHA):
//   POST /api/admin/login | /api/admin/sair
//   GET  /api/admin/estado | /api/admin/exportar.csv
//   POST /api/admin/acao | /api/admin/venda | /api/admin/config

import { DurableObject } from "cloudflare:workers";

// ---------- Mesas e setores ----------
export const SETORES = {
  gold:   { nome: "Gold",   de: 1,  ate: 15, cadeiras: "Cadeiras Tiffany douradas", local: "Mais próximo do palco" },
  marrom: { nome: "Marrom", de: 16, ate: 30, cadeiras: "Cadeiras Tiffany marrons",  local: "Área intermediária" },
  royal:  { nome: "Royal",  de: 31, ate: 40, cadeiras: "Cadeiras Royal douradas",   local: "Área posterior do salão" },
};
const TOTAL_MESAS = 40;
const LUGARES = 6;
export function setorDa(mesa) {
  for (const [id, s] of Object.entries(SETORES)) if (mesa >= s.de && mesa <= s.ate) return id;
  return null;
}

// Valores iniciais. Tudo pode ser alterado depois no painel.
const CONFIG_PADRAO = {
  vendas_abertas: false,
  precos: {
    gold:   { associado: 500, nao_associado: 800 },
    marrom: { associado: 460, nao_associado: 700 },
    royal:  { associado: 420, nao_associado: 600 },
  },
  preco_cadeira: 50,
  max_cadeiras_mesa: 2,
  estoque_cadeiras: { gold: 30, marrom: 30, royal: 10 },
  prazo_pagamento_horas: 24,   // tempo para pagar depois que a reserva está liberada para pagamento
  prazo_validacao_horas: 48,   // tempo para a secretaria validar um associado
  limite_por_cpf: 4,           // reservas ativas por CPF
  mesas_bloqueadas: [],        // mesas fora da venda (ex.: reservadas para a organização)
  pix: { chave: "aabbdiretoria@gmail.com", nome: "AABB BALSAS", cidade: "BALSAS" },
  whatsapp: "5599988276988",
};

const ATIVAS = ["validacao", "pagamento", "pago"];
const HORA = 3600 * 1000;

// ---------- Utilidades ----------
function json(dados, status = 200, extra = {}) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}
const erro = (mensagem, status = 400, campo) => json({ erro: mensagem, campo }, status);
const limpa = (v, max = 120) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const soDigitos = (v) => String(v || "").replace(/\D/g, "");
const dinheiro = (n) => Math.round(Number(n) * 100) / 100;

export function cpfValido(cpf) {
  const c = soDigitos(cpf);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(c[i]) * (t + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(c[t])) return false;
  }
  return true;
}

function codigoNovo() {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O, 1/I
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join("");
}

// ---------- Pix "copia e cola" (BR Code estático, padrão do Banco Central) ----------
function semAcento(t) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 .@_+\-]/g, "").toUpperCase();
}
function emv(id, valor) { return id + String(valor.length).padStart(2, "0") + valor; }
function crc16(texto) {
  let crc = 0xffff;
  for (let i = 0; i < texto.length; i++) {
    crc ^= texto.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
export function pixCopiaECola({ chave, nome, cidade, valor, txid }) {
  const conta = emv("00", "br.gov.bcb.pix") + emv("01", String(chave).trim());
  let p = emv("00", "01") + emv("26", conta) + emv("52", "0000") + emv("53", "986");
  if (valor > 0) p += emv("54", valor.toFixed(2));
  p += emv("58", "BR") + emv("59", semAcento(nome).slice(0, 25) || "AABB") + emv("60", semAcento(cidade).slice(0, 15) || "BALSAS");
  p += emv("62", emv("05", (txid || "***").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***"));
  p += "6304";
  return p + crc16(p);
}

// ---------- Login do painel ----------
async function hmac(segredo, texto) {
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode("aabb-mesas:" + segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const assinatura = await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(texto));
  return btoa(String.fromCharCode(...new Uint8Array(assinatura))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function iguais(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function lerCookie(request, nome) {
  const m = (request.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + nome + "=([^;]+)"));
  return m ? m[1] : "";
}
async function sessaoValida(request, env) {
  if (!env.ADMIN_SENHA) return false;
  const v = lerCookie(request, "aabb_adm");
  const [exp, sig] = v.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return iguais(sig, await hmac(env.ADMIN_SENHA, exp));
}

// ---------- Roteamento (chamado pelo worker principal) ----------
export async function rotaMesas(request, env) {
  const url = new URL(request.url);
  const p = url.pathname;
  if (!p.startsWith("/api/mesas") && !p.startsWith("/api/reservas") && !p.startsWith("/api/admin")) return null;
  if (!env.MESAS) return erro("Sistema de mesas não configurado.", 503);

  // Pedidos que alteram dados precisam vir do próprio site.
  if (request.method === "POST") {
    const origem = request.headers.get("origin");
    if (origem && new URL(origem).host !== url.host) return erro("Origem não permitida.", 403);
  }

  if (p.startsWith("/api/admin/") && p !== "/api/admin/login") {
    if (!env.ADMIN_SENHA) return erro("Painel desativado: falta o Secret ADMIN_SENHA no Cloudflare.", 503);
    if (!(await sessaoValida(request, env))) return erro("Faça login novamente.", 401);
    if (request.method === "POST" && request.headers.get("x-aabb") !== "1") return erro("Pedido inválido.", 400);
  }

  const id = env.MESAS.idFromName("reveillon-2027");
  const obj = env.MESAS.get(id);
  return obj.fetch(request);
}

// ---------- O objeto que guarda as mesas ----------
export class Mesas extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.tentativas = new Map(); // limite de pedidos por IP (em memória)
    ctx.blockConcurrencyWhile(async () => this.criarTabelas());
  }

  criarTabelas() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reservas (
      codigo TEXT PRIMARY KEY,
      mesa INTEGER NOT NULL,
      setor TEXT NOT NULL,
      tipo TEXT NOT NULL,              -- associado | nao_associado
      matricula TEXT,
      validado INTEGER NOT NULL DEFAULT 0,
      nome TEXT NOT NULL,
      cpf TEXT NOT NULL,
      telefone TEXT NOT NULL,
      email TEXT,
      cadeiras INTEGER NOT NULL DEFAULT 0,
      valor_mesa REAL NOT NULL,
      valor_cadeiras REAL NOT NULL,
      total REAL NOT NULL,
      forma TEXT NOT NULL,             -- pix | secretaria
      status TEXT NOT NULL,            -- validacao | pagamento | pago | cancelada | expirada
      origem TEXT NOT NULL DEFAULT 'site',
      criado_em INTEGER NOT NULL,
      atualizado_em INTEGER NOT NULL,
      expira_em INTEGER,
      pago_em INTEGER,
      obs TEXT,
      historico TEXT NOT NULL DEFAULT '[]'
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS reservas_mesa ON reservas (mesa, status)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS reservas_cpf ON reservas (cpf, status)`);
  }

  config() {
    const linha = this.sql.exec(`SELECT valor FROM config WHERE chave = 'geral'`).toArray()[0];
    const salva = linha ? JSON.parse(linha.valor) : {};
    const c = structuredClone(CONFIG_PADRAO);
    for (const [k, v] of Object.entries(salva)) {
      if (v && typeof v === "object" && !Array.isArray(v) && c[k] && typeof c[k] === "object" && !Array.isArray(c[k])) c[k] = { ...c[k], ...v };
      else c[k] = v;
    }
    return c;
  }
  salvarConfig(c) {
    this.sql.exec(`INSERT INTO config (chave, valor) VALUES ('geral', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`, JSON.stringify(c));
  }

  // Reservas não pagas no prazo voltam a ficar disponíveis.
  expirar() {
    const agora = Date.now();
    const vencidas = this.sql.exec(`SELECT codigo, historico FROM reservas WHERE status IN ('validacao','pagamento') AND expira_em IS NOT NULL AND expira_em < ?`, agora).toArray();
    for (const r of vencidas) {
      const h = JSON.parse(r.historico);
      h.push({ em: agora, por: "sistema", acao: "Prazo vencido: mesa liberada" });
      this.sql.exec(`UPDATE reservas SET status = 'expirada', atualizado_em = ?, historico = ? WHERE codigo = ?`, agora, JSON.stringify(h), r.codigo);
    }
  }

  ativas() { return this.sql.exec(`SELECT * FROM reservas WHERE status IN ('validacao','pagamento','pago')`).toArray(); }

  cadeirasUsadas(ativas, setor, exceto) {
    return ativas.filter((r) => r.setor === setor && r.codigo !== exceto).reduce((t, r) => t + r.cadeiras, 0);
  }

  mapa(c, ativas) {
    const porMesa = new Map(ativas.map((r) => [r.mesa, r]));
    const mesas = [];
    for (let n = 1; n <= TOTAL_MESAS; n++) {
      const r = porMesa.get(n);
      let status = "disponivel";
      if (c.mesas_bloqueadas.includes(n)) status = "indisponivel";
      else if (r && r.status === "pago") status = "vendida";
      else if (r) status = "aguardando";
      mesas.push({ n, setor: setorDa(n), status });
    }
    const cadeiras = {};
    for (const s of Object.keys(SETORES)) {
      cadeiras[s] = { estoque: c.estoque_cadeiras[s], restantes: Math.max(0, c.estoque_cadeiras[s] - this.cadeirasUsadas(ativas, s)) };
    }
    return { mesas, cadeiras };
  }

  limitar(ip, max, janelaMs) {
    const agora = Date.now();
    const lista = (this.tentativas.get(ip) || []).filter((t) => agora - t < janelaMs);
    if (lista.length >= max) return false;
    lista.push(agora);
    this.tentativas.set(ip, lista);
    return true;
  }

  pixDa(c, r) {
    if (r.status !== "pagamento" || r.forma !== "pix" || !c.pix.chave) return null;
    return {
      copia_e_cola: pixCopiaECola({ ...c.pix, valor: r.total, txid: "MESA" + r.codigo }),
      chave: c.pix.chave,
      valor: r.total,
    };
  }

  publico(c, r) {
    return {
      codigo: r.codigo,
      mesa: r.mesa,
      setor: r.setor,
      tipo: r.tipo,
      primeiro_nome: r.nome.split(/\s+/)[0],
      cadeiras: r.cadeiras,
      lugares: LUGARES + r.cadeiras,
      valor_mesa: r.valor_mesa,
      valor_cadeiras: r.valor_cadeiras,
      total: r.total,
      forma: r.forma,
      status: r.status,
      expira_em: ["validacao", "pagamento"].includes(r.status) ? r.expira_em : null,
      pix: this.pixDa(c, r),
      whatsapp: c.whatsapp,
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    const ip = request.headers.get("cf-connecting-ip") || "local";
    this.expirar();
    try {
      if (p === "/api/mesas" && request.method === "GET") return this.getMapa();
      if (p === "/api/reservas" && request.method === "POST") return this.criarReserva(request, ip);
      const m = p.match(/^\/api\/reservas\/([A-Z0-9]{6,12})$/);
      if (m && request.method === "GET") return this.getReserva(m[1]);
      if (p === "/api/admin/login" && request.method === "POST") return this.login(request, ip);
      if (p === "/api/admin/sair" && request.method === "POST") return json({ ok: true }, 200, { "set-cookie": "aabb_adm=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
      if (p === "/api/admin/estado" && request.method === "GET") return this.estado();
      if (p === "/api/admin/exportar.csv" && request.method === "GET") return this.exportar();
      if (p === "/api/admin/acao" && request.method === "POST") return this.acao(await request.json());
      if (p === "/api/admin/venda" && request.method === "POST") return this.vendaManual(await request.json());
      if (p === "/api/admin/config" && request.method === "POST") return this.alterarConfig(await request.json());
      return erro("Não encontrado.", 404);
    } catch (e) {
      return erro("Erro inesperado: " + (e && e.message ? e.message : e), 500);
    }
  }

  getMapa() {
    const c = this.config();
    const { mesas, cadeiras } = this.mapa(c, this.ativas());
    return json({
      vendas_abertas: c.vendas_abertas,
      setores: SETORES,
      precos: c.precos,
      preco_cadeira: c.preco_cadeira,
      max_cadeiras_mesa: c.max_cadeiras_mesa,
      lugares: LUGARES,
      prazo_pagamento_horas: c.prazo_pagamento_horas,
      mesas,
      cadeiras,
      whatsapp: c.whatsapp,
    });
  }

  getReserva(codigo) {
    const r = this.sql.exec(`SELECT * FROM reservas WHERE codigo = ?`, codigo).toArray()[0];
    if (!r) return erro("Reserva não encontrada. Confira o código.", 404);
    return json(this.publico(this.config(), r));
  }

  async criarReserva(request, ip) {
    if (!this.limitar(ip, 30, HORA)) return erro("Muitas tentativas. Aguarde um pouco ou fale com a secretaria.", 429);
    const c = this.config();
    if (!c.vendas_abertas) return erro("As reservas de mesas ainda não estão abertas.", 409);
    let d;
    try { d = await request.json(); } catch { return erro("Pedido inválido."); }

    const mesa = Number(d.mesa);
    const setor = setorDa(mesa);
    if (!Number.isInteger(mesa) || !setor) return erro("Mesa inválida.", 400, "mesa");
    const tipo = d.tipo === "associado" ? "associado" : d.tipo === "nao_associado" ? "nao_associado" : null;
    if (!tipo) return erro("Informe se você é associado ou não associado.", 400, "tipo");
    const matricula = limpa(d.matricula, 30);
    if (tipo === "associado" && matricula.length < 2) return erro("Informe o número da sua carteirinha ou matrícula de associado.", 400, "matricula");
    const nome = limpa(d.nome, 100);
    if (nome.split(/\s+/).filter(Boolean).length < 2) return erro("Informe seu nome completo.", 400, "nome");
    const cpf = soDigitos(d.cpf);
    if (!cpfValido(cpf)) return erro("CPF inválido.", 400, "cpf");
    const telefone = soDigitos(d.telefone);
    if (telefone.length < 10 || telefone.length > 13) return erro("Informe um telefone com DDD.", 400, "telefone");
    const email = limpa(d.email, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return erro("E-mail inválido.", 400, "email");
    const cadeiras = Number(d.cadeiras || 0);
    if (!Number.isInteger(cadeiras) || cadeiras < 0 || cadeiras > c.max_cadeiras_mesa) return erro(`Escolha de 0 a ${c.max_cadeiras_mesa} cadeiras adicionais.`, 400, "cadeiras");
    const forma = d.forma === "secretaria" ? "secretaria" : "pix";
    if (d.aceite !== true) return erro("É preciso aceitar as condições da reserva e o aviso de privacidade.", 400, "aceite");

    // Verificações de disponibilidade (o objeto atende um pedido por vez: não há corrida).
    if (c.mesas_bloqueadas.includes(mesa)) return erro("Esta mesa não está disponível para venda.", 409, "mesa");
    const ativas = this.ativas();
    if (ativas.some((r) => r.mesa === mesa)) return erro("Esta mesa acabou de ser reservada por outra pessoa. Escolha outra mesa.", 409, "mesa");
    const restantes = c.estoque_cadeiras[setor] - this.cadeirasUsadas(ativas, setor);
    if (cadeiras > restantes) return erro(restantes > 0 ? `Restam só ${restantes} cadeira(s) adicional(is) no setor ${SETORES[setor].nome}.` : `As cadeiras adicionais do setor ${SETORES[setor].nome} esgotaram.`, 409, "cadeiras");
    if (ativas.filter((r) => r.cpf === cpf).length >= c.limite_por_cpf) return erro(`Limite de ${c.limite_por_cpf} reservas ativas por CPF. Fale com a secretaria.`, 409, "cpf");

    const valor_mesa = dinheiro(c.precos[setor][tipo]);
    const valor_cadeiras = dinheiro(cadeiras * c.preco_cadeira);
    const total = dinheiro(valor_mesa + valor_cadeiras);
    const agora = Date.now();
    const status = tipo === "associado" ? "validacao" : "pagamento";
    const expira = agora + (status === "validacao" ? c.prazo_validacao_horas : c.prazo_pagamento_horas) * HORA;
    let codigo;
    do { codigo = codigoNovo(); } while (this.sql.exec(`SELECT 1 FROM reservas WHERE codigo = ?`, codigo).toArray().length);
    const historico = [{ em: agora, por: "comprador", acao: status === "validacao" ? "Reserva feita: aguardando validação de associado" : "Reserva feita: aguardando pagamento" }];

    this.sql.exec(
      `INSERT INTO reservas (codigo, mesa, setor, tipo, matricula, nome, cpf, telefone, email, cadeiras, valor_mesa, valor_cadeiras, total, forma, status, origem, criado_em, atualizado_em, expira_em, historico)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'site', ?, ?, ?, ?)`,
      codigo, mesa, setor, tipo, tipo === "associado" ? matricula : null, nome, cpf, telefone, email || null, cadeiras,
      valor_mesa, valor_cadeiras, total, forma, status, agora, agora, expira, JSON.stringify(historico)
    );
    const r = this.sql.exec(`SELECT * FROM reservas WHERE codigo = ?`, codigo).toArray()[0];
    return json(this.publico(c, r), 201);
  }

  // ---------- Painel ----------
  async login(request, ip) {
    if (!this.env.ADMIN_SENHA) return erro("Painel desativado: falta o Secret ADMIN_SENHA no Cloudflare.", 503);
    if (!this.limitar("login:" + ip, 6, 15 * 60 * 1000)) return erro("Muitas tentativas. Tente de novo em 15 minutos.", 429);
    let d = {};
    try { d = await request.json(); } catch {}
    const senha = String(d.senha || "");
    const a = await hmac(this.env.ADMIN_SENHA, "cmp:" + senha);
    const b = await hmac(this.env.ADMIN_SENHA, "cmp:" + this.env.ADMIN_SENHA);
    if (!iguais(a, b)) return erro("Senha incorreta.", 401);
    const exp = String(Date.now() + 12 * HORA);
    const cookie = `aabb_adm=${exp}.${await hmac(this.env.ADMIN_SENHA, exp)}; Path=/; Max-Age=${12 * 3600}; HttpOnly; Secure; SameSite=Strict`;
    return json({ ok: true }, 200, { "set-cookie": cookie });
  }

  resumo(c, ativas) {
    const todas = this.sql.exec(`SELECT * FROM reservas`).toArray();
    const setores = {};
    for (const [s, info] of Object.entries(SETORES)) {
      const do_setor = ativas.filter((r) => r.setor === s);
      const pagas = do_setor.filter((r) => r.status === "pago");
      const total = info.ate - info.de + 1;
      const bloqueadas = c.mesas_bloqueadas.filter((n) => setorDa(n) === s).length;
      setores[s] = {
        mesas: total,
        vendidas: pagas.length,
        aguardando: do_setor.length - pagas.length,
        bloqueadas,
        livres: total - do_setor.length - bloqueadas,
        cadeiras_vendidas: pagas.reduce((t, r) => t + r.cadeiras, 0),
        cadeiras_reservadas: do_setor.reduce((t, r) => t + r.cadeiras, 0),
        cadeiras_estoque: c.estoque_cadeiras[s],
        arrecadado: dinheiro(pagas.reduce((t, r) => t + r.total, 0)),
        pendente: dinheiro(do_setor.filter((r) => r.status !== "pago").reduce((t, r) => t + r.total, 0)),
      };
    }
    const pagas = ativas.filter((r) => r.status === "pago");
    return {
      setores,
      arrecadado: dinheiro(pagas.reduce((t, r) => t + r.total, 0)),
      pendente: dinheiro(ativas.filter((r) => r.status !== "pago").reduce((t, r) => t + r.total, 0)),
      pessoas_confirmadas: pagas.reduce((t, r) => t + LUGARES + r.cadeiras, 0),
      pessoas_reservadas: ativas.reduce((t, r) => t + LUGARES + r.cadeiras, 0),
      capacidade_inicial: TOTAL_MESAS * LUGARES,
      capacidade_maxima: TOTAL_MESAS * LUGARES + Object.values(c.estoque_cadeiras).reduce((t, n) => t + n, 0),
      canceladas: todas.filter((r) => r.status === "cancelada").length,
      expiradas: todas.filter((r) => r.status === "expirada").length,
    };
  }

  estado() {
    const c = this.config();
    const ativas = this.ativas();
    const reservas = this.sql.exec(`SELECT * FROM reservas ORDER BY criado_em DESC`).toArray().map((r) => ({ ...r, historico: JSON.parse(r.historico) }));
    return json({ config: c, setores: SETORES, ...this.mapa(c, ativas), resumo: this.resumo(c, ativas), reservas, agora: Date.now() });
  }

  registrar(r, acao, campos = {}) {
    const agora = Date.now();
    const h = JSON.parse(r.historico);
    h.push({ em: agora, por: "painel", acao });
    const sets = Object.keys(campos).map((k) => `${k} = ?`);
    this.sql.exec(`UPDATE reservas SET ${[...sets, "atualizado_em = ?", "historico = ?"].join(", ")} WHERE codigo = ?`, ...Object.values(campos), agora, JSON.stringify(h), r.codigo);
  }

  acao(d) {
    const c = this.config();
    const r = this.sql.exec(`SELECT * FROM reservas WHERE codigo = ?`, String(d.codigo || "")).toArray()[0];
    if (!r) return erro("Reserva não encontrada.", 404);
    const agora = Date.now();
    const ativa = ATIVAS.includes(r.status);
    const prazoPag = agora + c.prazo_pagamento_horas * HORA;

    switch (d.acao) {
      case "validar":
        if (r.status !== "validacao") return erro("Esta reserva não está aguardando validação.");
        this.registrar(r, "Associado validado: liberada para pagamento", { validado: 1, status: "pagamento", expira_em: prazoPag });
        break;
      case "como_nao_associado": {
        if (!["validacao", "pagamento"].includes(r.status)) return erro("Só dá para mudar reservas ainda não pagas.");
        const vm = dinheiro(c.precos[r.setor].nao_associado);
        this.registrar(r, `Não validado como associado: valor ajustado para não associado (R$ ${vm.toFixed(2)} + cadeiras)`, {
          tipo: "nao_associado", validado: 0, valor_mesa: vm, total: dinheiro(vm + r.valor_cadeiras), status: "pagamento", expira_em: prazoPag,
        });
        break;
      }
      case "confirmar":
        if (!["validacao", "pagamento"].includes(r.status)) return erro("Esta reserva não está aguardando pagamento.");
        this.registrar(r, "Pagamento confirmado: mesa vendida" + (d.forma_pagamento ? ` (${limpa(d.forma_pagamento, 40)})` : ""), {
          status: "pago", pago_em: agora, expira_em: null, validado: r.tipo === "associado" ? 1 : r.validado,
        });
        break;
      case "cancelar":
        if (!ativa) return erro("Esta reserva já não está ativa.");
        this.registrar(r, "Reserva cancelada" + (d.motivo ? `: ${limpa(d.motivo, 200)}` : ""), { status: "cancelada", expira_em: null });
        break;
      case "estender": {
        if (!["validacao", "pagamento"].includes(r.status)) return erro("Só dá para estender reservas ainda não pagas.");
        const horas = Math.min(Math.max(Number(d.horas) || 24, 1), 240);
        this.registrar(r, `Prazo estendido em ${horas} h`, { expira_em: Math.max(r.expira_em || agora, agora) + horas * HORA });
        break;
      }
      case "cadeiras": {
        if (!ativa) return erro("Só dá para alterar cadeiras de reservas ativas.");
        const n = Number(d.cadeiras);
        if (!Number.isInteger(n) || n < 0 || n > c.max_cadeiras_mesa) return erro(`Escolha de 0 a ${c.max_cadeiras_mesa} cadeiras.`);
        const restantes = c.estoque_cadeiras[r.setor] - this.cadeirasUsadas(this.ativas(), r.setor, r.codigo);
        if (n > restantes) return erro(`Restam só ${restantes} cadeira(s) no setor ${SETORES[r.setor].nome}.`);
        const vc = dinheiro(n * c.preco_cadeira);
        this.registrar(r, `Cadeiras adicionais: ${r.cadeiras} → ${n} (total R$ ${(r.valor_mesa + vc).toFixed(2)})`, { cadeiras: n, valor_cadeiras: vc, total: dinheiro(r.valor_mesa + vc) });
        break;
      }
      case "reativar": {
        if (ativa) return erro("Esta reserva já está ativa.");
        if (this.ativas().some((x) => x.mesa === r.mesa) || c.mesas_bloqueadas.includes(r.mesa)) return erro("A mesa já está com outra reserva ou bloqueada.");
        const restantes = c.estoque_cadeiras[r.setor] - this.cadeirasUsadas(this.ativas(), r.setor);
        if (r.cadeiras > restantes) return erro("Não há cadeiras adicionais suficientes no setor para reativar.");
        this.registrar(r, "Reserva reativada: aguardando pagamento", { status: "pagamento", expira_em: prazoPag });
        break;
      }
      case "obs":
        this.registrar(r, "Observação atualizada", { obs: limpa(d.obs, 500) || null });
        break;
      default:
        return erro("Ação desconhecida.");
    }
    return this.estado();
  }

  vendaManual(d) {
    const c = this.config();
    const mesa = Number(d.mesa);
    const setor = setorDa(mesa);
    if (!setor) return erro("Mesa inválida.");
    if (this.ativas().some((r) => r.mesa === mesa)) return erro("Esta mesa já tem uma reserva ativa.");
    const tipo = d.tipo === "associado" ? "associado" : "nao_associado";
    const nome = limpa(d.nome, 100);
    if (nome.length < 3) return erro("Informe o nome do comprador.");
    const cpf = soDigitos(d.cpf);
    if (cpf && !cpfValido(cpf)) return erro("CPF inválido.");
    const cadeiras = Number(d.cadeiras || 0);
    if (!Number.isInteger(cadeiras) || cadeiras < 0 || cadeiras > c.max_cadeiras_mesa) return erro("Quantidade de cadeiras inválida.");
    const restantes = c.estoque_cadeiras[setor] - this.cadeirasUsadas(this.ativas(), setor);
    if (cadeiras > restantes) return erro(`Restam só ${restantes} cadeira(s) no setor.`);
    const pago = d.pago === true;
    const valor_mesa = dinheiro(c.precos[setor][tipo]);
    const valor_cadeiras = dinheiro(cadeiras * c.preco_cadeira);
    const agora = Date.now();
    let codigo;
    do { codigo = codigoNovo(); } while (this.sql.exec(`SELECT 1 FROM reservas WHERE codigo = ?`, codigo).toArray().length);
    const h = [{ em: agora, por: "painel", acao: pago ? "Venda registrada na secretaria (paga)" : "Reserva registrada na secretaria: aguardando pagamento" }];
    this.sql.exec(
      `INSERT INTO reservas (codigo, mesa, setor, tipo, matricula, validado, nome, cpf, telefone, email, cadeiras, valor_mesa, valor_cadeiras, total, forma, status, origem, criado_em, atualizado_em, expira_em, pago_em, obs, historico)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'secretaria', ?, 'painel', ?, ?, ?, ?, ?, ?)`,
      codigo, mesa, setor, tipo, limpa(d.matricula, 30) || null, tipo === "associado" ? 1 : 0, nome, cpf, soDigitos(d.telefone), limpa(d.email, 120) || null,
      cadeiras, valor_mesa, valor_cadeiras, dinheiro(valor_mesa + valor_cadeiras), pago ? "pago" : "pagamento", agora, agora,
      pago ? null : agora + c.prazo_pagamento_horas * HORA, pago ? agora : null, limpa(d.obs, 500) || null, JSON.stringify(h)
    );
    return this.estado();
  }

  alterarConfig(d) {
    const c = this.config();
    const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
    if (typeof d.vendas_abertas === "boolean") c.vendas_abertas = d.vendas_abertas;
    if (d.precos) for (const s of Object.keys(SETORES)) for (const t of ["associado", "nao_associado"]) {
      const v = d.precos[s] && num(d.precos[s][t], 0, 100000);
      if (v !== null && v !== undefined) c.precos[s][t] = dinheiro(v);
    }
    if (d.preco_cadeira !== undefined) { const v = num(d.preco_cadeira, 0, 10000); if (v !== null) c.preco_cadeira = dinheiro(v); }
    if (d.estoque_cadeiras) for (const s of Object.keys(SETORES)) {
      const v = num(d.estoque_cadeiras[s], 0, 200);
      if (v !== null && Number.isInteger(v)) {
        const usadas = this.cadeirasUsadas(this.ativas(), s);
        if (v < usadas) return erro(`O setor ${SETORES[s].nome} já tem ${usadas} cadeiras reservadas: o estoque não pode ser menor que isso.`);
        c.estoque_cadeiras[s] = v;
      }
    }
    for (const k of ["prazo_pagamento_horas", "prazo_validacao_horas"]) if (d[k] !== undefined) { const v = num(d[k], 1, 240); if (v !== null) c[k] = v; }
    if (d.limite_por_cpf !== undefined) { const v = num(d.limite_por_cpf, 1, 40); if (v !== null) c.limite_por_cpf = Math.round(v); }
    if (Array.isArray(d.mesas_bloqueadas)) {
      const lista = [...new Set(d.mesas_bloqueadas.map(Number).filter((n) => Number.isInteger(n) && setorDa(n)))].sort((a, b) => a - b);
      const ocupadas = this.ativas().map((r) => r.mesa);
      const conflito = lista.find((n) => ocupadas.includes(n) && !c.mesas_bloqueadas.includes(n));
      if (conflito) return erro(`A mesa ${String(conflito).padStart(2, "0")} tem reserva ativa e não pode ser bloqueada.`);
      c.mesas_bloqueadas = lista;
    }
    if (d.pix) {
      if (d.pix.chave !== undefined) c.pix.chave = limpa(d.pix.chave, 77);
      if (d.pix.nome !== undefined) c.pix.nome = limpa(d.pix.nome, 25);
      if (d.pix.cidade !== undefined) c.pix.cidade = limpa(d.pix.cidade, 15);
    }
    if (d.whatsapp !== undefined) c.whatsapp = soDigitos(d.whatsapp).slice(0, 13);
    this.salvarConfig(c);
    return this.estado();
  }

  exportar() {
    const linhas = this.sql.exec(`SELECT * FROM reservas ORDER BY mesa, criado_em`).toArray();
    const STATUS = { validacao: "Aguardando validação", pagamento: "Aguardando pagamento", pago: "Vendida (paga)", cancelada: "Cancelada", expirada: "Expirada" };
    const data = (ms) => (ms ? new Date(ms - 3 * HORA).toISOString().slice(0, 16).replace("T", " ") : "");
    const cab = ["Código", "Mesa", "Setor", "Situação", "Tipo", "Matrícula", "Validado", "Nome", "CPF", "Telefone", "E-mail", "Cadeiras adicionais", "Lugares", "Valor mesa", "Valor cadeiras", "Total", "Forma", "Origem", "Criada em", "Paga em", "Prazo", "Observação"];
    const esc = (v) => { const t = String(v == null ? "" : v); return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const br = (n) => Number(n).toFixed(2).replace(".", ",");
    const corpo = linhas.map((r) => [
      r.codigo, String(r.mesa).padStart(2, "0"), SETORES[r.setor].nome, STATUS[r.status] || r.status, r.tipo === "associado" ? "Associado" : "Não associado",
      r.matricula || "", r.validado ? "Sim" : "Não", r.nome, r.cpf, r.telefone, r.email || "", r.cadeiras, LUGARES + r.cadeiras,
      br(r.valor_mesa), br(r.valor_cadeiras), br(r.total), r.forma === "pix" ? "Pix" : "Secretaria", r.origem === "painel" ? "Secretaria" : "Site",
      data(r.criado_em), data(r.pago_em), ["validacao", "pagamento"].includes(r.status) ? data(r.expira_em) : "", r.obs || "",
    ].map(esc).join(";"));
    const csv = "﻿" + [cab.join(";"), ...corpo].join("\r\n");
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="reservas-mesas-reveillon-${new Date(Date.now() - 3 * HORA).toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      },
    });
  }
}
