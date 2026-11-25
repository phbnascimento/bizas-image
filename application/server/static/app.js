// Cliente do chat: gera/guarda a chave, assina cada mensagem e mantém a cópia local da cadeia a partir do que o server
// transmite. Protocolo: docs/protocol.md
import {
  BLOCK_SIZE, DEFAULT_WORK_BITS, DataType, MAX_DATA_LENGTH, MAX_WORK_BITS, decodeBlock, equalBytes, fingerprint, fromHex,
  hasWork, hex, leadingZeroBits, mineBlock, nextBlock, textOf, uploadString, verifyBlock,
} from "./bizas.js";
import { MAX_POLL_OPTIONS, MIN_POLL_OPTIONS, Tally, parseVote, pollData, uploadPoll, uploadVote } from "./poll.js";
import { formatWhen } from "./when.js";
import { applyStatic, initLang, onLangChange, setLang, t } from "./i18n.js";
import { FIELDS, composeBlock, convertText, formatField, stampToDate } from "./fraud.js";
import { qrSvg } from "./qr.js";
import { initTheme, setTheme } from "./theme.js";

const nacl = globalThis.nacl;
const $ = (id) => document.getElementById(id);
const ui = {
  log: $("log"), empty: $("empty"), room: $("room"), me: $("me"), height: $("height"), fingerprint: $("fingerprint"),
  status: $("status"), form: $("form"), text: $("text"), count: $("count"), send: $("send"),
  panel: $("panel"), pKey: $("p-key"), pName: $("p-name"), pNote: $("p-note"), pFirst: $("p-first"), pCount: $("p-count"),
  pClose: $("p-close"), msgError: $("msg-error"), fraud: $("fraud"), fraudFields: $("fraud-fields"), fraudResign: $("fraud-resign"), fraudSync: $("fraud-sync"), fraudStampDate: $("fraud-stampdate"), fraudRoomHex: $("fraud-roomhex"), fraudReset: $("fraud-reset"), fraudResult: $("fraud-result"),
  fraudToggle: $("fraud-toggle"), pHue: $("p-hue"), pQr: $("p-qr"), pReset: $("p-reset"),
  work: $("work"), workBox: $("work-box"), workBits: $("work-bits"), mining: $("mining"),
  plus: $("plus"), plusMenu: $("plus-menu"), pollPanel: $("poll-panel"), pollForm: $("poll-form"),
  pollQuestion: $("poll-question"), pollOptions: $("poll-options"), pollAdd: $("poll-add"),
  pollExclusive: $("poll-exclusive"), pollGenesis: $("poll-genesis"), pollErr: $("poll-err"), pollCount: $("poll-count"),
  pollCreate: $("poll-create"), blockPanel: $("block-panel"), bTitle: $("b-title"), bFields: $("b-fields"),
};
ui.workBits.max = String(MAX_WORK_BITS);
ui.workBits.value = String(DEFAULT_WORK_BITS);
const ZERO_SIG = new Uint8Array(64);
const MAX_RETRIES = 3;

// --- configurações ---------------------------------------------------------
// A engrenagem (tela da chave e cabeçalho) abre o painel de configurações: língua (bandeiras) e tema. O texto fixo do
// HTML se traduz por data-i18n
initLang();
initTheme();
// A largura da logo da barra acompanha a altura dela (--nav-h)
const navBar = document.querySelector("header");
new ResizeObserver(() => {
  const h = navBar.getBoundingClientRect().height;
  if (h > 0) navBar.style.setProperty("--nav-h", `${h}px`);
}).observe(navBar);
const settings = $("settings");
const closeSettings = () => { settings.hidden = true; };
document.addEventListener("click", (ev) => {
  const el = ev.target.closest?.("[data-lang], [data-theme-set], .gear");
  if (!el) return;
  if (el.dataset.lang) setLang(el.dataset.lang);
  else if (el.dataset.themeSet) setTheme(el.dataset.themeSet);
  else {
    $("panel").hidden = true; // um painel por vez
    $("poll-panel").hidden = true;
    $("block-panel").hidden = true;
    settings.hidden = false;
  }
});
$("st-close").addEventListener("click", closeSettings);
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeSettings(); });

// --- identidade ------------------------------------------------------------
// A seed (32 bytes, 64 hex) fica no localStorage: limpar os dados do site apaga a identidade (ver docs/protocol.md).
// Na primeira sessão, a pessoa gera uma seed nova ou cola uma existente, vê a chave pública e confirma; só então a seed
// é gravada e a página conecta
const SEED_HEX = /^[0-9a-f]{64}$/i;

function storedSeed() {
  try {
    const s = localStorage.getItem("bizas.seed");
    if (s && SEED_HEX.test(s)) return fromHex(s);
  } catch { /* sem localStorage: a chave vale só nesta aba */ }
  return null;
}

// Mostra a tela de escolha da chave e devolve a seed confirmada
function chooseSeed() {
  const key = $("s-key"), pub = $("s-pub"), err = $("s-err"), use = $("s-use");
  document.body.classList.add("setup");
  document.body.classList.remove("loading");
  let seed = null;
  // O QR da chave privada só aparece quando a pessoa pede, e volta a ficar oculto ao mudar a chave
  let qrShown = false;
  const paintQr = () => {
    const box = $("s-qr"), btn = $("s-qrbtn");
    box.hidden = !qrShown;
    btn.setAttribute("aria-expanded", String(qrShown));
    btn.dataset.i18n = qrShown ? "setup.qrHide" : "setup.qrShow";
    btn.textContent = t(btn.dataset.i18n);
    if (qrShown && seed) box.replaceChildren(qrSvg(hex(seed), t("setup.qr")));
    else box.replaceChildren();
  };
  const check = (edited = true) => {
    const v = key.value.trim();
    seed = null;
    if (edited === true) qrShown = false;
    pub.textContent = "—";
    use.disabled = true;
    $("s-qrbox").hidden = true;
    err.textContent = v && !SEED_HEX.test(v) ? t("setup.invalid") : "";
    if (!SEED_HEX.test(v)) return;
    seed = fromHex(v);
    pub.textContent = hex(nacl.sign.keyPair.fromSeed(seed).publicKey);
    use.disabled = false;
    $("s-qrbox").hidden = false;
    paintQr();
  };
  $("s-qrbtn").addEventListener("click", () => { qrShown = !qrShown; paintQr(); });
  key.addEventListener("input", () => check(true));
  onLangChange(() => check(false));
  $("s-dice").addEventListener("click", () => {
    key.value = hex(nacl.randomBytes(32));
    check();
  });
  return new Promise((resolve) => {
    $("s-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (!seed) return;
      try { localStorage.setItem("bizas.seed", hex(seed)); } catch { /* idem */ }
      key.value = "";
      document.body.classList.remove("setup");
      resolve(seed);
    });
    key.focus();
  });
}

