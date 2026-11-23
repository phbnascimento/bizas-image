// Teste de fraude: monta o bloco que a pessoa quer enviar, com qualquer campo editado à mão, para ver como o protocolo
// reage. Só o data não é editável: é o texto da mensagem. Funções sem DOM, testadas em bizas.test.js
import { encodeBlock, fromHex, hex, nextBlock, uploadString } from "./bizas.js";

const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n;

// kind "hex": bytes de tamanho fixo em hexadecimal; kind "int": inteiro decimal dentro de [min, max]
export const FIELDS = [
  { name: "room", kind: "hex", bytes: 8 },
  { name: "stamp", kind: "int", min: I64_MIN, max: I64_MAX },
  { name: "nonce", kind: "int", min: 0n, max: 2n ** 64n - 1n },
  { name: "info", kind: "int", min: 0n, max: 2n ** 32n - 1n },
  { name: "type", kind: "int", min: 0n, max: 65535n },
  { name: "length", kind: "int", min: -32768n, max: 32767n },
  { name: "author", kind: "hex", bytes: 32 },
  { name: "sig", kind: "hex", bytes: 64 },
  { name: "prev", kind: "hex", bytes: 64 },
];

const NS = 1_000_000_000n;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;

// Carimbo (ns desde 1970) como data UTC "AAAA-MM-DD hh:mm:ss.nnnnnnnnn", sem perder nenhum nanossegundo
export function stampToDate(ns) {
  const sec = ns >= 0n ? ns / NS : -((-ns + NS - 1n) / NS); // divisão para baixo
  const iso = new Date(Number(sec) * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${String(ns - sec * NS).padStart(9, "0")}`;
}

// Inverso de stampToDate; a fração é opcional (1 a 9 dígitos). Devolve ns ou null se o texto não for uma data válida
export function dateToStamp(text) {
  const m = DATE_RE.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, se, 0);
  // Dia 30 de fevereiro, hora 25 etc.: o Date "corrige" em vez de recusar, então confere de volta
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) return null;
  return BigInt(dt.getTime() / 1000) * NS + BigInt((m[7] ?? "").padEnd(9, "0"));
}

// room como texto: UTF-8 preenchido com zeros à direita. Devolve null se os bytes não forem exatamente um texto assim
function roomToText(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); } catch { return null; }
}

// modes: { stampDate, roomText }. Com stampDate, o stamp é editado como data UTC em vez de ns; com roomText, o room é
// editado como texto em vez de hex

// Texto de um valor de campo (o mesmo tipo que parseField devolve), como aparece na caixa. null se o modo não consegue
// representar o valor sem perda
function formatValue(field, value, modes = {}) {
  if (field.name === "room" && modes.roomText) return roomToText(value);
  if (field.name === "stamp" && modes.stampDate) return stampToDate(value);
  return field.kind === "hex" ? hex(value) : String(value);
}

// Texto de um campo do bloco, como aparece na caixa. Um room que não cabe no modo texto aparece em hex
export function formatField(field, block, modes = {}) {
  return formatValue(field, block[field.name], modes) ?? formatValue(field, block[field.name], {});
}

// Lê o texto digitado. Devolve { value } ou { error: { key, vars } } (chave do i18n.js)
export function parseField(field, text, modes = {}) {
  if (field.name === "room" && modes.roomText) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > field.bytes) return { error: { key: "fraud.badText", vars: { field: field.name, n: field.bytes } } };
    const room = new Uint8Array(field.bytes);
    room.set(bytes);
    return { value: room };
  }
  const s = text.trim();
  if (field.kind === "hex") {
    if (s.length !== field.bytes * 2 || /[^0-9a-f]/i.test(s)) {
      return { error: { key: "fraud.badHex", vars: { field: field.name, n: field.bytes * 2 } } };
    }
    return { value: fromHex(s) };
  }
  if (field.name === "stamp" && modes.stampDate) {
    const ns = dateToStamp(s);
    if (ns === null || ns < field.min || ns > field.max) return { error: { key: "fraud.badDate", vars: { field: field.name } } };
    return { value: ns };
  }
  if (!/^-?\d+$/.test(s)) return { error: badInt(field) };
  const v = BigInt(s);
  if (v < field.min || v > field.max) return { error: badInt(field) };
  return { value: field.name === "stamp" || field.name === "nonce" ? v : Number(v) };
}
const badInt = (f) => ({ key: "fraud.badInt", vars: { field: f.name, min: String(f.min), max: String(f.max) } });

// Troca o texto de um campo editado de um modo para o outro (ao marcar ou desmarcar uma opção). Se o texto não vale no
// modo antigo, ou o valor não cabe no novo, fica como está: o campo mostra o erro e a pessoa corrige
export function convertText(field, text, from, to) {
  const r = parseField(field, text, from);
  if (r.error) return text;
  return formatValue(field, r.value, to) ?? text;
}

// Monta o bloco. overrides: { campo: texto digitado }. nonce: o sorteado para este rascunho (fixo, para a caixa não
// mudar a cada atualização). resign: se a assinatura é refeita depois das edições; se não, vai a assinatura do bloco
// sem edições, que deixa de bater (FRAUD). genesisBits: o info do bloco quando ele é o gênese (o N da cadeia). A
// assinatura aqui é feita uma vez só, sem prova de trabalho: quem minera é o envio, no app.js
//
// Devolve { effective, errors: { campo: { key, vars } }, bytes }; bytes é null se algum campo estiver inválido.
// Lança se o texto não couber no data
export function composeBlock({ head, text, nowNs, nonce, keyPair, overrides, resign, modes = {}, genesisBits = 0 }) {
  const base = nextBlock(head, nowNs);
  base.nonce = nonce;
  if (!head) base.info = genesisBits;
  uploadString(base, text);
  base.author = keyPair.publicKey.slice();
  const encodeWith = (b, sig) => encodeBlock({ ...b, sig });
  const sign = (b) => globalThis.nacl.sign.detached(encodeWith(b, new Uint8Array(64)), keyPair.secretKey);
  const originalSig = sign(base);

  const effective = { ...base, sig: originalSig };
  const errors = {};
  for (const field of FIELDS) {
    if (field.name === "sig" || !(field.name in overrides)) continue;
    const r = parseField(field, overrides[field.name], modes);
    if (r.error) errors[field.name] = r.error; else effective[field.name] = r.value;
  }
  const sigField = FIELDS.find((f) => f.name === "sig");
  if ("sig" in overrides) {
    const r = parseField(sigField, overrides.sig, modes);
    if (r.error) errors.sig = r.error; else effective.sig = r.value;
  } else if (resign) {
    effective.sig = sign(effective);
  }
  const bytes = Object.keys(errors).length === 0 ? encodeBlock(effective) : null;
  return { effective, errors, bytes };
}
