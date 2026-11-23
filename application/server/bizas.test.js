// Prova que o JS da página serializa e assina igual ao Go, pelo vetor de teste compartilhado
// (application/bizas/testdata/vector.txt, gravado pelo teste Go). Rodar da raiz do repositório:
//   deno test --allow-read application/server/bizas.test.js
import "./static/nacl-fast.min.js";
import {
  BLOCK_SIZE, DEFAULT_ROOM, MAX_WORK_BITS, decodeBlock, emptyBlock, encodeBlock, fingerprint, fromHex, hasWork, hex,
  leadingZeroBits, mineBlock, mineBlockSync, nextBlock, signBlock, textOf, uploadString, verifyBlock,
} from "./static/bizas.js";

const here = new URL(".", import.meta.url);
const vectorText = await Deno.readTextFile(new URL("../bizas/testdata/vector.txt", here));
const V = Object.fromEntries(
  vectorText.split("\n").filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1)];
  }),
);
for (const k of ["pub", "genesis", "block1", "fingerprint", "nonces"]) {
  if (!V[k]) throw new Error(`test vector is missing key ${k}`);
}

// O mesmo texto de application/bizas/bizas_test.go: tem um caractere de 3 bytes em UTF-8
const TEST_TEXT = "Hello, Bizas! ✓";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function testKey() {
  const seed = new Uint8Array(32).map((_, i) => i);
  return globalThis.nacl.sign.keyPair.fromSeed(seed);
}

// testWorkBits do block_test.go: o N do gênese do vetor
const TEST_WORK_BITS = 8;

// A mesma cadeia que testChain monta em application/bizas/block_test.go, com os dois blocos minerados a partir do nonce
// inicial, de um em um: o JS tem de chegar aos mesmos nonces que o Go
let cachedChain = null;
function testChain() {
  return cachedChain ??= buildTestChain();
}
function buildTestChain() {
  const kp = testKey();
  const g = emptyBlock();
  g.room = DEFAULT_ROOM.slice();
  g.stamp = 1_763_490_000_123_456_789n;
  g.nonce = 0x0102030405060708n;
  g.info = TEST_WORK_BITS;
  g.author = kp.publicKey.slice();
  uploadString(g, "genesis");
  const gBytes = mineBlockSync(g, kp.secretKey, TEST_WORK_BITS);

  const b = emptyBlock();
  b.room = g.room.slice();
  b.prev = g.sig.slice();
  b.stamp = 1_763_490_001_000_000_000n;
  b.nonce = 42n;
  b.info = 7;
  b.author = kp.publicKey.slice();
  uploadString(b, TEST_TEXT);
  const bBytes = mineBlockSync(b, kp.secretKey, TEST_WORK_BITS);
  return { kp, g, gBytes, b, bBytes };
}

Deno.test("public key matches the vector", () => {
  assert(hex(testKey().publicKey) === V.pub, "pub differs from the vector");
});

Deno.test("bytes and signatures match the vector", () => {
  const { gBytes, bBytes } = testChain();
  assert(gBytes.length === BLOCK_SIZE, "size");
  assert(hex(gBytes) === V.genesis, `genesis differs:\n js     ${hex(gBytes)}\n vector ${V.genesis}`);
  assert(hex(bBytes) === V.block1, `block1 differs:\n js     ${hex(bBytes)}\n vector ${V.block1}`);
});

Deno.test("mining reaches the same nonces as Go, and the work is there", () => {
  const { g, b } = testChain();
  assert(`${g.nonce},${b.nonce}` === V.nonces, `nonces: js ${g.nonce},${b.nonce}, vector ${V.nonces}`);
  assert(hasWork(g, TEST_WORK_BITS) && hasWork(b, TEST_WORK_BITS), "mined signatures lack the work");
  assert(leadingZeroBits(Uint8Array.of(0, 0, 0x10, 0xff)) === Number(V.clz), "leadingZeroBits differs from Go");
  assert(leadingZeroBits(new Uint8Array(4)) === 32 && leadingZeroBits(Uint8Array.of(0x80)) === 0, "edges");
  assert(MAX_WORK_BITS === 20, "MAX_WORK_BITS differs from MaxWorkBits in Go");
});