const seed = storedSeed() ?? await chooseSeed();
document.body.classList.remove("loading");
const keyPair = nacl.sign.keyPair.fromSeed(seed);
const shortId = (pub) => hex(pub.subarray(0, 4));

// --- agenda de nomes -------------------------------------------------------
// Nomes que este aparelho dá às chaves públicas, guardados no localStorage (só aqui; não vão para a cadeia nem para o
// server). Limpar os dados do site apaga a agenda, como apaga a chave
let names = {};
try { names = JSON.parse(localStorage.getItem("bizas.names") ?? "{}") || {}; } catch { names = {}; }
function saveName(keyHex, name) {
  if (name) names[keyHex] = name; else delete names[keyHex];
  try { localStorage.setItem("bizas.names", JSON.stringify(names)); } catch { /* sem localStorage: vale só nesta aba */ }
}
// Notas que este aparelho guarda sobre cada chave (texto livre, só no localStorage, nunca enviado)
let notes = {};
try { notes = JSON.parse(localStorage.getItem("bizas.notes") ?? "{}") || {}; } catch { notes = {}; }
function saveNote(keyHex, text) {
  if (text.trim()) notes[keyHex] = text; else delete notes[keyHex];
  try { localStorage.setItem("bizas.notes", JSON.stringify(notes)); } catch { /* sem localStorage: vale só nesta aba */ }
}
// Matiz (0 a 359) escolhido por este aparelho para uma chave; sem escolha, vale o derivado do 1º byte da chave. Também
// só no localStorage
let hues = {};
try { hues = JSON.parse(localStorage.getItem("bizas.hues") ?? "{}") || {}; } catch { hues = {}; }
function saveHue(keyHex, hue) {
  if (hue === null) delete hues[keyHex]; else hues[keyHex] = hue;
  try { localStorage.setItem("bizas.hues", JSON.stringify(hues)); } catch { /* idem */ }
}
const defaultHue = (keyHex) => (parseInt(keyHex.slice(0, 2), 16) * 360) / 256;
const hueOf = (keyHex) => (Number.isFinite(hues[keyHex]) ? hues[keyHex] : defaultHue(keyHex));
const colorOf = (keyHex) => `hsl(${hueOf(keyHex)} 55% var(--who-l))`;
const labelOf = (pub) => names[hex(pub)] || shortId(pub);

// Por autor (chave em hex): índice e carimbo do primeiro bloco e quantidade de blocos
const authors = new Map();

function paintWho(el, pub) {
  el.textContent = labelOf(pub);
  el.title = hex(pub);
  el.dataset.author = hex(pub);
  el.style.color = colorOf(el.dataset.author);
}
paintWho(ui.me, keyPair.publicKey);

// --- cadeia local ----------------------------------------------------------
let head = null;   // último bloco aceito
let height = 0;
let blocks = [];   // blocos aceitos, pelo índice: o painel "ver" mostra os campos deles
let pending = null; // { text, sig, tries, fraud?, mining? }: sig é null enquanto a prova de trabalho roda
// N da cadeia (o info do gênese): quantos bits zero cada assinatura precisa ter. null com a cadeia vazia
let workBits = null;
// Enquetes da cadeia local e os votos ativos (poll.js), e o cartão de cada enquete na tela, pelo índice do bloco
let tally = new Tally();
const pollCards = new Map();
// Blocos que seguem o que está pendente: trocar de opção numa enquete exclusiva é retirar o voto e votar de novo
let queue = [];

// Diferença, em ns, entre o relógio do validator e o deste aparelho. Quem fornece a hora é a placa: o carimbo assinado
// é o relógio do validator, não o do celular. Recalculada a cada conexão (aviso "time")
let clockOffset = 0n;
const nowNs = () => BigInt(Date.now()) * 1_000_000n + clockOffset;

// Exibição da hora (when.js): runStart e realOffset vêm do aviso "time" do server
let runStart = null;   // BigInt, ns
let realOffset = null; // BigInt, ns, ou null sem set-date nesta execução do validator

const whenText = (stamp) => formatWhen(stamp, { now: nowNs(), runStart, realOffset });

function refreshTimes() {
  for (const el of document.querySelectorAll(".msg .when")) el.textContent = whenText(BigInt(el.dataset.stamp));
}
setInterval(refreshTimes, 15_000);
onLangChange(() => { refreshTimes(); fillPanel(); });

// --- painel da chave -------------------------------------------------------
let openKey = null; // chave em hex do painel aberto, ou null
let qrFor = null;   // chave do QR já desenhado no painel

function fillPanel() {
  if (!openKey) return;
  ui.pKey.textContent = openKey;
  if (qrFor !== openKey) {
    ui.pQr.replaceChildren(qrSvg(openKey, t("panel.title")));
    qrFor = openKey;
  }
  ui.pKey.style.color = colorOf(openKey);
  ui.pHue.value = String(Math.round(hueOf(openKey)));
  ui.pReset.hidden = !Number.isFinite(hues[openKey]);
  const info = authors.get(openKey);
  ui.pFirst.textContent = info
    ? t("panel.firstValue", { index: info.first, when: whenText(info.stamp), stamp: info.stamp })
    : t("panel.none");
  ui.pCount.textContent = info ? String(info.count) : "0";
  if (document.activeElement !== ui.pName) ui.pName.value = names[openKey] ?? "";
  if (document.activeElement !== ui.pNote) ui.pNote.value = notes[openKey] ?? "";
}

