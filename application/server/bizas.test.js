// Prova que o JS da página serializa e assina igual ao Go, pelo vetor de teste compartilhado
// (application/bizas/testdata/vector.txt, gravado pelo teste Go). Rodar da raiz do repositório:
//   deno test --allow-read application/server/bizas.test.js
import "./static/nacl-fast.min.js";
import {
  BLOCK_SIZE, DEFAULT_ROOM, decodeBlock, emptyBlock, encodeBlock, fingerprint, fromHex, hex,
  nextBlock, signBlock, textOf, uploadString, verifyBlock,
} from "./static/bizas.js";

const here = new URL(".", import.meta.url);
const vectorText = await Deno.readTextFile(new URL("../bizas/testdata/vector.txt", here));
const V = Object.fromEntries(
  vectorText.split("\n").filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1)];
  }),
);
for (const k of ["pub", "genesis", "block1", "fingerprint"]) {
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

// A mesma cadeia que testChain monta em application/bizas/bizas_test.go
function testChain() {
  const kp = testKey();
  const g = emptyBlock();
  g.room = DEFAULT_ROOM.slice();
  g.stamp = 1_763_490_000_123_456_789n;
  g.nonce = 0x0102030405060708n;
  g.info = 0xA1B2C3D4;
  uploadString(g, "genesis");
  const gBytes = signBlock(g, kp.secretKey);

  const b = emptyBlock();
  b.room = g.room.slice();
  b.prev = g.sig.slice();
  b.stamp = 1_763_490_001_000_000_000n;
  b.nonce = 42n;
  b.info = 7;
  uploadString(b, TEST_TEXT);
  const bBytes = signBlock(b, kp.secretKey);
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