Deno.test("async mining: same result as the sync one, reports progress, can be cancelled", async () => {
  const kp = testKey();
  const make = () => {
    const x = nextBlock(null, 1_000n);
    x.nonce = 7n;
    x.info = 6;
    x.author = kp.publicKey.slice();
    uploadString(x, "async");
    return x;
  };
  const a = make(), s = make();
  let reported = 0;
  const bytes = await mineBlock(a, kp.secretKey, 6, { onProgress: (n) => { reported = n; }, sliceMs: 1 });
  mineBlockSync(s, kp.secretKey, 6);
  assert(a.nonce === s.nonce && hex(bytes) === hex(encodeBlock(s)), "async and sync mining differ");
  assert(reported === Number(a.nonce - 7n) + 1, `progress: ${reported} tries for nonce ${a.nonce}`);
  assert(verifyBlock(a), "mined block does not verify");
  // Cancelado logo depois da primeira fatia: devolve null (16 bits levam muitas fatias de 1 ms)
  const c = make();
  assert(await mineBlock(c, kp.secretKey, 16, { isCancelled: () => true, sliceMs: 1 }) === null, "not cancelled");
});

Deno.test("fingerprint matches the vector (same as Go)", () => {
  const { b } = testChain();
  assert(fingerprint(b) === V.fingerprint, `fingerprint: js ${fingerprint(b)}, vector ${V.fingerprint}`);
  assert(fingerprint(decodeBlock(fromHex(V.block1))) === V.fingerprint, "fingerprint of the decoded block");
});

Deno.test("decodes and verifies the vector blocks", () => {
  for (const k of ["genesis", "block1"]) {
    const raw = fromHex(V[k]);
    const b = decodeBlock(raw);
    assert(hex(encodeBlock(b)) === V[k], `${k}: round trip changed the bytes`);
    assert(verifyBlock(b), `${k}: signature rejected`);
  }
  const b1 = decodeBlock(fromHex(V.block1));
  assert(textOf(b1) === TEST_TEXT, "text");
  assert(b1.length === 17, `"${TEST_TEXT}" has 17 UTF-8 bytes`);
});

Deno.test("sabotage: a changed byte fails the signature", () => {
  for (const off of [0, 8, 30, 32, 128, 192, 511]) {
    const raw = fromHex(V.block1);
    raw[off] ^= 1;
    assert(!verifyBlock(decodeBlock(raw)), `changed byte ${off} passed`);
  }
});

Deno.test("the 320 limit is in UTF-8 bytes", () => {
  const b = emptyBlock();
  uploadString(b, "a".repeat(320));
  let threw = false;
  try {
    uploadString(b, "é".repeat(161)); // 322 bytes
  } catch {
    threw = true;
  }
  assert(threw, "accepted 322 bytes");
});

Deno.test("nextBlock chains and never goes back in time", () => {
  const { b } = testChain();
  const n = nextBlock(b, 5n); // relógio local atrasado
  assert(n.stamp === b.stamp + 1n, "stamp went backwards");
  assert(hex(n.prev) === hex(b.sig), "prev");
  assert(hex(n.room) === hex(b.room), "room");
  const first = nextBlock(null, 10n);
  assert(hex(first.prev) === "00".repeat(64) && first.stamp === 10n, "genesis");
});

Deno.test("message time: age by default, real date after set-date, nothing for an earlier session", async () => {
  const { formatAge, formatWhen } = await import("./static/when.js");
  const s = 1_000_000_000n;
  assert(formatAge(10n * s) === "just now", "10 s");
  assert(formatAge(5n * 60n * s) === "5 min ago", "5 min");
  assert(formatAge(3n * 3600n * s) === "3 h ago", "3 h");
  assert(formatAge(2n * 86400n * s) === "2 d ago", "2 d");

  // Placa achando que é 1970: a idade continua certa
  const now = 10_000n * s;
  assert(formatWhen(now - 120n * s, { now, runStart: 0n }) === "2 min ago", "age on a 1970 clock");
  // Carimbo um pouco à frente (dentro da tolerância) não vira idade negativa
  assert(formatWhen(now + 2n * s, { now, runStart: 0n }) === "just now", "slightly ahead");
  // set-date: hora real − hora da placa
  const real = BigInt(Date.UTC(2030, 0, 2, 3, 4, 5)) * 1_000_000n;
  const shown = formatWhen(now - 60n * s, { now, runStart: 0n, realOffset: real - now });
  assert(shown === new Date(Date.UTC(2030, 0, 2, 3, 3, 5)).toLocaleString(), `calibrated: ${shown}`);
  // Sessão anterior: nem idade nem data
  assert(formatWhen(5n * s, { now, runStart: 6n * s, realOffset: real - now }) === "earlier session", "earlier session");
});