function openPanel(keyHex) {
  closeSettings(); // um painel por vez
  ui.pollPanel.hidden = true;
  closeBlockPanel();
  openKey = keyHex;
  ui.panel.hidden = false;
  ui.pName.value = names[keyHex] ?? "";
  ui.pNote.value = notes[keyHex] ?? "";
  fillPanel();
}
function closePanel() {
  openKey = null;
  ui.panel.hidden = true;
}
function repaintNames() {
  for (const el of document.querySelectorAll("[data-author]")) paintWho(el, fromHex(el.dataset.author));
  fillPanel();
}
// Slider de matiz: o valor (0 a 359) é o matiz
ui.pHue.addEventListener("input", () => {
  if (!openKey) return;
  saveHue(openKey, Number(ui.pHue.value));
  repaintNames();
});
ui.pReset.addEventListener("click", () => {
  if (!openKey) return;
  saveHue(openKey, null);
  repaintNames();
});
ui.pName.addEventListener("input", () => {
  if (!openKey) return;
  saveName(openKey, ui.pName.value.trim());
  repaintNames();
});
ui.pNote.addEventListener("input", () => {
  if (openKey) saveNote(openKey, ui.pNote.value);
});
ui.pClose.addEventListener("click", closePanel);
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closePanel(); });
document.addEventListener("click", (ev) => {
  const who = ev.target.closest?.("[data-author]");
  if (who) openPanel(who.dataset.author);
});

function roomName(room) {
  const end = room.indexOf(0);
  return new TextDecoder().decode(room.subarray(0, end < 0 ? room.length : end));
}

function render(block, index, pollErr) {
  ui.empty.hidden = true;
  const el = document.createElement("div");
  el.className = "msg";
  el.dataset.index = String(index);
  if (equalBytes(block.author, keyPair.publicKey)) el.classList.add("mine");

  const meta = document.createElement("div");
  meta.className = "meta";
  const who = document.createElement("span");
  who.className = "who";
  paintWho(who, block.author);
  const when = document.createElement("span");
  when.className = "when";
  when.dataset.stamp = String(block.stamp);
  when.textContent = whenText(block.stamp);
  // "ver" abre o painel com os campos do bloco
  const view = document.createElement("button");
  view.type = "button";
  view.className = "view";
  view.dataset.view = String(index);
  view.dataset.i18n = "msg.view";
  view.textContent = t("msg.view");
  meta.append(who, when, view);

  let body = document.createElement("div");
  body.className = "text";
  const text = textOf(block);
  const isPollType = block.type === DataType.POLL || block.type === DataType.VOTE;
  // textContent, nunca innerHTML: o conteúdo vem de qualquer aparelho
  if (text != null) {
    body.textContent = text;
  } else if (isPollType && pollErr) {
    // O validator aceitou, mas este navegador discorda: o bloco fica na tela e fora da contagem, sem derrubar a conexão
    const vars = { type: block.type === DataType.POLL ? "POLL" : "VOTE", code: pollErr };
    body.dataset.i18n = "msg.ignored";
    body.dataset.i18nVars = JSON.stringify(vars);
    body.textContent = t("msg.ignored", vars);
  } else if (block.type === DataType.POLL) {
    body = pollCard(index);
    el.classList.add("poll-msg");
  } else if (block.type === DataType.VOTE) {
    body = voteLine(block);
    el.classList.add("vote-msg");
  } else {
    body.dataset.i18n = "msg.opaque";
    body.dataset.i18nVars = JSON.stringify({ type: block.type, length: block.length });
    body.textContent = t("msg.opaque", { type: block.type, length: block.length });
  }

  el.append(meta, body);
  const atBottom = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 40;
  ui.log.append(el);
  if (atBottom) ui.log.scrollTop = ui.log.scrollHeight;
}

// Aplica um bloco vindo do server. Devolve false se não encaixa na cópia local
function apply(block) {
  if (head && equalBytes(block.sig, head.sig)) return true; // repetido
  const fits = head ? equalBytes(block.prev, head.sig) : equalBytes(block.prev, ZERO_SIG);
  if (!fits) return false;
  if (!verifyBlock(block)) {
    // O validator já conferiu; conferimos de novo para não confiar no server
    setMsgError("status.badsig");
    return false;
  }
  // A prova de trabalho também é conferida aqui: o gênese define N (até MAX_WORK_BITS) e todo bloco o cumpre
  const isGenesis = !head;
  if ((isGenesis && block.info > MAX_WORK_BITS) || !hasWork(block, isGenesis ? block.info : workBits)) {
    setMsgError("status.badwork");
    return false;
  }
  if (isGenesis) {
    workBits = block.info;
    ui.work.textContent = String(workBits);
  }
  // Enquetes: as regras dependem da cadeia até aqui. Um bloco que este navegador recusa não derruba a conexão (o
  // validator já o aceitou): fica na tela como ignorado e fora da contagem
  const index = height;
  const pollErr = tally.check(index, block);
  if (pollErr === null) tally.apply(index, block);
  head = block;
  blocks.push(block);
  const key = hex(block.author);
  const info = authors.get(key);
  if (info) info.count++;
  else authors.set(key, { first: height, stamp: block.stamp, count: 1 });
  height++;
  ui.height.textContent = String(height);
  // Impressão digital da cadeia nesta altura: quem compara com outra pessoa confere altura e impressão digital
  ui.fingerprint.textContent = fingerprint(block);
  ui.fingerprint.title = hex(block.sig);
  ui.fingerprint.classList.add("partial");
  ui.room.textContent = roomName(block.room);
  render(block, index, pollErr);
  const vote = pollErr === null ? parseVote(block) : null;
  if (vote) paintPoll(vote.poll);
  fillPanel();
  if (pending?.sig && equalBytes(block.sig, pending.sig)) {
    const kind = pending.spec?.kind ?? "text";
    if (pending.fraud) {
      setFraudResult("fraud.accepted", "ok");
      for (const k of Object.keys(overrides)) delete overrides[k];
      draftNonce = newNonce();
      // Com o stamp congelado, o próximo rascunho congela de novo no instante atual
      if (frozenNs !== null) frozenNs = nowNs();
    }
    pending = null;
    if (kind === "text") ui.text.value = "";
    if (kind === "poll") resetPollForm(true);
    // O bloco seguinte da fila (o voto depois da retirada) sai depois que o histórico inteiro foi aplicado
    if (queue.length) setTimeout(sendQueued, 0);
    updateCount();
  }
  refreshFraud();
  updateCount(); // o campo de N do gênese some quando a cadeia deixa de estar vazia
  return true;
}

