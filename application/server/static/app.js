// Cliente do chat: gera/guarda a chave, assina cada mensagem e mantém a cópia local da cadeia a partir do que o server
// transmite. Protocolo: docs/protocol.md
import {
  BLOCK_SIZE, MAX_DATA_LENGTH, decodeBlock, equalBytes, fingerprint, fromHex, hex,
  nextBlock, signBlock, textOf, uploadString, verifyBlock,
} from "./bizas.js";
import { formatWhen } from "./when.js";

const nacl = globalThis.nacl;
const $ = (id) => document.getElementById(id);
const ui = {
  log: $("log"), empty: $("empty"), room: $("room"), me: $("me"), height: $("height"), fingerprint: $("fingerprint"),
  status: $("status"), form: $("form"), text: $("text"), count: $("count"), send: $("send"),
};
const ZERO_SIG = new Uint8Array(64);
const MAX_RETRIES = 3;

// --- identidade ------------------------------------------------------------
// PENDENTE: o localStorage some se o usuário limpar os dados do site, e a identidade some junto (ver docs/protocol.md)
function loadKeyPair() {
  let seed = null;
  try {
    const s = localStorage.getItem("bizas.seed");
    if (s && s.length === 64) seed = fromHex(s);
  } catch { /* sem localStorage: chave só desta aba */ }
  if (!seed) {
    seed = nacl.randomBytes(32);
    try { localStorage.setItem("bizas.seed", hex(seed)); } catch { /* idem */ }
  }
  return nacl.sign.keyPair.fromSeed(seed);
}
const keyPair = loadKeyPair();
const shortId = (pub) => hex(pub.subarray(0, 4));
ui.me.textContent = shortId(keyPair.publicKey);

// --- cadeia local ----------------------------------------------------------
let head = null;   // último bloco aceito
let height = 0;
let pending = null; // { text, sig, tries }

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

function roomName(room) {
  const end = room.indexOf(0);
  return new TextDecoder().decode(room.subarray(0, end < 0 ? room.length : end));
}

function render(block) {
  ui.empty.hidden = true;
  const el = document.createElement("div");
  el.className = "msg";
  if (equalBytes(block.author, keyPair.publicKey)) el.classList.add("mine");

  const meta = document.createElement("div");
  meta.className = "meta";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = shortId(block.author);
  who.title = hex(block.author);
  const hue = (block.author[0] * 360) / 256;
  who.style.color = `hsl(${hue} 55% 45%)`;
  const when = document.createElement("span");
  when.className = "when";
  when.dataset.stamp = String(block.stamp);
  when.textContent = whenText(block.stamp);
  meta.append(who, when);

  const body = document.createElement("div");
  body.className = "text";
  const text = textOf(block);
  // textContent, nunca innerHTML: o conteúdo vem de qualquer aparelho
  body.textContent = text ?? `(content of type ${block.type}, ${block.length} bytes)`;

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
    setStatus("received a block with an invalid signature", "bad");
    return false;
  }
  head = block;
  height++;
  ui.height.textContent = String(height);
  // Impressão digital da cadeia nesta altura: quem compara com outra pessoa confere altura e impressão digital
  ui.fingerprint.textContent = fingerprint(block);
  ui.fingerprint.title = hex(block.sig);
  ui.room.textContent = roomName(block.room);
  render(block);
  if (pending && equalBytes(block.sig, pending.sig)) {
    pending = null;
    ui.text.value = "";
    updateCount();
  }
  return true;
}

function resetChain() {
  head = null;
  height = 0;
  ui.height.textContent = "0";
  ui.fingerprint.textContent = "—";
  ui.fingerprint.title = "";
  ui.log.replaceChildren(ui.empty);
  ui.empty.hidden = false;
}

// --- conexão ---------------------------------------------------------------
let ws = null;
let synced = false;

function setStatus(text, kind = "") {
  ui.status.textContent = text;
  ui.status.className = kind;
}

function connect() {
  synced = false;
  setStatus("connecting…");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => (typeof ev.data === "string" ? onNotice(ev.data) : onBlocks(ev.data));
  ws.onclose = () => {
    synced = false;
    updateCount();
    setStatus("disconnected; retrying…", "bad");
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
    setStatus("connected", "ok");
    updateCount();
  }
  for (let off = 0; off < bytes.length; off += BLOCK_SIZE) {
    if (!apply(decodeBlock(bytes.subarray(off, off + BLOCK_SIZE)))) return resync();
  }
  // Mensagem enviada antes de reconectar e que não está no histórico: nunca foi aceita. Refaz sobre a cabeça nova
  if (isHistory && pending) retry();
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
    if (pending && n.error === "TIMESTAMP_IN_FUTURE") {
      // A diferença de relógio ficou errada (o validator reiniciou, por exemplo): reconectar traz a hora de novo, e o
      // reenvio acontece depois do histórico (onBlocks)
      return resync();
    }
    if (pending && (n.error === "NO_HASH_CONTINUITY" || n.error === "NO_TIMESTAMP_CONTINUITY")) {
      return retry();
    }
    setStatus(`message rejected: ${n.error}`, "bad");
    pending = null;
    updateCount();
  } else if (n.type === "error") {
    setStatus(`error: ${n.error}`, "bad");
    pending = null;
    updateCount();
  }
}

// --- envio -----------------------------------------------------------------
function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

function updateCount() {
  const n = byteLength(ui.text.value);
  ui.count.textContent = `${n}/${MAX_DATA_LENGTH}`;
  ui.count.classList.toggle("over", n > MAX_DATA_LENGTH);
  ui.text.disabled = !synced;
  ui.send.disabled = !synced || pending !== null || n === 0 || n > MAX_DATA_LENGTH;
}

function sendText(text, tries) {
  const block = nextBlock(head, nowNs());
  uploadString(block, text);
  const bytes = signBlock(block, keyPair.secretKey);
  pending = { text, sig: block.sig, tries };
  updateCount();
  ws.send(bytes);
}

function retry() {
  if (pending.tries >= MAX_RETRIES) {
    setStatus("could not chain the message; please try again", "bad");
    pending = null;
    updateCount();
    return;
  }
  sendText(pending.text, pending.tries + 1);
}

ui.text.addEventListener("input", updateCount);
ui.form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = ui.text.value;
  if (!synced || pending || !text) return;
  try {
    sendText(text, 1);
  } catch (err) {
    setStatus(err.message, "bad");
  }
});

connect();