Deno.test("fraud test: defaults equal the normal block; edits re-sign or break the signature", async () => {
  const { composeBlock, parseField, FIELDS } = await import("./static/fraud.js");
  const kp = testKey();
  const head = nextBlock(null, 1_000n);
  signBlock(head, kp.secretKey);
  const base = { head, text: "hi", nowNs: 5_000n, nonce: 7n, keyPair: kp, resign: true };

  // Sem edições: é o bloco normal (mesmos campos), assinado por mim e válido
  const plain = composeBlock({ ...base, overrides: {} });
  assert(plain.bytes && Object.keys(plain.errors).length === 0, "plain block has errors");
  assert(verifyBlock(plain.effective), "plain block does not verify");
  assert(hex(plain.effective.prev) === hex(head.sig) && plain.effective.nonce === 7n && plain.effective.stamp === 5_000n, "defaults");
  const normal = nextBlock(head, 5_000n);
  normal.nonce = 7n;
  uploadString(normal, "hi");
  assert(hex(signBlock(normal, kp.secretKey)) === hex(plain.bytes), "not byte-equal to the normal flow");

  // Editar e assinar de novo: continua com assinatura válida, com o campo editado
  const stamp = composeBlock({ ...base, overrides: { stamp: "1" } });
  assert(stamp.effective.stamp === 1n && verifyBlock(stamp.effective), "re-signed edit");
  // Editar sem assinar de novo: a assinatura original não bate mais
  const broken = composeBlock({ ...base, resign: false, overrides: { stamp: "1" } });
  assert(broken.effective.stamp === 1n && !verifyBlock(broken.effective), "stale signature should not verify");
  // A assinatura digitada vale como foi digitada
  const forged = composeBlock({ ...base, overrides: { sig: "ab".repeat(64) } });
  assert(hex(forged.effective.sig) === "ab".repeat(64) && !verifyBlock(forged.effective), "typed signature");
  // Autor trocado: assinado com a minha chave, mas o autor diz ser outro
  const author = composeBlock({ ...base, overrides: { author: "11".repeat(32) } });
  assert(hex(author.effective.author) === "11".repeat(32) && !verifyBlock(author.effective), "impersonation");
  // length negativo e acima do limite chegam ao bloco (o validator é quem recusa)
  const neg = composeBlock({ ...base, overrides: { length: "-1" } });
  assert(neg.effective.length === -1 && neg.bytes, "negative length");

  // Campos inválidos: sem bytes e com o erro no campo certo
  for (const [field, text] of [["room", "abcd"], ["stamp", "1.5"], ["nonce", "-1"], ["info", "4294967296"], ["type", "65536"],
    ["length", "40000"], ["prev", "zz".repeat(64)], ["author", ""]]) {
    const r = composeBlock({ ...base, overrides: { [field]: text } });
    assert(r.bytes === null && r.errors[field], `${field}=${JSON.stringify(text)} was accepted`);
  }
  // Limites aceitos
  assert(parseField(FIELDS.find((f) => f.name === "stamp"), "9223372036854775807").value === 2n ** 63n - 1n, "i64 max");
  assert(parseField(FIELDS.find((f) => f.name === "nonce"), "18446744073709551615").value === 2n ** 64n - 1n, "u64 max");
  assert(!FIELDS.some((f) => f.name === "data"), "data must not be editable");
});