function resetChain() {
  head = null;
  height = 0;
  blocks = [];
  closeBlockPanel(); // o bloco aberto pode não existir na cadeia nova
  workBits = null;
  tally = new Tally();
  pollCards.clear();
  ui.work.textContent = "—";
  authors.clear();
  ui.height.textContent = "0";
  ui.fingerprint.textContent = "—";
  ui.fingerprint.title = "";
  ui.fingerprint.classList.remove("partial");
  ui.log.replaceChildren(ui.empty);
  ui.empty.hidden = false;
  fillPanel();
}

// --- painel do bloco -------------------------------------------------------
// Os campos do bloco, na ordem do formato (docs/protocol.md), com o valor bruto e, quando ajuda, uma leitura dele
let openBlock = null; // índice do bloco do painel aberto, ou null
const typeNames = Object.fromEntries(Object.entries(DataType).map(([name, n]) => [n, name]));

function fillBlockPanel() {
  if (openBlock === null) return;
  const b = blocks[openBlock];
  ui.bTitle.textContent = t("block.title", { index: openBlock });
  const room = roomName(b.room);
  const used = b.length >= 0 && b.length <= MAX_DATA_LENGTH ? b.data.subarray(0, b.length) : b.data;
  const rows = [
    ...FIELDS.map((f) => [f.name, formatField(f, b)]),
    ["data", used.length ? hex(used) : "—"],
  ];
  const readings = {
    room: room ? `“${room}”` : null,
    stamp: `${stampToDate(b.stamp)} UTC`,
    info: openBlock === 0 ? t("block.infoGenesis") : null,
    type: typeNames[b.type] ?? null,
    length: t("block.bytes", { n: used.length }),
    sig: t("block.zeroBits", { n: leadingZeroBits(b.sig) }),
    prev: openBlock === 0 ? t("block.prevGenesis") : t("block.prevOf", { index: openBlock - 1 }),
  };
  // Um campo por linha, com um <hr> entre um campo e o seguinte
  ui.bFields.replaceChildren(...rows.flatMap(([name, value], i) => {
    const field = document.createElement("div");
    field.className = "bfield";
    const label = document.createElement("span");
    label.className = "bname";
    label.textContent = name;
    const code = document.createElement("code");
    code.textContent = value;
    if (name === "author") code.style.color = colorOf(value);
    field.append(label, code);
    if (readings[name]) {
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = readings[name];
      field.append(note);
    }
    return i === 0 ? [field] : [document.createElement("hr"), field];
  }));
}

function openBlockPanel(index) {
  closeSettings(); // um painel por vez
  closePanel();
  ui.pollPanel.hidden = true;
  openBlock = index;
  ui.blockPanel.hidden = false;
  fillBlockPanel();
}
function closeBlockPanel() {
  openBlock = null;
  ui.blockPanel.hidden = true;
}
$("b-close").addEventListener("click", closeBlockPanel);
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeBlockPanel(); });
document.addEventListener("click", (ev) => {
  const view = ev.target.closest?.("[data-view]");
  if (view && blocks[view.dataset.view]) openBlockPanel(Number(view.dataset.view));
});
onLangChange(fillBlockPanel);

// --- enquetes --------------------------------------------------------------
// Extensão POLL/VOTE (poll.js). A enquete aparece como uma mensagem, com uma barra por opção; o voto aparece como uma
// linha curta. Clicar numa opção vota; clicar de novo retira o voto. Numa enquete exclusiva, clicar em outra opção
// retira o voto atual e vota na nova: dois blocos, cada um com a própria prova de trabalho
const myHex = hex(keyPair.publicKey);

function pollCard(index) {
  const p = tally.poll(index);
  const card = document.createElement("div");
  card.className = "poll";
  const label = document.createElement("div");
  label.className = "plabel";
  label.dataset.i18n = "poll.label";
  label.dataset.i18nVars = JSON.stringify({ index });
  label.textContent = t("poll.label", { index });
  const q = document.createElement("div");
  q.className = "q";
  q.textContent = p.question;
  card.append(label, q);
  p.options.forEach((option, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt";
    btn.dataset.poll = String(index);
    btn.dataset.opt = String(i);
    const fill = document.createElement("span");
    fill.className = "fill";
    const name = document.createElement("span");
    name.className = "oname";
    name.textContent = option;
    const num = document.createElement("span");
    num.className = "onum";
    btn.append(fill, name, num);
    card.append(btn);
  });
  const foot = document.createElement("div");
  foot.className = "pfoot";
  const mode = document.createElement("span");
  mode.dataset.i18n = p.exclusive ? "poll.modeOne" : "poll.modeMany";
  mode.textContent = t(mode.dataset.i18n);
  const total = document.createElement("span");
  total.className = "ptotal";
  foot.append(mode, document.createTextNode(" · "), total);
  card.append(foot);
  pollCards.set(index, card);
  paintPoll(index, card);
  return card;
}

// Atualiza as barras, os números e as opções votadas por esta chave
function paintPoll(index, card = pollCards.get(index)) {
  const counts = tally.counts(index);
  if (!card || !counts) return;
  const p = tally.poll(index);
  const mine = tally.votesOf(index, myHex);
  const total = counts.reduce((a, b) => a + b, 0);
  for (const btn of card.querySelectorAll(".opt")) {
    const i = Number(btn.dataset.opt);
    const pct = total ? Math.round((counts[i] * 100) / total) : 0;
    btn.querySelector(".fill").style.width = `${pct}%`;
    btn.querySelector(".onum").textContent = `${counts[i]} · ${pct}%`;
    btn.classList.toggle("voted", mine.has(i));
    btn.setAttribute("aria-pressed", String(mine.has(i)));
    const key = mine.has(i) ? "poll.unvote" : "poll.vote";
    btn.dataset.i18nAria = key;
    btn.setAttribute("aria-label", t(key, { option: p.options[i] }));
    btn.title = btn.getAttribute("aria-label");
    btn.disabled = !synced || pending !== null;
  }
  const totalEl = card.querySelector(".ptotal");
  totalEl.dataset.i18n = total === 1 ? "poll.total1" : "poll.totalN";
  totalEl.dataset.i18nVars = JSON.stringify({ n: total });
  totalEl.textContent = t(totalEl.dataset.i18n, { n: total });
}
// O applyStatic traduz o aria-label sem as variáveis: repinta as enquetes depois dele
onLangChange(() => { for (const index of pollCards.keys()) paintPoll(index); });

