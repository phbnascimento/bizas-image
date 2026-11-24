// Enquetes (POLL e VOTE), espelho de application/bizas/poll.go: uma extensão que usa só os campos livres do bloco, type
// e info. O formato do bloco, a assinatura e o encadeamento não mudam. Os casos de aceite e recusa do vetor de teste
// (application/bizas/testdata/vector.txt) provam que o Go e o JS decidem igual
//
//   POLL  info: bit 0 = opções mutuamente exclusivas (os outros bits zero)
//         data: pergunta e opções em UTF-8, separadas por um byte 0
//   VOTE  info: índice (a partir de 0) do bloco da enquete
//         data: 2 bytes, o índice da opção e a ação (1 vota, 0 retira o voto)
import { DataType, MAX_DATA_LENGTH, hex } from "./bizas.js";

export const POLL_EXCLUSIVE = 1;
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 10;
export const VOTE_SIZE = 2;
export const VOTE_REVOKE = 0;
export const VOTE_CAST = 1;

const utf8 = new TextDecoder("utf-8", { fatal: true });

// Lê um bloco POLL: { question, options, exclusive }, ou null se o conteúdo não segue o formato (as mesmas regras do
// ParsePoll do Go: UTF-8 válido, nada vazio, de 2 a 10 opções, nenhuma repetida byte a byte, só o bit 0 no info)
export function parsePoll(b) {
  if (b.type !== DataType.POLL || (b.info & ~POLL_EXCLUSIVE) !== 0 || b.length < 0 || b.length > MAX_DATA_LENGTH) {
    return null;
  }
  const data = b.data.subarray(0, b.length);
  try { utf8.decode(data); } catch { return null; }
  const parts = [];
  let start = 0;
  for (let i = 0; i <= data.length; i++) {
    if (i === data.length || data[i] === 0) {
      parts.push(data.subarray(start, i));
      start = i + 1;
    }
  }
  if (parts.length < 1 + MIN_POLL_OPTIONS || parts.length > 1 + MAX_POLL_OPTIONS) return null;
  if (parts.some((p) => p.length === 0)) return null;
  const options = parts.slice(1).map((p) => hex(p));
  if (new Set(options).size !== options.length) return null;
  const text = (p) => utf8.decode(p);
  return { question: text(parts[0]), options: parts.slice(1).map(text), exclusive: (b.info & POLL_EXCLUSIVE) !== 0 };
}

// Bytes de data de uma enquete. Lança erro se não cabe em MAX_DATA_LENGTH
export function pollData(question, options) {
  const enc = new TextEncoder();
  const parts = [question, ...options].map((s) => enc.encode(s));
  const size = parts.reduce((n, p) => n + p.length, 0) + parts.length - 1;
  if (size > MAX_DATA_LENGTH) throw new Error(`poll has ${size} bytes; the maximum is ${MAX_DATA_LENGTH}`);
  const out = new Uint8Array(size);
  let off = 0;
  parts.forEach((p, i) => {
    if (i > 0) off++; // o separador já é 0
    out.set(p, off);
    off += p.length;
  });
  return out;
}

// Grava uma enquete no bloco (UploadPoll no Go)
export function uploadPoll(b, question, options, exclusive) {
  const data = pollData(question, options);
  b.data = new Uint8Array(MAX_DATA_LENGTH);
  b.data.set(data);
  b.length = data.length;
  b.type = DataType.POLL;
  b.info = exclusive ? POLL_EXCLUSIVE : 0;
}

// Grava um voto (cast) ou a retirada de um voto (UploadVote no Go)
export function uploadVote(b, poll, option, cast) {
  b.data = new Uint8Array(MAX_DATA_LENGTH);
  b.data[0] = option;
  b.data[1] = cast ? VOTE_CAST : VOTE_REVOKE;
  b.length = VOTE_SIZE;
  b.type = DataType.VOTE;
  b.info = poll;
}

// Lê um bloco VOTE: { poll, option, cast }, ou null se não é um VOTE de 2 bytes com ação 0 ou 1
export function parseVote(b) {
  if (b.type !== DataType.VOTE || b.length !== VOTE_SIZE || b.data[1] > VOTE_CAST) return null;
  return { poll: b.info, option: b.data[0], cast: b.data[1] === VOTE_CAST };
}

// Enquetes de uma cadeia e os votos ativos (Tally no Go). check confere o bloco de índice index sem mudar nada e
// devolve null ou o código de erro; apply registra um bloco que passou por check
export class Tally {
  constructor() {
    this.polls = new Map(); // índice do bloco -> { content, votes: Map(autor hex -> Set de opções) }
  }

  check(index, b) {
    if (b.type === DataType.POLL) {
      // O info do gênese é o N da prova de trabalho; ele não pode ser também a flag de uma enquete
      if (index === 0 || !parsePoll(b)) return "INVALID_POLL";
      return null;
    }
    if (b.type !== DataType.VOTE) return null;
    const v = parseVote(b);
    const p = v && this.polls.get(v.poll);
    if (!v || !p || v.option >= p.content.options.length) return "INVALID_VOTE";
    const mine = p.votes.get(hex(b.author));
    if (!v.cast) return mine?.has(v.option) ? null : "INVALID_VOTE";
    if (mine?.has(v.option) || (p.content.exclusive && mine?.size > 0)) return "DUPLICATE_VOTE";
    return null;
  }

  apply(index, b) {
    if (b.type === DataType.POLL) {
      this.polls.set(index, { content: parsePoll(b), votes: new Map() });
      return;
    }
    const v = parseVote(b);
    if (!v) return;
    const p = this.polls.get(v.poll);
    const who = hex(b.author);
    if (!v.cast) {
      p.votes.get(who)?.delete(v.option);
      if (p.votes.get(who)?.size === 0) p.votes.delete(who);
      return;
    }
    if (!p.votes.has(who)) p.votes.set(who, new Set());
    p.votes.get(who).add(v.option);
  }

  poll(index) {
    return this.polls.get(index)?.content ?? null;
  }

  // Votos ativos de cada opção da enquete do bloco index, ou null se ele não é uma enquete
  counts(index) {
    const p = this.polls.get(index);
    if (!p) return null;
    const out = p.content.options.map(() => 0);
    for (const set of p.votes.values()) for (const o of set) out[o]++;
    return out;
  }

  // Opções em que a chave authorHex tem voto ativo
  votesOf(index, authorHex) {
    return new Set(this.polls.get(index)?.votes.get(authorHex) ?? []);
  }
}
