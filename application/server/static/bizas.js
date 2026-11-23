// Serialização e assinatura do bloco, espelho de application/bizas/block.go. O bloco tem 512 bytes em little-endian;
// assina-se o bloco com sig zerado. Usa o tweetnacl (globalThis.nacl), carregado antes deste módulo

export const BLOCK_SIZE = 512;
export const MAX_DATA_LENGTH = 320;
// Bytes da assinatura da cabeça que entram na impressão digital (FingerprintSize no Go)
export const FINGERPRINT_SIZE = 8;
export const DEFAULT_ROOM = Uint8Array.of(66, 105, 122, 97, 115, 0, 0, 0); // "Bizas"
// Prova de trabalho: o info do gênese é o N da cadeia, e toda assinatura começa com N bits zero (MaxWorkBits no Go)
export const MAX_WORK_BITS = 20;
// N que a página sugere a quem cria o gênese
export const DEFAULT_WORK_BITS = 10;
const U64 = (1n << 64n) - 1n;

export const DataType = Object.freeze({
  TEXT: 0, MONO: 1, MONO_RLE: 2, COLORED: 3, COLORED_RLE: 4, NETWORK_ACTION: 5, OTHER: 6,
});

const OFF = Object.freeze({
  room: 0, stamp: 8, nonce: 16, info: 24, type: 28, length: 30,
  author: 32, sig: 64, prev: 128, data: 192,
});

const nacl = () => {
  if (!globalThis.nacl) throw new Error("tweetnacl not loaded");
  return globalThis.nacl;
};

export function emptyBlock() {
  return {
    room: new Uint8Array(8),
    stamp: 0n,
    nonce: 0n,
    info: 0,
    type: DataType.TEXT,
    length: 0,
    author: new Uint8Array(32),
    sig: new Uint8Array(64),
    prev: new Uint8Array(64),
    data: new Uint8Array(MAX_DATA_LENGTH),
  };
}

export function encodeBlock(b) {
  const out = new Uint8Array(BLOCK_SIZE);
  const dv = new DataView(out.buffer);
  out.set(b.room, OFF.room);
  dv.setBigInt64(OFF.stamp, b.stamp, true);
  dv.setBigUint64(OFF.nonce, b.nonce, true);
  dv.setUint32(OFF.info, b.info, true);
  dv.setUint16(OFF.type, b.type, true);
  dv.setInt16(OFF.length, b.length, true);
  out.set(b.author, OFF.author);
  out.set(b.sig, OFF.sig);
  out.set(b.prev, OFF.prev);
  out.set(b.data, OFF.data);
  return out;
}