// Linha de um voto: "<quem> votou em “Pizza” na enquete do bloco 12 · “Onde vamos comer?”". O índice leva à enquete
function voteLine(block) {
  const v = parseVote(block);
  const p = tally.poll(v.poll);
  const line = document.createElement("div");
  line.className = "text vote";
  const what = document.createElement("span");
  what.dataset.i18n = v.cast ? "vote.cast" : "vote.revoke";
  what.dataset.i18nVars = JSON.stringify({ option: p.options[v.option] });
  what.textContent = t(what.dataset.i18n, { option: p.options[v.option] });
  const where = document.createElement("a");
  where.href = "#";
  where.className = "goto";
  where.dataset.goto = String(v.poll);
  where.dataset.i18n = "vote.where";
  where.dataset.i18nVars = JSON.stringify({ index: v.poll });
  where.textContent = t("vote.where", { index: v.poll });
  const q = document.createElement("span");
  q.className = "vq";
  q.textContent = `“${p.question}”`;
  line.append(what, " ", where, " · ", q);
  return line;
}

document.addEventListener("click", (ev) => {
  const go = ev.target.closest?.("a.goto");
  if (go) {
    ev.preventDefault();
    const card = pollCards.get(Number(go.dataset.goto));
    const msg = card?.closest(".msg");
    if (msg) {
      msg.scrollIntoView({ block: "center" });
      msg.classList.remove("flash");
      void msg.offsetWidth; // reinicia a animação
      msg.classList.add("flash");
    }
    return;
  }
  const btn = ev.target.closest?.("button.opt");
  if (btn) vote(Number(btn.dataset.poll), Number(btn.dataset.opt));
});

function vote(index, option) {
  const p = tally.poll(index);
  if (!p || !synced || pending) return;
  setMsgError();
  const mine = tally.votesOf(index, myHex);
  const spec = (o, cast) => ({ kind: "vote", poll: index, option: o, cast });
  let specs;
  if (mine.has(option)) specs = [spec(option, false)];
  else if (p.exclusive && mine.size > 0) specs = [spec([...mine][0], false), spec(option, true)];
  else specs = [spec(option, true)];
  queue = specs.slice(1);
  sendSpec(specs[0], 1).catch((err) => setMsgError(null, {}, err.message));
}

// Menu do "+" ao lado da barra de mensagem. Por enquanto, só a enquete
function closePlusMenu() {
  ui.plusMenu.hidden = true;
  ui.plus.setAttribute("aria-expanded", "false");
}
ui.plus.addEventListener("click", (ev) => {
  ev.stopPropagation();
  const open = ui.plusMenu.hidden;
  ui.plusMenu.hidden = !open;
  ui.plus.setAttribute("aria-expanded", String(open));
  if (open) $("menu-poll").focus();
});
document.addEventListener("click", (ev) => {
  if (!ui.plusMenu.hidden && !ev.target.closest?.("#plus-menu")) closePlusMenu();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") { closePlusMenu(); ui.pollPanel.hidden = true; }
});
$("menu-poll").addEventListener("click", () => {
  closePlusMenu();
  closeSettings(); // um painel por vez
  closePanel();
  closeBlockPanel();
  ui.pollPanel.hidden = false;
  refreshPollForm();
  ui.pollQuestion.focus();
});
$("poll-close").addEventListener("click", () => { ui.pollPanel.hidden = true; });

// Painel de criação: pergunta, de 2 a 10 opções, e a opção de exclusividade
function addOptionRow(value = "") {
  const row = document.createElement("div");
  row.className = "orow";
  const input = document.createElement("input");
  input.className = "poll-option";
  input.value = value;
  const del = document.createElement("button");
  del.type = "button";
  del.className = "odel";
  del.textContent = "×";
  del.dataset.i18nAria = "poll.remove";
  del.setAttribute("aria-label", t("poll.remove"));
  del.addEventListener("click", () => { row.remove(); refreshPollForm(); });
  input.addEventListener("input", refreshPollForm);
  row.append(input, del);
  ui.pollOptions.append(row);
}

function resetPollForm(close = false) {
  ui.pollQuestion.value = "";
  ui.pollExclusive.checked = false;
  ui.pollOptions.replaceChildren();
  for (let i = 0; i < MIN_POLL_OPTIONS; i++) addOptionRow();
  if (close) ui.pollPanel.hidden = true;
  refreshPollForm();
}

// Lê o formulário: { spec } pronto para enviar, ou { error, vars } com o que falta
function pollFormSpec() {
  const question = ui.pollQuestion.value.trim();
  const options = [...ui.pollOptions.querySelectorAll(".poll-option")].map((i) => i.value.trim());
  if (!question) return { error: "poll.errQuestion" };
  if (options.some((o) => !o)) return { error: "poll.errOption" };
  if (new Set(options).size !== options.length) return { error: "poll.errDuplicate" };
  try {
    pollData(question, options);
  } catch {
    const size = new TextEncoder().encode([question, ...options].join("\0")).length;
    return { error: "poll.errSize", vars: { n: size } };
  }
  return { spec: { kind: "poll", question, options, exclusive: ui.pollExclusive.checked } };
}

