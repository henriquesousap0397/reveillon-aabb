/* Funções compartilhadas por /mesas/ e /mesas/reserva/. */
(function () {
  var M = (window.MesasComum = {});

  M.reais = function (n) {
    return "R$ " + Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  M.reaisCurto = function (n) {
    return "R$ " + Number(n || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  };
  M.dois = function (n) { return String(n).padStart(2, "0"); };
  M.esc = function (t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  M.NOMES = { gold: "Gold", marrom: "Marrom", royal: "Royal" };
  M.CORES = { gold: "var(--s-gold)", marrom: "var(--s-marrom)", royal: "var(--s-royal)" };
  M.STATUS = {
    validacao: "Aguardando validação de associado",
    pagamento: "Aguardando pagamento",
    pago: "Confirmada: pagamento validado",
    cancelada: "Cancelada",
    expirada: "Expirada: prazo de pagamento vencido",
  };

  // Data e hora em Balsas (UTC-3), ex.: "13/11 às 18:40"
  M.quando = function (ms) {
    var d = new Date(ms - 3 * 3600 * 1000);
    return M.dois(d.getUTCDate()) + "/" + M.dois(d.getUTCMonth() + 1) + " às " + M.dois(d.getUTCHours()) + ":" + M.dois(d.getUTCMinutes());
  };

  // Reservas feitas neste aparelho (só os códigos), para o comprador acompanhar.
  M.guardarCodigo = function (codigo, mesa) {
    try {
      var l = JSON.parse(localStorage.getItem("aabb-mesas") || "[]").filter(function (x) { return x.c !== codigo; });
      l.unshift({ c: codigo, m: mesa, t: Date.now() });
      localStorage.setItem("aabb-mesas", JSON.stringify(l.slice(0, 6)));
    } catch (e) {}
  };
  M.codigosGuardados = function () {
    try { return JSON.parse(localStorage.getItem("aabb-mesas") || "[]"); } catch (e) { return []; }
  };

  M.whatsapp = function (numero, texto) {
    return "https://wa.me/" + numero + "?text=" + encodeURIComponent(texto);
  };

  // QR Code: biblioteca pública carregada só quando for preciso. Se não carregar, fica o "copia e cola".
  var qrPromessa = null;
  function carregarQR() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (qrPromessa) return qrPromessa;
    qrPromessa = new Promise(function (ok, falha) {
      var s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
      s.async = true;
      s.onload = function () { window.qrcode ? ok(window.qrcode) : falha(); };
      s.onerror = falha;
      document.head.appendChild(s);
      setTimeout(falha, 8000);
    });
    return qrPromessa;
  }

  // Monta a caixa do Pix dentro de "alvo".
  M.mostrarPix = function (alvo, pix, codigo) {
    alvo.innerHTML =
      '<div class="pix-box">' +
        '<p class="eyebrow">Pague com Pix</p>' +
        '<div class="valor">' + M.reais(pix.valor) + "</div>" +
        '<div class="qr" hidden aria-label="QR Code do Pix"></div>' +
        '<label class="campo" style="width:100%">Pix copia e cola' +
          '<textarea readonly rows="3">' + M.esc(pix.copia_e_cola) + "</textarea></label>" +
        '<button type="button" class="btn solid small copiar">Copiar código Pix</button>' +
        '<p class="nota">No app do seu banco, escolha <b>Pix › Copia e cola</b> (ou leia o QR Code) e confira se o recebedor é a AABB Balsas. ' +
        "O valor já vem preenchido. Identificador: MESA" + M.esc(codigo) + ".</p>" +
      "</div>";
    var ta = alvo.querySelector("textarea"), bt = alvo.querySelector(".copiar");
    bt.addEventListener("click", function () {
      function feito() { bt.textContent = "Código copiado!"; setTimeout(function () { bt.textContent = "Copiar código Pix"; }, 2500); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pix.copia_e_cola).then(feito, function () { ta.select(); document.execCommand("copy"); feito(); });
      else { ta.select(); document.execCommand("copy"); feito(); }
    });
    ta.addEventListener("focus", function () { ta.select(); });
    carregarQR().then(function (qrcode) {
      var q = qrcode(0, "M");
      q.addData(pix.copia_e_cola);
      q.make();
      var caixa = alvo.querySelector(".qr");
      caixa.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      caixa.hidden = false;
    }).catch(function () { /* sem QR: o copia e cola continua funcionando */ });
  };
})();