export function decodeBlock(bytes) {
  if (bytes.length !== BLOCK_SIZE) {
    throw new Error(`block has ${bytes.length} bytes, want ${BLOCK_SIZE}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    room: bytes.slice(OFF.room, OFF.room + 8),
    stamp: dv.getBigInt64(OFF.stamp, true),
    nonce: dv.getBigUint64(OFF.nonce, true),
    info: dv.getUint32(OFF.info, true),
    type: dv.getUint16(OFF.type, true),
    length: dv.getInt16(OFF.length, true),
    author: bytes.slice(OFF.author, OFF.author + 32),
    sig: bytes.slice(OFF.sig, OFF.sig + 64),
    prev: bytes.slice(OFF.prev, OFF.prev + 64),
    data: bytes.slice(OFF.data, OFF.data + MAX_DATA_LENGTH),
  };
}

// Grava texto em data. O limite é em bytes UTF-8, não em caracteres
export function uploadString(b, text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_DATA_LENGTH) {
    throw new Error(`message has ${bytes.length} bytes; the maximum is ${MAX_DATA_LENGTH}`);
  }
  b.data = new Uint8Array(MAX_DATA_LENGTH);
  b.data.set(bytes);
  b.length = bytes.length;
  b.type = DataType.TEXT;
}

export function textOf(b) {
  if (b.type !== DataType.TEXT || b.length < 0 || b.length > MAX_DATA_LENGTH) return null;
  return new TextDecoder().decode(b.data.subarray(0, b.length));
}

// secretKey: os 64 bytes do nacl.sign.keyPair. Preenche author e sig
export function signBlock(b, secretKey) {
  b.author = secretKey.slice(32, 64);
  b.sig = new Uint8Array(64);
  b.sig = nacl().sign.detached(encodeBlock(b), secretKey);
  return encodeBlock(b);
}

// Confere só a assinatura (o validator confere o resto)
export function verifyBlock(b) {
  const unsigned = { ...b, sig: new Uint8Array(64) };
  return nacl().sign.detached.verify(encodeBlock(unsigned), b.sig, b.author);
}

// Bloco seguinte à cabeça (ou o primeiro, se head for null). O carimbo nunca fica atrás do da cabeça, para relógios
// desencontrados não derrubarem o envio
export function nextBlock(head, nowNs = BigInt(Date.now()) * 1_000_000n) {
  const b = emptyBlock();
  if (head) {
    b.room = head.room.slice();
    b.prev = head.sig.slice();
    b.stamp = nowNs > head.stamp ? nowNs : head.stamp + 1n;
  } else {
    b.room = DEFAULT_ROOM.slice();
    b.stamp = nowNs;
  }
  const n = nacl().randomBytes(8);
  b.nonce = new DataView(n.buffer).getBigUint64(0, true);
  return b;
}

// Bits zero à esquerda, do bit mais alto do primeiro byte em diante (CountLeadingZeroBits no Go)
export function leadingZeroBits(bytes) {
  let n = 0;
  for (const x of bytes) {
    if (x !== 0) return n + Math.clz32(x) - 24;
    n += 8;
  }
  return n;
}

export const hasWork = (b, workBits) => leadingZeroBits(b.sig) >= workBits;

// Assina o bloco com o author que ele já tem (sem trocá-lo pela chave que assina) e devolve os bytes
function signKeepingAuthor(b, secretKey) {
  b.sig = new Uint8Array(64);
  b.sig = nacl().sign.detached(encodeBlock(b), secretKey);
  return encodeBlock(b);
}

// Minera como o Mine do Go: assina variando o nonce, a partir do valor atual e de um em um, até a assinatura começar
// com workBits bits zero. Não troca o author. Devolve os bytes
export function mineBlockSync(b, secretKey, workBits) {
  for (;;) {
    const bytes = signKeepingAuthor(b, secretKey);
    if (hasWork(b, workBits)) return bytes;
    b.nonce = (b.nonce + 1n) & U64;
  }
}

// A mesma mineração, em fatias de sliceMs com uma pausa entre elas, para a página continuar respondendo. onProgress
// recebe o número de tentativas; se isCancelled() ficar verdadeiro entre duas fatias, devolve null
export async function mineBlock(b, secretKey, workBits, { onProgress, isCancelled, sliceMs = 30 } = {}) {
  let tries = 0;
  for (;;) {
    const t0 = Date.now();
    while (Date.now() - t0 < sliceMs) {
      const bytes = signKeepingAuthor(b, secretKey);
      tries++;
      if (hasWork(b, workBits)) {
        onProgress?.(tries);
        return bytes;
      }
      b.nonce = (b.nonce + 1n) & U64;
    }
    onProgress?.(tries);
    await new Promise((r) => setTimeout(r, 0));
    if (isCancelled?.()) return null;
  }
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Impressão digital da cadeia até este bloco: os primeiros bytes da assinatura dele, em hex. Como cada assinatura cobre
// o prev, ela compromete todo o histórico anterior (bizas.Fingerprint no Go)
export function fingerprint(block) {
  return hex(block.sig.subarray(0, FINGERPRINT_SIZE));
}

export function hex(bytes) {
  return Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(s) {
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