function refreshPollForm() {
  const rows = ui.pollOptions.querySelectorAll(".orow");
  rows.forEach((row, i) => {
    const input = row.querySelector("input");
    input.placeholder = t("poll.optionPlaceholder", { n: i + 1 });
    input.setAttribute("aria-label", input.placeholder);
    row.querySelector(".odel").hidden = rows.length <= MIN_POLL_OPTIONS;
  });
  ui.pollAdd.disabled = rows.length >= MAX_POLL_OPTIONS;
  const question = ui.pollQuestion.value.trim();
  const options = [...rows].map((r) => r.querySelector("input").value.trim());
  const size = new TextEncoder().encode([question, ...options].join("\0")).length;
  ui.pollCount.textContent = `${size}/${MAX_DATA_LENGTH}`;
  ui.pollCount.classList.toggle("over", size > MAX_DATA_LENGTH);
  // O gênese define a prova de trabalho no info: a primeira mensagem da sala é sempre de texto
  ui.pollGenesis.hidden = !(synced && !head);
  const typed = question || options.some(Boolean);
  const res = pollFormSpec();
  ui.pollErr.textContent = typed && res.error ? t(res.error, res.vars) : "";
  ui.pollCreate.disabled = !synced || !head || pending !== null || !res.spec;
}
ui.pollQuestion.addEventListener("input", refreshPollForm);
ui.pollExclusive.addEventListener("change", refreshPollForm);
ui.pollAdd.addEventListener("click", () => {
  addOptionRow();
  refreshPollForm();
  ui.pollOptions.lastElementChild.querySelector("input").focus();
});
ui.pollForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const res = pollFormSpec();
  if (!res.spec || !synced || !head || pending) return;
  setMsgError();
  queue = [];
  sendSpec(res.spec, 1).catch((err) => setMsgError(null, {}, err.message));
});
onLangChange(refreshPollForm);

// --- conexão ---------------------------------------------------------------
let ws = null;
let synced = false;

// O status do cabeçalho mostra só a conexão. key é uma chave do i18n.js
function setStatus(key, kind = "") {
  ui.status.dataset.i18n = key;
  ui.status.textContent = t(key);
  ui.status.className = kind;
}

// Problema com uma mensagem (recusa, erro, assinatura inválida) fica na linha abaixo da barra de mensagem, e não no
// status. key é uma chave do i18n.js; raw é um texto que não se traduz (mensagem de uma exceção). Sem argumentos, limpa
function setMsgError(key = null, vars = {}, raw = null) {
  const el = ui.msgError;
  el.hidden = key === null && raw === null;
  if (raw !== null) {
    delete el.dataset.i18n;
    el.textContent = raw;
  } else if (key !== null) {
    el.dataset.i18n = key;
    el.dataset.i18nVars = JSON.stringify(vars);
    el.textContent = t(key, vars);
  } else {
    delete el.dataset.i18n;
    el.textContent = "";
  }
}

function connect() {
  synced = false;
  setStatus("status.connecting");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => (typeof ev.data === "string" ? onNotice(ev.data) : onBlocks(ev.data));
  ws.onclose = () => {
    synced = false;
    updateCount();
    setStatus("status.disconnected", "bad");
    setTimeout(connect, 1000);
  };
}

function resync() {
  // A cópia local não encaixa: reconecta e recebe o histórico inteiro
  if (ws) ws.close();
}

function onBlocks(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes.length % BLOCK_SIZE !== 0) return resync();
  const isHistory = !synced;
  if (isHistory) {
    // O primeiro frame binário depois de conectar é o histórico completo
    resetChain();
    synced = true;
    setStatus("status.connected", "ok");
    updateCount();
  }
  for (let off = 0; off < bytes.length; off += BLOCK_SIZE) {
    if (!apply(decodeBlock(bytes.subarray(off, off + BLOCK_SIZE)))) return resync();
  }
  // Mensagem enviada antes de reconectar e que não está no histórico: nunca foi aceita. Refaz sobre a cabeça nova
  if (isHistory && pending) {
    if (pending.fraud) { pending = null; updateCount(); } else retry();
  }
}

function onNotice(text) {
  let n;
  try { n = JSON.parse(text); } catch { return; }
  if (n.type === "time") {
    try {
      clockOffset = BigInt(n.now) - BigInt(Date.now()) * 1_000_000n;
      runStart = BigInt(n.run_start);
      realOffset = n.real_offset ? BigInt(n.real_offset) : null;
    } catch { /* aviso malformado: mantém o anterior */ }
    refreshTimes();
    return;
  }
  if (n.type === "rejected") {
    if (n.head) {
      // Outro aparelho encadeou antes; tenta encaixar a cabeça recebida
      if (!apply(decodeBlock(fromHex(n.head)))) return resync();
    } else if (head) {
      // O validator está com a cadeia vazia; a nossa cópia não vale. O reenvio acontece depois do histórico (onBlocks)
      return resync();
    }
    if (pending?.fraud) {
      // Bloco editado de propósito: nada de reenvio automático; a pessoa vê o motivo da recusa
      setFraudResult("fraud.rejected", "bad", { code: n.error });
      pending = null;
      updateCount();
      return;
    }
    if (pending && n.error === "TIMESTAMP_IN_FUTURE") {
      // A diferença de relógio ficou errada (o validator reiniciou, por exemplo): reconectar traz a hora de novo, e o
      // reenvio acontece depois do histórico (onBlocks)
      return resync();
    }
    if (pending && (n.error === "NO_HASH_CONTINUITY" || n.error === "NO_TIMESTAMP_CONTINUITY")) {
      return retry();
    }
    // Recusa sem reenvio (DUPLICATE_VOTE, INVALID_VOTE e as outras): a fila não faz mais sentido
    setMsgError("status.rejected", { code: n.error });
    pending = null;
    queue = [];
    updateCount();
  } else if (n.type === "error") {
    if (pending?.fraud) setFraudResult("fraud.error", "bad", { code: n.error });
    else setMsgError("status.error", { code: n.error });
    pending = null;
    queue = [];
    updateCount();
  }
}

// --- envio -----------------------------------------------------------------
function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

// Só espaços em branco (espaços, tabs, quebras, espaço sem quebra, espaços Unicode) não é mensagem. Caracteres
// invisíveis que não são espaço, como o de largura zero, não entram nessa regra
const isBlank = (s) => /^\s*$/.test(s);

// Altura da caixa de mensagem: a do conteúdo, limitada pelo max-height do CSS
function fitText() {
  ui.text.style.height = "auto";
  ui.text.style.height = `${ui.text.scrollHeight}px`;
}