Deno.test("fraud test: stamp as a UTC date and room as text", async () => {
  const { composeBlock, parseField, formatField, convertText, stampToDate, dateToStamp, FIELDS } = await import("./static/fraud.js");
  const f = (n) => FIELDS.find((x) => x.name === n);

  // Data <-> ns sem perder nenhum nanossegundo, inclusive antes de 1970
  for (const ns of [0n, 1n, -1n, 1_795_391_185_133_797_236n, -1_000_000_001n, 2n ** 63n - 1n, -(2n ** 63n)]) {
    assert(dateToStamp(stampToDate(ns)) === ns, `round trip of ${ns}: ${stampToDate(ns)}`);
  }
  assert(stampToDate(1_893_456_245_123_456_789n) === "2030-01-01 00:04:05.123456789", stampToDate(1_893_456_245_123_456_789n));
  assert(dateToStamp("2030-01-01 00:04:05") === 1_893_456_245_000_000_000n, "no fraction");
  assert(dateToStamp("2030-01-01T00:04:05.5") === 1_893_456_245_500_000_000n, "T separator and short fraction");
  for (const bad of ["", "2030-02-30 00:00:00", "2030-13-01 00:00:00", "2030-01-01 24:00:00", "2030-01-01 00:60:00", "2030-01-01 00:00:60",
    "2030-1-1 00:00:00", "2030-01-01 00:00:00.1234567890", "abc"]) {
    assert(dateToStamp(bad) === null, `${bad} was accepted`);
  }
  // Fora do que cabe em int64 (ano 2300): recusado no campo
  assert(parseField(f("stamp"), "2300-01-01 00:00:00", { stampDate: true }).error?.key === "fraud.badDate", "year 2300");
  assert(parseField(f("stamp"), "1", { stampDate: true }).error, "ns text in date mode");
  assert(parseField(f("stamp"), "2030-01-01 00:00:00", {}).error, "date text in ns mode");

  // room: texto UTF-8 preenchido com zeros
  const room = parseField(f("room"), "Bizas", { roomText: true }).value;
  assert(hex(room) === "42697a6173000000", "room text");
  assert(hex(parseField(f("room"), "", { roomText: true }).value) === "00".repeat(8), "empty room");
  assert(hex(parseField(f("room"), "é", { roomText: true }).value) === "c3a9" + "00".repeat(6), "utf-8 room");
  assert(parseField(f("room"), "123456789", { roomText: true }).error?.key === "fraud.badText", "9 bytes");
  assert(parseField(f("room"), "ééééé", { roomText: true }).error?.key === "fraud.badText", "10 bytes of 5 chars");
  assert(formatField(f("room"), { room }, { roomText: true }) === "Bizas", "room shown as text");
  assert(formatField(f("room"), { room }, {}) === "42697a6173000000", "room shown as hex");
  // Bytes que não são texto UTF-8 aparecem em hex, sem perda
  const odd = new Uint8Array([0xff, 0xfe, 0, 0, 0, 0, 0, 0]);
  assert(formatField(f("room"), { room: odd }, { roomText: true }) === "fffe000000000000", "non-text room falls back to hex");

  // Trocar o modo reescreve o texto editado; o que não converte fica como está
  assert(convertText(f("room"), "42697a6173000000", {}, { roomText: true }) === "Bizas", "hex -> text");
  assert(convertText(f("room"), "Bizas", { roomText: true }, {}) === "42697a6173000000", "text -> hex");
  assert(convertText(f("room"), "fffe000000000000", {}, { roomText: true }) === "fffe000000000000", "hex that is not text stays");
  assert(convertText(f("room"), "zz", {}, { roomText: true }) === "zz", "invalid hex stays");
  assert(convertText(f("stamp"), "1893456245123456789", {}, { stampDate: true }) === "2030-01-01 00:04:05.123456789", "ns -> date");
  assert(convertText(f("stamp"), "2030-01-01 00:04:05.123456789", { stampDate: true }, {}) === "1893456245123456789", "date -> ns");

  // O bloco montado usa o texto no modo escolhido
  const kp = testKey();
  const head = nextBlock(null, 1_000n);
  signBlock(head, kp.secretKey);
  const base = { head, text: "hi", nowNs: 5_000n, nonce: 7n, keyPair: kp, resign: true };
  const block = composeBlock({ ...base, modes: { roomText: true, stampDate: true }, overrides: { room: "Other", stamp: "1970-01-01 00:00:10.000000001" } });
  assert(block.bytes && new TextDecoder().decode(block.effective.room.subarray(0, 5)) === "Other" && block.effective.stamp === 10_000_000_001n, "composed with the modes");
  assert(verifyBlock(block.effective), "re-signed with the edited fields");
});