// A caixa tinha o foco quando foi travada: volta a ter quando destravar
let refocusText = false;

function updateCount() {
  fitText();
  const n = byteLength(ui.text.value);
  ui.count.textContent = `${n}/${MAX_DATA_LENGTH}`;
  ui.count.classList.toggle("over", n > MAX_DATA_LENGTH);
  // Com um bloco pendente (prova de trabalho rodando ou esperando a resposta do validator), a caixa fica travada: o
  // texto é o do bloco e só se apaga quando ele é aceito. Toda saída do pendente (aceito, recusado, erro, desistência)
  // passa por aqui e destrava
  const locked = !synced || pending !== null;
  if (locked && document.activeElement === ui.text) refocusText = true;
  ui.text.disabled = locked;
  ui.workBits.disabled = locked;
  if (!locked && refocusText) {
    refocusText = false;
    ui.text.focus();
  }
  // Com a cadeia vazia, quem envia cria o gênese e escolhe o N da sala
  ui.workBox.hidden = !(synced && !head);
  const badBits = !head && chosenBits() === null;
  ui.workBits.classList.toggle("over", badBits);
  ui.send.disabled = !synced || pending !== null || isBlank(ui.text.value) || n > MAX_DATA_LENGTH || badBits;
  ui.plus.disabled = locked;
  if (locked) closePlusMenu();
  refreshPollForm();
  for (const index of pollCards.keys()) paintPoll(index);
}

// N digitado para o gênese: inteiro de 0 a MAX_WORK_BITS, ou null
function chosenBits() {
  const v = ui.workBits.value.trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n <= MAX_WORK_BITS ? n : null;
}

// Linha de progresso da prova de trabalho, abaixo da barra de mensagem. null esconde
function setMining(tries) {
  ui.mining.hidden = tries === null;
  if (tries !== null) {
    ui.mining.dataset.i18n = "msg.mining";
    ui.mining.dataset.i18nVars = JSON.stringify({ n: tries });
    ui.mining.textContent = t("msg.mining", { n: tries });
  }
}

// O que vai no bloco: { kind: "text", text }, { kind: "poll", question, options, exclusive } ou
// { kind: "vote", poll, option, cast }
function fillBlock(block, spec) {
  if (spec.kind === "poll") uploadPoll(block, spec.question, spec.options, spec.exclusive);
  else if (spec.kind === "vote") uploadVote(block, spec.poll, spec.option, spec.cast);
  else uploadString(block, spec.text);
}

// Monta o bloco, faz a prova de trabalho (varia o nonce até a assinatura começar com N bits zero) e envia. Se a cabeça
// mudar no meio (outro aparelho encadeou antes), recomeça sobre a nova; sem conexão, o reenvio fica para depois do
// histórico (onBlocks). Enquetes e votos são conferidos antes contra a cópia local: um voto que deixou de valer (ou
// uma enquete com a cadeia vazia) não é enviado
async function sendSpec(spec, tries) {
  const startHead = head;
  const block = nextBlock(head, nowNs());
  fillBlock(block, spec);
  const bits = head ? workBits : chosenBits();
  if (!head && spec.kind === "text") block.info = bits;
  block.author = keyPair.publicKey.slice();
  const localErr = spec.kind === "text" ? null : tally.check(height, block);
  if (localErr) {
    setMsgError("status.rejected", { code: localErr });
    pending = null;
    queue = [];
    updateCount();
    return;
  }
  const token = {};
  pending = { spec, text: spec.text, sig: null, tries, mining: token };
  updateCount();
  const current = () => pending?.mining === token;
  const bytes = await mineBlock(block, keyPair.secretKey, bits, {
    onProgress: (n) => { if (current()) setMining(n); },
    isCancelled: () => !current() || head !== startHead || !synced,
  });
  if (!current()) return; // outro envio tomou o lugar deste
  setMining(null);
  if (!bytes) {
    if (synced) sendSpec(spec, tries);
    return;
  }
  pending.sig = block.sig;
  pending.mining = null;
  sendBlock(bytes);
}

// Envia o bloco pronto. Se nem a confirmação nem a recusa chegarem em ANSWER_MS, reconecta: o histórico que volta diz
// se o bloco entrou (e o pendente se resolve) ou não (e ele é refeito ou abandonado). A caixa nunca fica travada
const ANSWER_MS = 10_000;
function sendBlock(bytes) {
  const waiting = pending;
  ws.send(bytes);
  setTimeout(() => { if (pending === waiting && pending?.sig) resync(); }, ANSWER_MS);
}

function retry() {
  if (pending.tries >= MAX_RETRIES) {
    setMsgError("status.chain");
    pending = null;
    updateCount();
    return;
  }
  sendSpec(pending.spec, pending.tries + 1);
}

function sendQueued() {
  if (pending || !synced || !queue.length) return;
  sendSpec(queue.shift(), 1);
}

// --- teste de fraude -------------------------------------------------------
// Ligado nas configurações. A barra de baixo mostra todos os campos do bloco (menos o data, que é o texto) para editar
// à mão. overrides guarda só o que a pessoa digitou; o resto acompanha a mensagem normal
let fraudOn = false;
const overrides = {};
const newNonce = () => new DataView(nacl.randomBytes(8).buffer).getBigUint64(0, true);
let draftNonce = newNonce();
// Instante do rascunho quando o stamp está congelado (opção desmarcada); null enquanto acompanha o relógio
let frozenNs = null;
// Como o room e o stamp são mostrados e digitados (opções abaixo do botão de restaurar)
const fraudModes = () => ({ roomText: !ui.fraudRoomHex.checked, stampDate: ui.fraudStampDate.checked });
const rows = new Map();

for (const field of FIELDS) {
  const row = document.createElement("div");
  row.className = "frow";
  const label = document.createElement("label");
  label.htmlFor = `f-${field.name}`;
  label.textContent = field.name;
  const input = document.createElement("input");
  input.id = `f-${field.name}`;
  input.spellcheck = false;
  input.autocomplete = "off";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.i18n = "fraud.default";
  btn.textContent = t("fraud.default");
  const err = document.createElement("div");
  err.className = "ferr";
  err.hidden = true;
  input.addEventListener("input", () => { overrides[field.name] = input.value; refreshFraud(); });
  btn.addEventListener("click", () => { delete overrides[field.name]; refreshFraud(); });
  row.append(label, input, btn, err);
  ui.fraudFields.append(row);
  rows.set(field.name, { row, input, btn, err });
}

// extra substitui qualquer argumento (o envio fixa o instante para compor duas vezes o mesmo bloco)
function composeFraud(extra = {}) {
  return composeBlock({
    head, text: ui.text.value, nowNs: frozenNs ?? nowNs(), nonce: draftNonce, keyPair, overrides, resign: ui.fraudResign.checked,
    modes: fraudModes(), genesisBits: chosenBits() ?? 0, ...extra,
  });
}

// Atualiza as caixas: o que não foi editado mostra o valor que a mensagem normal teria agora. Devolve o bloco montado
function refreshFraud() {
  if (!fraudOn) return null;
  let res;
  try { res = composeFraud(); } catch { return null; } // texto maior que o data: o contador já avisa
  ui.fraudReset.disabled = Object.keys(overrides).length === 0;
  for (const field of FIELDS) {
    const r = rows.get(field.name);
    const edited = field.name in overrides;
    r.row.classList.toggle("edited", edited);
    r.btn.disabled = !edited;
    if (document.activeElement !== r.input) r.input.value = edited ? overrides[field.name] : formatField(field, res.effective, fraudModes());
    const e = res.errors[field.name];
    r.err.hidden = !e;
    r.err.textContent = e ? t(e.key, e.vars) : "";
  }
  return res;
}
setInterval(refreshFraud, 500);

function setFraudResult(key, kind = "", vars = {}) {
  const el = ui.fraudResult;
  if (key) {
    el.dataset.i18n = key;
    el.dataset.i18nVars = JSON.stringify(vars);
    el.textContent = t(key, vars);
  } else {
    delete el.dataset.i18n;
    el.textContent = "";
  }
  el.className = kind;
}

ui.fraudToggle.addEventListener("change", () => {
  fraudOn = ui.fraudToggle.checked;
  ui.fraud.hidden = !fraudOn;
  if (!fraudOn) {
    for (const k of Object.keys(overrides)) delete overrides[k];
    setFraudResult("");
  }
  if (fraudOn && !ui.fraudSync.checked) frozenNs = nowNs();
  refreshFraud();
});
ui.fraudResign.addEventListener("change", refreshFraud);
ui.fraudSync.addEventListener("change", () => {
  frozenNs = ui.fraudSync.checked ? null : nowNs();
  refreshFraud();
});
// Trocar o modo de um campo reescreve o que a pessoa já digitou nele, quando dá
for (const [box, name, key] of [[ui.fraudStampDate, "stamp", "stampDate"], [ui.fraudRoomHex, "room", "roomText"]]) {
  box.addEventListener("change", () => {
    const now = fraudModes(), before = { ...now, [key]: !now[key] };
    if (name in overrides) overrides[name] = convertText(FIELDS.find((f) => f.name === name), overrides[name], before, now);
    refreshFraud();
  });
}
ui.fraudReset.addEventListener("click", () => {
  for (const k of Object.keys(overrides)) delete overrides[k];
  refreshFraud();
});
onLangChange(refreshFraud);

// Envia o bloco do teste de fraude. A prova de trabalho segue a mensagem normal: com "assinar automaticamente", minera
// o bloco editado (sem trocar o author); sem ela, minera o bloco sem edições e usa a assinatura dele. Um nonce ou uma
// sig digitados vão como estão, sem mineração
async function sendFraud() {
  const now = frozenNs ?? nowNs();
  let res = composeFraud({ nowNs: now });
  if (!res.bytes) {
    refreshFraud();
    setFraudResult("fraud.invalid", "bad");
    return;
  }
  // Um gênese que pede mais que MAX_WORK_BITS é recusado antes do trabalho: assina uma vez só
  const bits = head ? workBits : (res.effective.info <= MAX_WORK_BITS ? res.effective.info : 0);
  const token = {};
  pending = { text: ui.text.value, sig: null, tries: MAX_RETRIES, fraud: true, mining: token };
  setFraudResult("fraud.sending");
  updateCount();
  const current = () => pending?.mining === token;
  const opts = { onProgress: (n) => { if (current()) setMining(n); }, isCancelled: () => !current() || !synced };
  let bytes = res.bytes;
  if (!("sig" in overrides)) {
    if (!ui.fraudResign.checked) {
      const plain = composeFraud({ nowNs: now, overrides: {}, resign: true }).effective;
      if (await mineBlock(plain, keyPair.secretKey, bits, opts)) {
        draftNonce = plain.nonce;
        res = composeFraud({ nowNs: now });
        bytes = res.bytes;
      } else {
        bytes = null;
      }
    } else if (!("nonce" in overrides)) {
      bytes = await mineBlock(res.effective, keyPair.secretKey, bits, opts);
    }
  }
  if (!current()) return;
  setMining(null);
  if (!bytes) {
    pending = null;
    setFraudResult("");
    updateCount();
    return;
  }
  pending.sig = res.effective.sig;
  pending.mining = null;
  sendBlock(bytes);
}

ui.text.addEventListener("input", () => { updateCount(); refreshFraud(); });
// No teclado físico, Enter envia e Shift+Enter quebra a linha. Em tela de toque (ponteiro principal grosso), o Enter do
// teclado virtual quebra a linha e quem envia é o botão. Durante a composição de um caractere (IME), o Enter é dela
const touch = matchMedia("(pointer: coarse)");
ui.text.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing || touch.matches) return;
  ev.preventDefault();
  if (!ui.send.disabled) ui.form.requestSubmit();
});
ui.form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = ui.text.value;
  if (!synced || pending || isBlank(text)) return;
  setMsgError();
  (fraudOn ? sendFraud() : sendSpec({ kind: "text", text }, 1)).catch((err) => setMsgError(null, {}, err.message));
});
ui.workBits.addEventListener("input", () => { updateCount(); refreshFraud(); });

resetPollForm();
connect();
