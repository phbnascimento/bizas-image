// Ponta a ponta: dois "aparelhos" (user contexts isolados, cada um com o seu localStorage e a sua chave) no Firefox
// headless, via WebDriver BiDi. Chamado por scripts/e2e/browser.sh
const BASE = Deno.args[0];
const ws = new WebSocket("ws://127.0.0.1:9333/session");
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
function cmd(method: string, params: unknown = {}) {
  const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise<any>((r, j) => waiting.set(i, (m: any) => m.type === "error" ? j(new Error(`${method}: ${m.error} ${m.message}`)) : r(m.result)));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ev(ctx: string, expr: string) {
  const r = await cmd("script.evaluate", { expression: expr, target: { context: ctx }, awaitPromise: true });
  if (r.type === "exception") throw new Error(`exception in the page: ${JSON.stringify(r.exceptionDetails.text)}`);
  return r.result.value;
}
// O prazo cobre a prova de trabalho: o número de tentativas varia com o nonce inicial (aleatório), e em algumas
// execuções a mineração de um envio passou de 5 s
async function until(ctx: string, expr: string, what: string, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(ctx, expr)) return; await sleep(100); }
  throw new Error(`timed out waiting for: ${what}`);
}
await cmd("session.new", { capabilities: {} });
// skewMs desloca o relógio do aparelho (Date.now) antes de a página carregar. O carimbo assinado tem de vir do relógio
// do validator, e não do aparelho: com o relógio próprio, um aparelho adiantado seria recusado (TIMESTAMP_IN_FUTURE)
async function device(skewMs: number, seedHex?: string, confirm = true) {
  const { userContext } = await cmd("browser.createUserContext");
  const { context } = await cmd("browsingContext.create", { type: "tab", userContext });
  await cmd("script.addPreloadScript", {
    functionDeclaration: `() => { const real = Date.now; Date.now = () => real() + (${skewMs}); Object.defineProperty(navigator, "language", { get: () => "en-US" }); }`,
    contexts: [context],
  });
  await cmd("browsingContext.navigate", { context, url: BASE + "/", wait: "complete" });
  if (!confirm) return context; // fica na tela da chave
  await setup(context, seedHex);
  await until(context, `document.getElementById("status").textContent === "connected"`, "connect");
  return context;
}

// Primeira sessão: só a tela da chave aparece, sem conexão, até a pessoa confirmar. Com seedHex, cola a chave; sem ele,
// usa o dado. A chave pública mostrada tem de ser a do autor das mensagens
const shownPub = new Map<string, string>();
async function setup(ctx: string, seedHex?: string) {
  await until(ctx, `document.body.classList.contains("setup")`, "the key screen");
  const visible = await ev(ctx, `JSON.stringify({ header: getComputedStyle(document.querySelector("header")).display,
    setup: getComputedStyle(document.getElementById("setup")).display, status: document.getElementById("status").textContent,
    stored: localStorage.getItem("bizas.seed"), use: document.getElementById("s-use").disabled })`);
  const v = JSON.parse(visible);
  if (v.header !== "none" || v.setup !== "block" || v.stored !== null || !v.use) throw new Error(`key screen is wrong: ${visible}`);
  // O aviso e as duas bandeiras estão na tela da chave
  // A engrenagem fica na linha do título, à direita
  const row = JSON.parse(await ev(ctx, `JSON.stringify((() => { const g = document.querySelector("#setup .gear").getBoundingClientRect(),
    h = document.querySelector("#setup h1").getBoundingClientRect(), f = document.getElementById("s-form").getBoundingClientRect();
    return { dy: Math.abs((g.top + g.height / 2) - (h.top + h.height / 2)), right: Math.abs(g.right - f.right), above: g.bottom <= h.top }; })())`));
  if (row.dy > 3 || row.right > 2 || row.above) throw new Error(`the gear is not on the title line, at the right: ${JSON.stringify(row)}`);
  // A logo carregou e fica centralizada na tela da chave
  const hero = JSON.parse(await ev(ctx, `JSON.stringify((() => { const i = document.querySelector("#setup .hero"), b = i.getBoundingClientRect(), s = document.getElementById("setup").getBoundingClientRect();
    return { loaded: i.complete && i.naturalWidth === 900, off: Math.abs((b.left + b.width / 2) - (s.left + s.width / 2)), w: b.width,
      gap: document.querySelector("#setup h1").getBoundingClientRect().top - b.bottom, top: s.top }; })())`));
  // Centralizada só na horizontal (a tela começa no topo) e com um espaço entre a logo e o título
  if (!hero.loaded || hero.off > 1 || hero.w < 60 || hero.gap < 16 || hero.top > 1) throw new Error(`logo on the key screen: ${JSON.stringify(hero)}`);
  const top = JSON.parse(await ev(ctx, `JSON.stringify({ disclaimer: document.getElementById("disclaimer").textContent.trim(),
    visible: getComputedStyle(document.getElementById("disclaimer")).display, flags: [...document.querySelectorAll("#settings [data-lang]")].map(b => b.dataset.lang),
    gears: document.querySelectorAll("#setup .gear").length, qrHidden: document.getElementById("s-qrbox").hidden })`));
  if (top.disclaimer !== "DISCLAIMER: DO NOT SHARE YOUR PRIVATE KEY WITH ANYONE" || top.visible === "none") throw new Error(`disclaimer: ${JSON.stringify(top)}`);
  if (top.flags.join() !== "pt,en" || top.gears !== 1 || top.qrHidden !== true) throw new Error(`key screen controls: ${JSON.stringify(top)}`);
  const type = (t: string) => ev(ctx, `(() => { const k = document.getElementById("s-key"); k.value = ${JSON.stringify(t)}; k.dispatchEvent(new Event("input")); })()`);
  // Entradas inválidas não liberam o botão
  for (const bad of ["xyz", "ab".repeat(31), "zz".repeat(32), "ab".repeat(33)]) {
    await type("11".repeat(32)); // parte de uma chave válida: ao editar para inválida, o botão tem de voltar a desabilitar
    if (await ev(ctx, `document.getElementById("s-use").disabled`) !== false) throw new Error("a valid key did not enable the button");
    await type(bad);
    if (await ev(ctx, `document.getElementById("s-use").disabled`) !== true) throw new Error(`accepted a bad key: ${bad}`);
    if (await ev(ctx, `document.getElementById("s-pub").textContent`) !== "—") throw new Error("public key shown for a bad key");
    if (await ev(ctx, `document.getElementById("s-qrbox").hidden`) !== true) throw new Error("QR shown for a bad key");
  }
  if (seedHex) await type(seedHex); else await ev(ctx, `document.getElementById("s-dice").click()`);
  const typed = await ev(ctx, `document.getElementById("s-key").value`);
  if (!/^[0-9a-f]{64}$/.test(typed) || (seedHex && typed !== seedHex)) throw new Error(`bad private key in the field: ${typed}`);
  // O QR da chave privada aparece e lê de volta exatamente a chave do campo
  // O QR da privada só aparece quando a pessoa pede, e volta a ficar oculto ao mudar a chave
  const qr = () => ev(ctx, `JSON.stringify({ box: document.getElementById("s-qrbox").hidden, qr: document.getElementById("s-qr").hidden,
    svg: document.querySelectorAll("#s-qr svg").length, btn: document.getElementById("s-qrbtn").textContent })`).then(JSON.parse);
  let q = await qr();
  if (q.box !== false || q.qr !== true || q.svg !== 0 || q.btn !== "Show private key as QR code") throw new Error(`QR should start hidden: ${JSON.stringify(q)}`);
  await ev(ctx, `document.getElementById("s-qrbtn").click()`);
  q = await qr();
  if (q.qr !== false || q.svg !== 1 || q.btn !== "Hide QR code") throw new Error(`QR did not show: ${JSON.stringify(q)}`);
  const decoded = await decodeQr(await ev(ctx, `document.querySelector("#s-qr svg").outerHTML`));
  if (decoded !== typed) throw new Error(`private key QR reads ${decoded}, want ${typed}`);
  await ev(ctx, `document.getElementById("s-qrbtn").click()`);
  q = await qr();
  if (q.qr !== true || q.svg !== 0) throw new Error(`QR did not hide: ${JSON.stringify(q)}`);
  await ev(ctx, `document.getElementById("s-qrbtn").click()`);
  await type("22".repeat(32));
  q = await qr();
  if (q.qr !== true || q.svg !== 0) throw new Error(`QR stayed visible after the key changed: ${JSON.stringify(q)}`);
  await type(typed);
  const pub = await ev(ctx, `document.getElementById("s-pub").textContent`);
  if (!/^[0-9a-f]{64}$/.test(pub) || await ev(ctx, `document.getElementById("s-use").disabled`) !== false) throw new Error("no public key after the key was set");
  // Nada é gravado antes da confirmação
  if (await ev(ctx, `String(localStorage.getItem("bizas.seed"))`) !== "null") throw new Error("seed stored before confirming");
  await ev(ctx, `document.getElementById("s-use").click()`);
  if (await ev(ctx, `localStorage.getItem("bizas.seed")`) !== typed) throw new Error("seed not stored after confirming");
  shownPub.set(ctx, pub);
}
// Decodifica o SVG do QR com o zbarimg: reconstrói a matriz dos módulos escuros (comandos "M<x> <y>h1v1h-1z" do
// caminho), grava um PGM ampliado e devolve o texto lido
async function decodeQr(svgHtml: string): Promise<string> {
  const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(svgHtml)![1]);
  const k = 8, w = size * k;
  const px = new Uint8Array(w * w).fill(255);
  for (const m of svgHtml.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) px[(Number(m[2]) * k + y) * w + Number(m[1]) * k + x] = 0;
  }
  const file = `/tmp/bizas-qr-${crypto.randomUUID()}.pgm`;
  await Deno.writeFile(file, new Uint8Array([...new TextEncoder().encode(`P5\n${w} ${w}\n255\n`), ...px]));
  try {
    const out = await new Deno.Command("zbarimg", { args: ["--raw", "-q", file] }).output();
    if (!out.success) throw new Error(`zbarimg could not read the QR code (${new TextDecoder().decode(out.stderr).trim()})`);
    return new TextDecoder().decode(out.stdout).trim();
  } finally {
    await Deno.remove(file);
  }
}
const send = (ctx: string, text: string) => ev(ctx, `(() => { const t = document.getElementById("text"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input")); document.getElementById("send").click(); })()`);
const texts = (ctx: string) => ev(ctx, `JSON.stringify([...document.querySelectorAll(".msg .text")].map(e => e.textContent))`).then(JSON.parse);
const me = (ctx: string) => ev(ctx, `document.getElementById("me").textContent`);

// A atrasado 3 h, B adiantado 2 h
const SEED_B = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const A = await device(-3 * 3600_000), B = await device(2 * 3600_000, SEED_B);
console.log("device clocks: A -3 h, B +2 h");
// O teste só vale fora de contexto seguro: é assim que os celulares abrem http://<ip-da-placa>. Em localhost o
// navegador é mais permissivo
for (const c of [A, B]) {
  if (await ev(c, "window.isSecureContext") !== false) throw new Error("secure context: run through the LAN IP, not localhost");
}
console.log("isSecureContext=false on both devices");
// O style.css carregou: sem ele o body não é flex
if (await ev(A, "getComputedStyle(document.body).display") !== "flex") throw new Error("style.css was not applied");

// Sem contornos: cabeçalho, mensagens, formulário e barra de texto não têm borda; o foco da barra de texto desenha um anel
const borders = await ev(A, `JSON.stringify(["header", "form", "#text", "button", "footer"].map(sel => {
  const st = getComputedStyle(document.querySelector(sel));
  return [sel, ["Top", "Right", "Bottom", "Left"].map(side => st["border" + side + "Width"]).join(" ")];
}))`);
for (const [sel, widths] of JSON.parse(borders)) {
  if (widths !== "0px 0px 0px 0px") throw new Error(`${sel} has a border: ${widths}`);
}
// O :focus só vale na aba em primeiro plano
await cmd("browsingContext.activate", { context: A });
await ev(A, `document.getElementById("text").focus()`);
if (await ev(A, `getComputedStyle(document.getElementById("text")).outlineStyle`) !== "solid") throw new Error("the text bar has no focus ring");
await ev(A, `document.getElementById("text").blur()`);
const idA = await me(A), idB = await me(B);
console.log("ids", idA, idB);
if (idA === idB || !/^[0-9a-f]{8}$/.test(idA)) throw new Error("ids are equal or invalid");

// Prova de trabalho: com a cadeia vazia, quem envia cria o gênese e escolhe N (padrão 10, de 0 a 20). O teste usa 4,
// para cada mensagem custar poucas assinaturas
const WORK = 4;
for (const c of [A, B]) {
  const box = JSON.parse(await ev(c, `JSON.stringify({ hidden: document.getElementById("work-box").hidden,
    value: document.getElementById("work-bits").value, max: document.getElementById("work-bits").max,
    work: document.getElementById("work").textContent })`));
  if (box.hidden || box.value !== "10" || box.max !== "20" || box.work !== "—") throw new Error(`genesis bits field: ${JSON.stringify(box)}`);
}
const setBits = (ctx: string, v: string) => ev(ctx, `(() => { const i = document.getElementById("work-bits"); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input")); })()`);
await ev(A, `(() => { const t = document.getElementById("text"); t.value = "x"; t.dispatchEvent(new Event("input")); })()`);
for (const bad of ["21", "-1", "1.5", ""]) {
  await setBits(A, bad);
  if (await ev(A, `document.getElementById("send").disabled`) !== true) throw new Error(`send enabled with ${JSON.stringify(bad)} zero bits`);
}
await setBits(A, String(WORK));
if (await ev(A, `document.getElementById("send").disabled`) !== false) throw new Error(`send disabled with ${WORK} zero bits`);

await send(A, "Hello from A");
await until(B, `document.querySelectorAll(".msg").length === 1`, "B to see the 1st");
// Depois do gênese, ninguém escolhe N de novo, e o cabeçalho mostra o N da sala
for (const c of [A, B]) {
  if (await ev(c, `document.getElementById("work-box").hidden`) !== true) throw new Error("the zero-bits field is still visible after the genesis");
  if (await ev(c, `document.getElementById("work").textContent`) !== String(WORK)) throw new Error("the header does not show the room's zero bits");
}
await send(B, "<b>hi</b> from B");
await until(A, `document.querySelectorAll(".msg").length === 2`, "A to see the 2nd");
// XSS: o texto tem de aparecer literal, sem virar elemento
if (await ev(A, `document.querySelectorAll(".msg .text b").length`) !== 0) throw new Error("innerHTML!");

// Corrida: os dois enviam ao mesmo tempo sobre a mesma cabeça; o reenvio automático tem de resolver
await Promise.all([send(A, "race A"), send(B, "race B")]);
await until(A, `document.querySelectorAll(".msg").length === 4`, "A to see all 4", 40000);
await until(B, `document.querySelectorAll(".msg").length === 4`, "B to see all 4", 40000);
// Toda assinatura começa com WORK bits zero, e o info do gênese é WORK (o validator verify, no fim, confere de novo)
const blocksJson = JSON.parse(await ev(A, `fetch("/chain.json").then(r => r.text())`));
const zeroBits = (sigHex: string) => { let n = 0; for (const ch of sigHex) { const v = parseInt(ch, 16); if (v) return n + Math.clz32(v) - 28; n += 4; } return n; };
if (blocksJson[0].info !== WORK || !blocksJson.every((b: { sig: string }) => zeroBits(b.sig) >= WORK)) throw new Error(`proof of work missing: ${JSON.stringify(blocksJson.map((b: { info: number; sig: string }) => [b.info, b.sig.slice(0, 4)]))}`);
console.log("zero bits per block:", blocksJson.map((b: { sig: string }) => zeroBits(b.sig)).join(" "));
// "ver": o painel do bloco 1 mostra os campos que o server exporta no /chain.json, e o bloco 0 é o gênese
await ev(A, `document.querySelectorAll(".msg .view")[1].click()`);
await until(A, `!document.getElementById("block-panel").hidden`, "the block panel");
const shown = JSON.parse(await ev(A, `JSON.stringify(Object.fromEntries([...document.querySelectorAll("#b-fields .bfield")].map(f => [f.querySelector(".bname").textContent, f.querySelector("code").textContent])))`));
const b1 = blocksJson[1];
for (const k of ["stamp", "nonce", "info", "length", "author", "sig", "prev"]) {
  if (shown[k] !== String(b1[k])) throw new Error(`block panel ${k}: ${shown[k]} != ${b1[k]}`);
}
if (await ev(A, `document.querySelectorAll("#b-fields > hr").length`) !== Object.keys(shown).length - 1) throw new Error("block panel: one hr between fields");
if (shown.prev !== blocksJson[0].sig || await ev(A, `document.getElementById("b-title").textContent`) !== "Block 1") throw new Error("block panel title or prev");
await ev(A, `document.querySelectorAll(".msg .view")[0].click()`);
if (!(await ev(A, `document.getElementById("b-fields").textContent`)).includes("genesis")) throw new Error("block panel: genesis");
await ev(A, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
if (!await ev(A, `document.getElementById("block-panel").hidden`)) throw new Error("block panel did not close");
console.log("block panel: fields of block 1 match /chain.json");
const ta = await texts(A), tb = await texts(B);
console.log("A:", ta); console.log("B:", tb);
if (JSON.stringify(ta) !== JSON.stringify(tb)) throw new Error("A and B diverge");
// Mesmo histórico, mesma impressão digital, e ela é a assinatura da cabeça (16 hex)
const fpA = await ev(A, `document.getElementById("fingerprint").textContent`);
const fpB = await ev(B, `document.getElementById("fingerprint").textContent`);
console.log("fingerprint A:", fpA, "B:", fpB);
if (fpA !== fpB || !/^[0-9a-f]{16}$/.test(fpA)) throw new Error("fingerprints differ or are malformed");

// Hora: sem set-date, a página mostra a idade da mensagem, medida no relógio da placa (os aparelhos têm o relógio
// errado)
const whens = (ctx: string) => ev(ctx, `JSON.stringify([...document.querySelectorAll(".msg .when")].map(e => e.textContent))`).then(JSON.parse);
const wA = await whens(A), wB = await whens(B);
console.log("times before set-date:", wA);
if (![...wA, ...wB].every((w: string) => w === "just now")) throw new Error(`expected "just now" everywhere: ${wA} / ${wB}`);

// set-date: o comando de manutenção de verdade (binário local ou docker exec), e as páginas abertas se adaptam sem
// recarregar
const SET_DATE_CMD = Deno.env.get("SET_DATE_CMD");
if (SET_DATE_CMD) {
  const [prog, ...pre] = SET_DATE_CMD.split(" ");
  const out = await new Deno.Command(prog, { args: [...pre, "set-date", "2030-01-02-00-04-05"] }).output();
  console.log("set-date:", new TextDecoder().decode(out.stdout).trim(), new TextDecoder().decode(out.stderr).trim());
  if (!out.success) throw new Error("set-date failed");
  for (const c of [A, B]) {
    await until(c, `[...document.querySelectorAll(".msg .when")].every(e => e.textContent.includes("2030"))`, "dates after set-date");
  }
  console.log("times after set-date:", await whens(A));
}

// Recarregar: a identidade persiste e o histórico volta do server
await cmd("browsingContext.reload", { context: A, wait: "complete" });
await until(A, `document.getElementById("status").textContent === "connected" && document.querySelectorAll(".msg").length === 4`, "A reloaded");
if (SET_DATE_CMD && !(await whens(A)).every((w: string) => w.includes("2030"))) throw new Error("calibration lost on reload");
if (await me(A) !== idA) throw new Error("identity changed on reload");

if (await ev(A, `[...document.querySelectorAll(".msg")].every(e => getComputedStyle(e).borderTopWidth === "0px" && getComputedStyle(e).borderLeftWidth === "0px")`) !== true) throw new Error("a message has a border");

// Painel da chave: clicar no autor abre o painel com a chave completa, o índice do 1º bloco e a contagem. O nome fica
// só no navegador, aparece nas mensagens e sobrevive ao recarregar
if (await ev(A, `document.getElementById("panel").hidden`) !== true) throw new Error("panel open at start");
await ev(A, `document.getElementById("me").click()`);
const panel = JSON.parse(await ev(A, `JSON.stringify({ hidden: document.getElementById("panel").hidden,
  key: document.getElementById("p-key").textContent, first: document.getElementById("p-first").textContent,
  count: document.getElementById("p-count").textContent, title: document.getElementById("me").title,
  keyColor: getComputedStyle(document.getElementById("p-key")).color, meColor: getComputedStyle(document.getElementById("me")).color,
  borderPanel: getComputedStyle(document.getElementById("panel")).borderTopWidth })`));
console.log("panel:", panel);
if (panel.hidden || !/^[0-9a-f]{64}$/.test(panel.key) || panel.key !== panel.title) throw new Error("panel has no full key");
if (panel.key !== shownPub.get(A)) throw new Error("the public key confirmed on the first screen is not the author");
if (!panel.key.startsWith(idA) || panel.count !== "2" || !panel.first.startsWith("#")) throw new Error("panel stats are wrong");
if (panel.keyColor !== panel.meColor) throw new Error("panel key color differs from the author color");
if (panel.borderPanel !== "0px") throw new Error("panel has a border");
await ev(A, `(() => { const i = document.getElementById("p-name"); i.value = "Alice"; i.dispatchEvent(new Event("input")); })()`);
if (await ev(A, `[...document.querySelectorAll(".msg.mine .who")].every(e => e.textContent === "Alice")`) !== true) throw new Error("name not applied to the messages");
if (await me(A) !== "Alice") throw new Error("name not applied to the nav");
// Nota: texto livre, com quebras de linha e HTML literal, guardado só no navegador e por chave
const NOTE = "Met at the lab\n<b>not bold</b> & \"quoted\"";
await ev(A, `(() => { const n = document.getElementById("p-note"); n.value = ${JSON.stringify(NOTE)}; n.dispatchEvent(new Event("input")); })()`);
const stored = JSON.parse(await ev(A, `localStorage.getItem("bizas.notes")`));
if (Object.values(stored).join() !== NOTE || Object.keys(stored).length !== 1) throw new Error(`stored notes: ${JSON.stringify(stored)}`);
// Slider de matiz: 120 dá hsl(120 55% var(--who-l))
const probe = `(() => { const p = document.createElement("span"); p.style.color = "hsl(120 55% var(--who-l))"; document.body.append(p);
  const c = getComputedStyle(p).color; p.remove(); return c; })()`;
const green = await ev(A, probe);
const colorOfMe = () => ev(A, `getComputedStyle(document.getElementById("me")).color`);
const before = await colorOfMe();
await ev(A, `(() => { const r = document.getElementById("p-hue"); r.value = "120"; r.dispatchEvent(new Event("input", { bubbles: true })); })()`);
if (await colorOfMe() !== green || green === before) throw new Error(`slider did not set the color: ${await colorOfMe()} vs ${green}`);
if (await ev(A, `getComputedStyle(document.getElementById("p-key")).color`) !== green) throw new Error("panel key did not follow");
if (await ev(A, `[...document.querySelectorAll(".msg.mine .who")].every(e => getComputedStyle(e).color === ${JSON.stringify(green)})`) !== true) throw new Error("messages did not follow the slider");
const hover = await ev(A, `getComputedStyle(document.getElementById("me")).cursor`);
if (hover !== "pointer") throw new Error("author is not clickable");
await ev(A, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
if (await ev(A, `document.getElementById("panel").hidden`) !== true) throw new Error("Escape did not close the panel");
await cmd("browsingContext.reload", { context: A, wait: "complete" });
await until(A, `document.querySelectorAll(".msg").length === 4`, "A reloaded again");
if (await me(A) !== "Alice") throw new Error("name lost on reload");
await ev(A, `document.getElementById("me").click()`);
if (await ev(A, `document.getElementById("p-note").value`) !== NOTE) throw new Error("note lost on reload");
if (await ev(A, `document.querySelectorAll("#panel b").length`) !== 0) throw new Error("the note became HTML");
await ev(A, `document.getElementById("p-close").click()`);
if (await colorOfMe() !== green) throw new Error("color lost on reload");
await ev(A, `document.getElementById("me").click()`);
await ev(A, `document.getElementById("p-reset").click()`);
if (await colorOfMe() !== before) throw new Error("reset did not restore the default color");
await ev(A, `document.getElementById("p-close").click()`);
// Outro autor: o painel dele mostra a chave dele e o outro aparelho não herda o nome
await ev(A, `document.querySelector(".msg:not(.mine) .who").click()`);
const other = JSON.parse(await ev(A, `JSON.stringify({ key: document.getElementById("p-key").textContent, name: document.getElementById("p-name").value, note: document.getElementById("p-note").value, count: document.getElementById("p-count").textContent })`));
if (!other.key.startsWith(idB) || other.name !== "" || other.note !== "" || other.count !== "2") throw new Error(`wrong panel for the other author: ${JSON.stringify(other)}`);
await ev(A, `document.getElementById("p-close").click()`);
// Apagar o texto remove a nota do armazenamento (e espaços em branco não contam como nota)
await ev(A, `document.getElementById("me").click()`);
await ev(A, `(() => { const n = document.getElementById("p-note"); n.value = "  \\n "; n.dispatchEvent(new Event("input")); })()`);
if (await ev(A, `localStorage.getItem("bizas.notes")`) !== "{}") throw new Error("a blank note was kept");
await ev(A, `(() => { const n = document.getElementById("p-note"); n.value = ${JSON.stringify(NOTE)}; n.dispatchEvent(new Event("input")); })()`);
await ev(A, `document.getElementById("p-close").click()`);
// A chave colada em B vale: a identidade é a derivada da seed informada
await ev(B, `document.getElementById("me").click()`);
if (await ev(B, `document.getElementById("p-key").textContent`) !== shownPub.get(B)) throw new Error("B's identity is not the pasted key");
await ev(B, `document.getElementById("p-close").click()`);
if (await ev(B, `document.getElementById("me").textContent`) !== idB) throw new Error("name leaked to the other device");

// Língua: a tela da chave (num aparelho que não confirma) e o chat trocam pelas bandeiras, e a escolha persiste
const openSettings = (ctx: string, scope: string) => ev(ctx, `document.querySelector("${scope} .gear").click()`);
const text = (ctx: string, sel: string) => ev(ctx, `document.querySelector(${JSON.stringify(sel)}).textContent.trim()`);
const C = await device(0, undefined, false);
await until(C, `document.body.classList.contains("setup")`, "C on the key screen");
await openSettings(C, "#setup");
if (await ev(C, `getComputedStyle(document.getElementById("settings")).display`) === "none") throw new Error("the gear did not open the settings on the key screen");
await ev(C, `document.querySelector('#settings [data-lang="pt"]').click()`);
if (await text(C, "#disclaimer") !== "AVISO: NÃO COMPARTILHE SUA CHAVE PRIVADA COM NINGUÉM") throw new Error("disclaimer not translated");
if (await text(C, 'label[for="s-key"]') !== "Chave privada" || await text(C, "#s-use") !== "Usar esta chave") throw new Error("key screen not translated");
if (await ev(C, `document.documentElement.lang`) !== "pt-BR") throw new Error("html lang is not pt-BR");
if (await ev(C, `document.getElementById("s-key").placeholder`) !== "64 caracteres hexadecimais") throw new Error("placeholder not translated");
await ev(C, `(() => { const k = document.getElementById("s-key"); k.value = "xyz"; k.dispatchEvent(new Event("input")); })()`);
if (!(await text(C, "#s-err")).startsWith("Uma chave privada tem 64")) throw new Error("error not translated");
await ev(C, `document.querySelector('#settings [data-lang="en"]').click()`);
if (!(await text(C, "#s-err")).startsWith("A private key is 64")) throw new Error("error did not follow back to English");
await ev(C, `document.querySelector('#settings [data-lang="pt"]').click()`);
await cmd("browsingContext.reload", { context: C, wait: "complete" });
await until(C, `document.body.classList.contains("setup")`, "C reloaded on the key screen");
if (await text(C, "#disclaimer") !== "AVISO: NÃO COMPARTILHE SUA CHAVE PRIVADA COM NINGUÉM") throw new Error("language lost on reload");
await cmd("browsingContext.close", { context: C });

if (await text(A, "#status") !== "connected" || await text(A, "footer span") !== "Your private key never leaves this browser :)") throw new Error("chat is not in English");
// Rodapé: "... :) • Baixar a chain • em JSON", com os separadores
const footer = () => ev(A, `document.querySelector("footer").textContent.replace(/\\s+/g, " ").trim()`);
if (await footer() !== "Your private key never leaves this browser :) • Download the chain • as JSON") throw new Error(`footer: ${await footer()}`);
// A caixa da mensagem tem o tamanho do texto quando ele é curto, até o máximo de 640 px
const bubbleW = (txt: string) => ev(A, `(() => { const m = document.querySelector(".msg").cloneNode(true); m.querySelector(".text").textContent = ${JSON.stringify(txt)};
  document.getElementById("log").append(m); const w = m.getBoundingClientRect().width; m.remove(); return w; })()`);
const wShort = await bubbleW("hi"), wLong = await bubbleW("long text ".repeat(60));
if (!(wShort < 300 && wLong === 640)) throw new Error(`message box width: short ${wShort}, long ${wLong}`);
// Os rótulos do painel não dizem onde ficam salvos
await ev(A, `document.getElementById("me").click()`);
const panelLabels = await ev(A, `[...document.querySelectorAll("#panel label")].map(l => l.textContent).join("|")`);
if (panelLabels !== "Name|Color|Note (visible only to you)") throw new Error(`panel labels: ${panelLabels}`);
await ev(A, `document.getElementById("p-close").click()`);
await openSettings(A, "header");
await ev(A, `document.querySelector("#settings [data-lang='pt']").click()`);
const pt = JSON.parse(await ev(A, `JSON.stringify({ status: document.getElementById("status").textContent, room: document.querySelector("header .info span").textContent,
  send: document.getElementById("send").textContent, ph: document.getElementById("text").placeholder, lang: document.documentElement.lang,
  json: document.querySelector("footer a:last-of-type").textContent, whens: [...document.querySelectorAll(".msg .when")].map(e => e.textContent),
  pressed: [...document.querySelectorAll("#settings [data-lang]")].map(b => b.getAttribute("aria-pressed")).join() })`));
console.log("chat in pt:", pt);
if (pt.status !== "conectado" || pt.room !== "sala" || pt.send !== "Enviar" || pt.ph !== "Mensagem (assinada neste aparelho)" || pt.lang !== "pt-BR" || pt.json !== "em JSON" || pt.pressed !== "true,false") throw new Error("chat not translated");
if (!pt.whens.every((w: string) => SET_DATE_CMD ? w.includes("2030") : w === "agora mesmo")) throw new Error(`times not translated: ${pt.whens}`);
if (await text(A, "footer a") !== "Baixar a chain") throw new Error("pt footer link");
if (await footer() !== "Sua chave privada nunca sai deste navegador :) • Baixar a chain • em JSON") throw new Error(`pt footer: ${await footer()}`);
if (await text(A, "header .info:nth-of-type(4) span") !== "fingerprint") throw new Error("pt fingerprint label");
await ev(A, `document.querySelector(".msg .who").click()`);
const ptLabels = await ev(A, `[...document.querySelectorAll("#panel label")].map(l => l.textContent).join("|")`);
if (ptLabels !== "Nome|Cor|Nota (visível só para você)") throw new Error(`pt panel labels: ${ptLabels}`);
await ev(A, `document.getElementById("p-close").click()`);
await ev(A, `document.querySelector(".msg .who").click()`);
if (await text(A, "#panel h2") !== "Chave pública" || await text(A, "#panel dt") !== "Primeiro bloco" || !(await text(A, "#p-first")).includes("carimbo")) throw new Error("panel not translated");
await ev(A, `document.getElementById("p-close").click()`);
// A língua persiste ao recarregar; e uma mensagem rejeitada ou o estado de conexão seguem a língua atual
await cmd("browsingContext.reload", { context: A, wait: "complete" });
await until(A, `document.getElementById("status").textContent === "conectado"`, "A reloaded in Portuguese");
await openSettings(A, "header");
await ev(A, `document.querySelector("#settings [data-lang='en']").click()`);
if (await text(A, "#status") !== "connected" || await ev(A, `document.documentElement.lang`) !== "en") throw new Error("could not go back to English");

// A logo da barra: carregou, tem 75% da altura da barra, é quadrada, fica centralizada na vertical e a margem esquerda é
// igual à de cima e de baixo
const logo = JSON.parse(await ev(A, `JSON.stringify((() => { const i = document.querySelector("header .logo img"), l = document.querySelector("header .logo").getBoundingClientRect(),
  h = document.querySelector("header").getBoundingClientRect();
  return { loaded: i.complete && i.naturalWidth === 900, ratio: l.height / h.height, square: Math.abs(l.width - l.height), left: l.left - h.left,
    top: l.top - h.top, bottom: h.bottom - l.bottom }; })())`));
if (!logo.loaded || Math.abs(logo.ratio - 0.75) > 0.02 || logo.square > 0.5 || Math.abs(logo.top - logo.bottom) > 0.5 || Math.abs(logo.left - logo.top) > 0.5) {
  throw new Error(`nav logo: ${JSON.stringify(logo)}`);
}

// Nome da sala, impressão digital e estado da conexão em negrito, como o "you"
for (const sel of ["#me", "#room", "#fingerprint", "#status"]) {
  if (Number(await ev(A, `getComputedStyle(document.querySelector("header ${sel}")).fontWeight`)) < 700) throw new Error(`${sel} is not bold in the nav`);
}
// Realce em magenta (botões, foco, caixas de seleção); o verde fica para as mensagens positivas
const css = (sel: string, prop: string) => ev(A, `getComputedStyle(document.querySelector(${JSON.stringify(sel)}))[${JSON.stringify(prop)}]`);
if (await css("#status", "color") !== "rgb(59, 122, 52)") throw new Error(`"connected" is not green: ${await css("#status", "color")}`);
await ev(A, `document.getElementById("text").value = "x"; document.getElementById("text").dispatchEvent(new Event("input"))`);
if (await css("#send", "backgroundColor") !== "rgb(138, 63, 163)") throw new Error(`send button color: ${await css("#send", "backgroundColor")}`);
await cmd("browsingContext.activate", { context: A });
await ev(A, `document.getElementById("text").focus()`);
if (await css("#text", "outlineColor") !== "rgb(138, 63, 163)") throw new Error(`input focus color: ${await css("#text", "outlineColor")}`);
await ev(A, `document.getElementById("text").blur(); document.getElementById("text").value = ""; document.getElementById("text").dispatchEvent(new Event("input"))`);
if (await css("#fraud-resign", "accentColor") !== "rgb(138, 63, 163)") throw new Error(`checkbox color: ${await css("#fraud-resign", "accentColor")}`);

// A engrenagem não pode aumentar a altura do cabeçalho
const headerH = (hideGear: boolean) => ev(A, `(() => { const g = document.querySelector("header .gear"); g.style.display = ${hideGear ? '"none"' : '""'};
  return document.querySelector("header").getBoundingClientRect().height; })()`);
const withGear = await headerH(false), withoutGear = await headerH(true);
await headerH(false);
if (withGear !== withoutGear) throw new Error(`the gear makes the header taller: ${withGear} vs ${withoutGear}`);

// Configurações: a engrenagem abre um painel do mesmo tamanho do painel da chave, um painel por vez; tema claro/escuro
// mutuamente exclusivos, com a escolha guardada; divisórias de 2px
const box = (sel: string) => ev(A, `JSON.stringify((() => { const e = document.querySelector(${JSON.stringify(sel)}), b = e.getBoundingClientRect();
  return { w: Math.round(b.width), h: Math.round(b.height), hidden: e.hidden }; })())`).then(JSON.parse);
await ev(A, `document.querySelector(".msg .who").click()`);
const infoBox = await box("#panel");
if (infoBox.hidden) throw new Error("info panel did not open");
// O QR da chave pública fica centralizado no painel (medido com o painel aberto)
const qrBox = JSON.parse(await ev(A, `JSON.stringify((() => { const s = document.querySelector("#p-qr svg").getBoundingClientRect(), el = document.getElementById("panel"), p = el.getBoundingClientRect();
  // Área útil: sem a barra de rolagem, que o painel ganha quando é mais alto que a janela
  return { w: s.width, off: Math.abs((s.left + s.width / 2) - (p.left + el.clientLeft + el.clientWidth / 2)) }; })())`));
if (qrBox.w < 100 || qrBox.off > 2) throw new Error(`the public key QR is not centered: ${JSON.stringify(qrBox)}`);
await openSettings(A, "header");
const setBox = await box("#settings");
if (setBox.hidden || !(await box("#panel")).hidden) throw new Error("opening the settings did not replace the info panel");
if (setBox.w !== infoBox.w || setBox.h !== infoBox.h) throw new Error(`panels differ in size: ${JSON.stringify(setBox)} vs ${JSON.stringify(infoBox)}`);
const hrs = JSON.parse(await ev(A, `JSON.stringify(["#panel", "#settings"].map(p => [...document.querySelectorAll(p + " hr")].map(h => getComputedStyle(h).height)))`));
if (hrs[0].length !== 3 || hrs[1].length !== 2 || ![...hrs[0], ...hrs[1]].every((h: string) => h === "2px")) throw new Error(`dividers: ${JSON.stringify(hrs)}`);
await ev(A, `document.querySelector(".msg .who").click()`);
if (!(await box("#settings")).hidden || (await box("#panel")).hidden) throw new Error("opening the info panel did not replace the settings");
await openSettings(A, "header");
if (await ev(A, `document.getElementById("p-name").nextElementSibling.tagName`) === "HR") throw new Error("a divider between the name and the color");
const bg = () => ev(A, `getComputedStyle(document.body).backgroundColor`);
const pressedThemes = () => ev(A, `[...document.querySelectorAll("#settings [data-theme-set]")].map(b => b.getAttribute("aria-pressed")).join()`);
await ev(A, `document.querySelector("[data-theme-set='dark']").click()`);
if (await bg() !== "rgb(20, 27, 30)" || await pressedThemes() !== "false,true") throw new Error(`dark theme: ${await bg()} ${await pressedThemes()}`);
// No escuro: realce no magenta do Everblush (#c47fd5) e o verde (#8ccf7e) só no "connected"
await ev(A, `document.getElementById("text").value = "x"; document.getElementById("text").dispatchEvent(new Event("input"))`);
if (await css("#send", "backgroundColor") !== "rgb(196, 127, 213)" || await css("#status", "color") !== "rgb(140, 207, 126)") throw new Error(`dark accent/ok: ${await css("#send", "backgroundColor")} ${await css("#status", "color")}`);
await ev(A, `document.getElementById("text").value = ""; document.getElementById("text").dispatchEvent(new Event("input"))`);
await cmd("browsingContext.reload", { context: A, wait: "complete" });
await until(A, `document.querySelectorAll(".msg").length === 4`, "A reloaded in the dark theme");
if (await bg() !== "rgb(20, 27, 30)") throw new Error("theme lost on reload");
await openSettings(A, "header");
await ev(A, `document.querySelector("[data-theme-set='light']").click()`);
if (await bg() !== "rgb(238, 242, 241)" || await pressedThemes() !== "true,false") throw new Error(`light theme: ${await bg()} ${await pressedThemes()}`);
await ev(A, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
if (!(await box("#settings")).hidden) throw new Error("Escape did not close the settings");
if (await ev(A, `getComputedStyle(document.getElementById("me")).fontWeight`) < "700") throw new Error("your key/name is not bold in the nav");
// O QR da chave pública, no painel da chave, lê de volta a chave exibida
await ev(A, `document.getElementById("me").click()`);
const shownKey = await ev(A, `document.getElementById("p-key").textContent`);
if (await decodeQr(await ev(A, `document.querySelector("#p-qr svg").outerHTML`)) !== shownKey) throw new Error("public key QR does not match the key");
await ev(A, `document.getElementById("p-close").click()`);

// Só espaços em branco não é mensagem: o botão fica desabilitado e o Enter não envia
const typeMsg = (v: string) => ev(A, `(() => { const t = document.getElementById("text"); t.removeAttribute("maxlength"); t.value = ${JSON.stringify(v)}; t.dispatchEvent(new Event("input")); })()`);
for (const blank of [" ", "     ", "\t", "\u00a0", "\u2003 \u3000"]) {
  await typeMsg(blank);
  if (await ev(A, `document.getElementById("send").disabled`) !== true) throw new Error(`accepted a blank message: ${JSON.stringify(blank)}`);
}
await typeMsg("   ");
await ev(A, `document.getElementById("form").dispatchEvent(new Event("submit", { cancelable: true }))`);
await sleep(500);
if (await ev(A, `document.querySelectorAll(".msg").length`) !== 4 || await ev(A, `document.getElementById("text").value`) !== "   ") throw new Error("a blank message was sent with Enter");
await typeMsg(" a ");
if (await ev(A, `document.getElementById("send").disabled`) !== false) throw new Error("a message with text around spaces was refused");
await typeMsg("");

// Teste de fraude: ligado nas configurações, a barra de baixo expande e mostra todos os campos do bloco (menos o data);
// cada recusa do validator volta à pessoa com o código do erro
const heightOf = (sel: string) => ev(A, `document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().height`);
const composerBefore = await heightOf("#composer");
if (await ev(A, `document.getElementById("fraud").hidden`) !== true) throw new Error("fraud fields visible while the test is off");
await openSettings(A, "header");
await ev(A, `document.getElementById("fraud-toggle").click()`);
await ev(A, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
const composerAfter = await heightOf("#composer");
const names = await ev(A, `[...document.querySelectorAll("#fraud-fields .frow label")].map(l => l.textContent).join()`);
if (names !== "room,stamp,nonce,info,type,length,author,sig,prev") throw new Error(`fraud fields: ${names}`);
if (composerAfter < composerBefore + 100) throw new Error(`the bottom bar did not expand: ${composerBefore} -> ${composerAfter}`);
if (await ev(A, `document.getElementById("form").getBoundingClientRect().bottom <= innerHeight`) !== true) throw new Error("the message bar left the screen");
// Os campos ficam abaixo da barra de mensagem
if (await ev(A, `document.getElementById("fraud").getBoundingClientRect().top >= document.getElementById("form").getBoundingClientRect().bottom - 1`) !== true) throw new Error("the fraud fields are not below the message bar");
const resignText = await ev(A, `document.getElementById("fraud-resign").parentElement.querySelector("span").textContent.replace(/\\s+/g, " ").trim()`);
if (resignText !== "Sign automatically after my edits (uncheck to keep the original signature)") throw new Error(`sign option text: ${resignText}`);
const field = (n: string) => ev(A, `document.getElementById("f-${n}").value`);
const setField = (n: string, v: string) => ev(A, `(() => { const i = document.getElementById("f-${n}"); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input")); })()`);
// Opções do teste de fraude, nos valores iniciais: assina de novo, stamp acompanha o relógio, stamp em ns, room em texto
const setOption = (id: string, on: boolean) => ev(A, `(() => { const c = document.getElementById(${JSON.stringify(id)}); if (c.checked !== ${on}) c.click(); })()`);
const resetFields = async () => {
  await ev(A, `document.querySelectorAll("#fraud-fields .frow button:not(:disabled)").forEach(b => b.click())`);
  await setOption("fraud-resign", true); await setOption("fraud-sync", true); await setOption("fraud-stampdate", false); await setOption("fraud-roomhex", false);
};
// As opções ficam abaixo do botão de restaurar, uma por linha, na ordem room, stamp (2) e assinatura
const optionBoxes = JSON.parse(await ev(A, `JSON.stringify([...document.querySelectorAll("#fraud .ftools > *")].map(e => { const r = e.getBoundingClientRect(); return { id: e.id || e.querySelector("input").id, top: r.top, left: r.left, bottom: r.bottom }; }))`));
if (optionBoxes.map((o: { id: string }) => o.id).join() !== "fraud-reset,fraud-roomhex,fraud-sync,fraud-stampdate,fraud-resign") throw new Error(`fraud options: ${JSON.stringify(optionBoxes)}`);
for (let i = 1; i < optionBoxes.length; i++) {
  if (optionBoxes[i].top < optionBoxes[i - 1].bottom - 1 || optionBoxes[i].left !== optionBoxes[0].left) throw new Error(`fraud option ${optionBoxes[i].id} is not on its own line below the previous one`);
}
const initialBoxes = await ev(A, `["fraud-roomhex", "fraud-sync", "fraud-stampdate", "fraud-resign"].map(i => document.getElementById(i).checked).join()`);
if (initialBoxes !== "false,true,false,true") throw new Error(`initial options: ${initialBoxes}`);
const lastStamp = async () => BigInt(await ev(A, `[...document.querySelectorAll(".msg .when")].at(-1).dataset.stamp`));
const msgCount = () => ev(A, `document.querySelectorAll(".msg").length`);
const result = () => ev(A, `document.getElementById("fraud-result").textContent`);
// Digita o texto, clica em enviar e espera a resposta do validator
async function attempt(edits: Record<string, string>, opts: { resign?: boolean; roomHex?: boolean; stampDate?: boolean } = {}) {
  await resetFields();
  if (opts.roomHex) await setOption("fraud-roomhex", true);
  if (opts.stampDate) await setOption("fraud-stampdate", true);
  if (opts.resign === false) await ev(A, `document.getElementById("fraud-resign").click()`);
  for (const [n, v] of Object.entries(edits)) await setField(n, v);
  await typeMsg("fraud test");
  await ev(A, `document.getElementById("send").click()`);
  await until(A, `/^(Rejected|Accepted|Fix)/.test(document.getElementById("fraud-result").textContent)`, "the validator's answer");
  return await result();
}

// Valores iniciais: o que a mensagem normal teria (e o botão default restaura)
await typeMsg("fraud test");
const nonce0 = await field("nonce");
if (!/^\d+$/.test(nonce0)) throw new Error("bad default nonce");
if (await field("room") !== "Bizas" || await field("prev") === "00".repeat(64) || (await field("author")).length !== 64) throw new Error("fraud defaults are not the normal block");
await setField("nonce", "5");
if (await ev(A, `document.querySelectorAll(".frow.edited").length`) !== 1 || await field("nonce") !== "5") throw new Error("edit was not marked");
// Campo editado: nome em roxo (--edit), e não em vermelho
const purple = await ev(A, `getComputedStyle(document.querySelector("#f-nonce").parentElement.querySelector("label")).color`);
if (purple !== "rgb(138, 63, 163)") throw new Error(`edited field color: ${purple}`);
await ev(A, `document.querySelector("#f-nonce").parentElement.querySelector("button").click()`);
if (await field("nonce") !== nonce0 || await ev(A, `document.querySelectorAll(".frow.edited").length`) !== 0) throw new Error("the default button did not restore the value");

// Reset all fields: volta tudo ao padrão de uma vez (e o botão só serve com algo editado)
if (await ev(A, `document.getElementById("fraud-reset").disabled`) !== true) throw new Error("reset-all enabled with nothing edited");
await setField("stamp", "1"); await setField("room", "x"); await setField("length", "5");
if (await ev(A, `document.querySelectorAll(".frow.edited").length`) !== 3 || await ev(A, `document.getElementById("fraud-reset").disabled`) !== false) throw new Error("edits were not marked");
await ev(A, `document.getElementById("fraud-reset").click()`);
if (await ev(A, `document.querySelectorAll(".frow.edited").length`) !== 0 || await field("room") !== "Bizas" || await field("length") !== "10"
  || await ev(A, `document.getElementById("fraud-reset").disabled`) !== true) throw new Error("reset-all did not restore the defaults");

const last = await lastStamp();
const cases: [string, Record<string, string>, { resign?: boolean }, string][] = [
  ["stamp before the previous block", { stamp: String(last - 1n) }, {}, "NO_TIMESTAMP_CONTINUITY"],
  ["another room (text)", { room: "Other" }, {}, "INVALID_ROOM"],
  ["wrong prev", { prev: "11".repeat(64) }, {}, "NO_HASH_CONTINUITY"],
  ["length above the limit", { length: "321" }, {}, "INVALID_LENGTH"],
  ["negative length", { length: "-1" }, {}, "INVALID_LENGTH"],
  ["edit without signing again", { nonce: "5" }, { resign: false }, "FRAUD"],
  ["typed signature", { sig: "ab".repeat(64) }, {}, "FRAUD"],
  ["impersonating another author", { author: "11".repeat(32) }, {}, "FRAUD"],
];
for (const [what, edits, opts, code] of cases) {
  const r = await attempt(edits, opts);
  if (r !== `Rejected: ${code}`) throw new Error(`${what}: expected Rejected: ${code}, got ${r}`);
  // O status do cabeçalho só mostra a conexão: a recusa aparece embaixo, nunca ali
  if (await text(A, "#status") !== "connected" || await ev(A, `document.getElementById("status").className`) !== "ok") throw new Error(`${what}: the status line shows something other than the connection`);
  if (await msgCount() !== 4 || await ev(A, `document.getElementById("text").value`) !== "fraud test") throw new Error(`${what}: the chain or the text changed`);
  console.log(`fraud: ${what} -> ${r}`);
}
// Nonce digitado com "assinar automaticamente": a assinatura vai sem prova de trabalho. Procura um nonce cuja
// assinatura (a que a caixa sig mostra) não começa com WORK bits zero. O stamp fica fixo na busca e no envio: se ele
// acompanhasse o relógio, a assinatura enviada seria outra e teria os bits zero por acaso 1 vez em 2^WORK
await resetFields();
await typeMsg("fraud test");
const lazyStamp = await field("stamp");
await setField("stamp", lazyStamp);
let lazy = "";
for (let n = 1; n < 200 && !lazy; n++) {
  await setField("nonce", String(n));
  if (zeroBits(await field("sig")) < WORK) lazy = String(n);
}
if (!lazy) throw new Error("no nonce without work found");
const noWork = await attempt({ stamp: lazyStamp, nonce: lazy });
if (noWork !== "Rejected: INSUFFICIENT_WORK") throw new Error(`nonce without work: ${noWork}`);
console.log(`fraud: nonce ${lazy} without proof of work -> ${noWork}`);
// Carimbo no futuro (congelamento): +1 h sobre o valor que a caixa mostra
await resetFields();
const stampNow = BigInt(await field("stamp"));
const future = await attempt({ stamp: String(stampNow + 3_600_000_000_000n) });
if (future !== "Rejected: TIMESTAMP_IN_FUTURE") throw new Error(`future stamp: ${future}`);
// Modos de edição. room: o padrão é texto; em bytes, o mesmo valor aparece em hex e a edição em hex vale
await resetFields();
await setField("room", "Other");
await setOption("fraud-roomhex", true);
if (await field("room") !== "4f74686572000000") throw new Error(`the edited room was not converted to hex: ${await field("room")}`);
await setOption("fraud-roomhex", false);
if (await field("room") !== "Other") throw new Error("the edited room was not converted back to text");
await setOption("fraud-roomhex", true);
await resetFields();
await setOption("fraud-roomhex", true);
if (await field("room") !== "42697a6173000000") throw new Error("the default room is not shown as bytes");
const hexRoom = await attempt({ room: "00".repeat(8) }, { roomHex: true });
if (hexRoom !== "Rejected: INVALID_ROOM") throw new Error(`room typed as bytes: ${hexRoom}`);
console.log(`fraud: another room (bytes) -> ${hexRoom}`);
// stamp: em data UTC, o mesmo valor que a caixa mostra em ns; um nanossegundo antes do bloco anterior é recusado
await resetFields();
const lastNs = await lastStamp();
const toDate = (ns: bigint) => { const sec = ns / 1_000_000_000n; return new Date(Number(sec) * 1000).toISOString().slice(0, 19).replace("T", " ") + "." + String(ns % 1_000_000_000n).padStart(9, "0"); };
await setField("stamp", String(lastNs - 1n));
await setOption("fraud-stampdate", true);
if (await field("stamp") !== toDate(lastNs - 1n)) throw new Error(`the edited stamp was not converted to a date: ${await field("stamp")}`);
await setOption("fraud-stampdate", false);
if (await field("stamp") !== String(lastNs - 1n)) throw new Error("the edited stamp was not converted back to nanoseconds");
await resetFields();
await setOption("fraud-stampdate", true);
if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{9}$/.test(await field("stamp"))) throw new Error(`stamp is not shown as a date: ${await field("stamp")}`);
const dateAttempt = await attempt({ stamp: toDate(lastNs - 1n) }, { stampDate: true });
if (dateAttempt !== "Rejected: NO_TIMESTAMP_CONTINUITY") throw new Error(`stamp typed as a date: ${dateAttempt}`);
console.log(`fraud: stamp typed as a UTC date -> ${dateAttempt}`);
await resetFields();
await setOption("fraud-stampdate", true);
await setField("stamp", "2030-02-30 00:00:00");
if (!(await ev(A, `document.querySelector("#f-stamp").parentElement.querySelector(".ferr").textContent`)).startsWith("stamp: expected a UTC date")) throw new Error("no error on the malformed date");
// stamp congelado: sem sincronizar, o valor não anda; sincronizando, anda
await resetFields();
await setOption("fraud-sync", false);
const frozen1 = await field("stamp");
await new Promise((r) => setTimeout(r, 1200));
if (await field("stamp") !== frozen1) throw new Error("the stamp moved while frozen");
await setOption("fraud-sync", true);
await new Promise((r) => setTimeout(r, 1200));
if (await field("stamp") === frozen1) throw new Error("the stamp did not follow the clock after syncing again");
// Campo mal formado: o erro aparece no campo e nada é enviado
await resetFields();
await setField("room", "123456789");
if (!(await ev(A, `document.querySelector("#f-room").parentElement.querySelector(".ferr").textContent`)).startsWith("room: expected text of up to 8 bytes")) throw new Error("no error on the malformed field");
await setOption("fraud-roomhex", true);
await setField("room", "abcd");
if (!(await ev(A, `document.querySelector("#f-room").parentElement.querySelector(".ferr").textContent`)).startsWith("room: expected 16 hexadecimal")) throw new Error("no error on the malformed hex field");
await ev(A, `document.getElementById("send").click()`);
await until(A, `document.getElementById("fraud-result").textContent.startsWith("Fix the fields")`, "the invalid-fields notice");
if (await msgCount() !== 4) throw new Error("a malformed block was sent");
// A recusa acompanha a língua
await resetFields();
await attempt({ prev: "11".repeat(64) });
await openSettings(A, "header");
await ev(A, `document.querySelector("#settings [data-lang='pt']").click()`);
if (await result() !== "Recusado: NO_HASH_CONTINUITY") throw new Error(`result in Portuguese: ${await result()}`);
await ev(A, `document.querySelector("#settings [data-lang='en']").click()`);
await ev(A, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
// Sem edições, o mesmo caminho aceita o bloco
await resetFields();
await typeMsg("fraud test");
await ev(A, `document.getElementById("send").click()`);
await until(A, `document.getElementById("fraud-result").textContent.startsWith("Accepted")`, "the accepted block");
if (await css("#fraud-result", "color") !== "rgb(59, 122, 52)") throw new Error("the accepted notice is not green");
if (await result() !== "Accepted: the validator chained the block" || await msgCount() !== 5) throw new Error("the unedited block was not accepted");
if (await ev(A, `document.querySelectorAll(".frow.edited").length`) !== 0) throw new Error("edits were kept after the block was accepted");
// Desligar esconde os campos e a barra volta ao tamanho de antes
await openSettings(A, "header");
await ev(A, `document.getElementById("fraud-toggle").click()`);
await ev(A, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
if (await ev(A, `document.getElementById("fraud").hidden`) !== true || Math.abs(await heightOf("#composer") - composerBefore) > 1) throw new Error("the bar did not shrink back");
await typeMsg("");

// Erro numa mensagem normal: aparece na linha abaixo da barra, o status continua só com a conexão, e o erro some quando a
// mensagem seguinte é aceita. O envio é adulterado (um byte do nonce) para o validator recusar
await ev(A, `window.__send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { const b = new Uint8Array(d); b[16] ^= 1; return window.__send.call(this, b); }`);
await typeMsg("tampered");
await ev(A, `document.getElementById("send").click()`);
await until(A, `document.getElementById("msg-error").textContent === "message rejected: FRAUD"`, "the message error line");
if (await text(A, "#status") !== "connected" || await msgCount() !== 5) throw new Error("a rejected normal message changed the status or the chain");
await ev(A, `WebSocket.prototype.send = window.__send`);
await typeMsg("after the error");
await ev(A, `document.getElementById("send").click()`);
await until(A, `document.querySelectorAll(".msg").length === 6`, "the valid message after the error");
if (await ev(A, `document.getElementById("msg-error").hidden`) !== true || await text(A, "#status") !== "connected") throw new Error("the error stayed after a valid message");
await typeMsg("");

// Mensagem acima de 320 bytes UTF-8: botão desabilitado
await ev(A, `(() => { const t = document.getElementById("text"); t.removeAttribute("maxlength"); t.value = "é".repeat(161); t.dispatchEvent(new Event("input")); })()`);
if (!(await ev(A, `document.getElementById("send").disabled`))) throw new Error("accepted 322 bytes");
await typeMsg("");

// Enquetes (extensão POLL/VOTE): o "+" abre o menu, que por enquanto só tem a enquete; ela abre o painel lateral de
// criação. A enquete aparece como uma mensagem, uma barra por opção com o número e a porcentagem; cada voto aparece
// como uma linha. Numa enquete exclusiva, trocar de opção custa dois blocos (retirar e votar); ninguém vota duas vezes
// na mesma opção
const msgs = (ctx: string) => ev(ctx, `document.querySelectorAll(".msg").length`);
const click = (ctx: string, sel: string) => ev(ctx, `document.querySelector(${JSON.stringify(sel)}).click()`);
const pollRows = (ctx: string, index: number) => ev(ctx, `JSON.stringify([...document.querySelectorAll('.msg[data-index="${index}"] .opt')].map(b => [b.querySelector(".oname").textContent, b.querySelector(".onum").textContent, b.classList.contains("voted")]))`).then(JSON.parse);
const lastVote = (ctx: string) => ev(ctx, `(() => { const m = [...document.querySelectorAll(".msg.vote-msg")].at(-1); return m.querySelector(".who").textContent + " " + m.querySelector(".vote").textContent; })()`);
const setInput = (ctx: string, sel: string, v: string) => ev(ctx, `(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input")); })()`);
const base = await msgs(A);
if (await ev(A, `document.getElementById("plus").disabled`) !== false) throw new Error("the + button is disabled");
await click(A, "#plus");
const menu = await ev(A, `JSON.stringify({ hidden: document.getElementById("plus-menu").hidden, items: [...document.querySelectorAll("#plus-menu button")].map(b => b.textContent) })`);
if (menu !== JSON.stringify({ hidden: false, items: ["📊 Create New Poll"] })) throw new Error(`+ menu: ${menu}`);
await click(A, "#menu-poll");
if (await ev(A, `document.getElementById("poll-panel").hidden || !document.getElementById("plus-menu").hidden || !document.getElementById("panel").hidden || !document.getElementById("settings").hidden`) !== false) throw new Error("the poll panel did not open alone");
if (await ev(A, `document.getElementById("poll-create").disabled`) !== true) throw new Error("an empty poll can be created");
await setInput(A, "#poll-question", "Where shall we eat?");
await setInput(A, ".orow:nth-child(1) input", "Pizza");
await setInput(A, ".orow:nth-child(2) input", "Pizza");
if (await text(A, "#poll-err") !== "Two options are the same" || await ev(A, `document.getElementById("poll-create").disabled`) !== true) throw new Error("duplicate options were not refused");
await setInput(A, ".orow:nth-child(2) input", "<b>Sushi</b>");
await click(A, "#poll-add");
await setInput(A, ".orow:nth-child(3) input", "Tacos");
await click(A, "#poll-exclusive");
await click(A, "#poll-create");
await until(A, `document.querySelectorAll(".msg").length === ${base + 1}`, "the poll on A");
await until(B, `document.querySelectorAll(".msg").length === ${base + 1}`, "the poll on B");
const POLL = base; // índice do bloco da enquete (a partir de 0): a cadeia tem um bloco por mensagem
if (await ev(A, `document.getElementById("poll-panel").hidden`) !== true) throw new Error("the poll panel stayed open after creating the poll");
const label = await text(B, `.msg[data-index="${POLL}"] .plabel`);
if (label !== `Poll · block ${POLL}` || await text(B, `.msg[data-index="${POLL}"] .q`) !== "Where shall we eat?") throw new Error(`poll card: ${label}`);
if (await ev(B, `document.querySelector('.msg[data-index="${POLL}"] .opt .oname b') !== null`) !== false) throw new Error("an option was inserted as HTML");
const want = (rows: [string, string, boolean][]) => JSON.stringify(rows);
if (JSON.stringify(await pollRows(B, POLL)) !== want([["Pizza", "0 · 0%", false], ["<b>Sushi</b>", "0 · 0%", false], ["Tacos", "0 · 0%", false]])) throw new Error(`empty poll: ${JSON.stringify(await pollRows(B, POLL))}`);
// B vota em Pizza; A vê a barra e a linha do voto
await click(B, `.msg[data-index="${POLL}"] .opt[data-opt="0"]`);
await until(A, `document.querySelectorAll(".msg").length === ${base + 2}`, "B's vote on A");
const voteText = await lastVote(A);
if (voteText !== `${idB} voted for “Pizza” in the poll at block ${POLL} · “Where shall we eat?”`) throw new Error(`vote line: ${voteText}`);
console.log("poll vote line:", voteText);
await click(A, `.msg[data-index="${POLL}"] .opt[data-opt="1"]`);
await until(B, `document.querySelectorAll(".msg").length === ${base + 3}`, "A's vote on B");
if (JSON.stringify(await pollRows(B, POLL)) !== want([["Pizza", "1 · 50%", true], ["<b>Sushi</b>", "1 · 50%", false], ["Tacos", "0 · 0%", false]])) throw new Error(`poll after two votes: ${JSON.stringify(await pollRows(B, POLL))}`);
const fillW = await ev(B, `document.querySelector('.msg[data-index="${POLL}"] .opt[data-opt="0"] .fill').style.width`);
if (fillW !== "50%") throw new Error(`progress bar width: ${fillW}`);
// Exclusiva: B troca para Tacos, que são dois blocos (retira Pizza e vota em Tacos)
await click(B, `.msg[data-index="${POLL}"] .opt[data-opt="2"]`);
await until(A, `document.querySelectorAll(".msg").length === ${base + 5}`, "B's switch (two blocks) on A", 40000);
const switchLines = await ev(A, `JSON.stringify([...document.querySelectorAll(".msg.vote-msg .vote")].slice(-2).map(e => e.textContent))`);
if (switchLines !== JSON.stringify([`withdrew their vote for “Pizza” in the poll at block ${POLL} · “Where shall we eat?”`, `voted for “Tacos” in the poll at block ${POLL} · “Where shall we eat?”`])) throw new Error(`switch: ${switchLines}`);
if (JSON.stringify(await pollRows(B, POLL)) !== want([["Pizza", "0 · 0%", false], ["<b>Sushi</b>", "1 · 50%", false], ["Tacos", "1 · 50%", true]])) throw new Error(`poll after the switch: ${JSON.stringify(await pollRows(B, POLL))}`);
// Clicar de novo na opção votada retira o voto
await click(B, `.msg[data-index="${POLL}"] .opt[data-opt="2"]`);
await until(A, `document.querySelectorAll(".msg").length === ${base + 6}`, "B's withdrawal on A");
if (JSON.stringify(await pollRows(A, POLL)) !== want([["Pizza", "0 · 0%", false], ["<b>Sushi</b>", "1 · 100%", true], ["Tacos", "0 · 0%", false]])) throw new Error(`poll after the withdrawal: ${JSON.stringify(await pollRows(A, POLL))}`);
// Não exclusiva: a mesma pessoa vota em várias opções
await click(B, "#plus");
await click(B, "#menu-poll");
await setInput(B, "#poll-question", "Colors?");
await setInput(B, ".orow:nth-child(1) input", "Red");
await setInput(B, ".orow:nth-child(2) input", "Green");
await click(B, "#poll-create");
await until(A, `document.querySelectorAll(".msg").length === ${base + 7}`, "the second poll on A");
const POLL2 = base + 6;
if (await text(A, `.msg[data-index="${POLL2}"] .pfoot`) !== "several choices per person · 0 votes") throw new Error(`second poll footer: ${await text(A, `.msg[data-index="${POLL2}"] .pfoot`)}`);
await click(A, `.msg[data-index="${POLL2}"] .opt[data-opt="0"]`);
await until(A, `document.querySelectorAll(".msg").length === ${base + 8}`, "A's first vote");
await click(A, `.msg[data-index="${POLL2}"] .opt[data-opt="1"]`);
await until(B, `document.querySelectorAll(".msg").length === ${base + 9}`, "A's second vote on B");
if (JSON.stringify(await pollRows(A, POLL2)) !== want([["Red", "1 · 50%", true], ["Green", "1 · 50%", true]])) throw new Error(`second poll: ${JSON.stringify(await pollRows(A, POLL2))}`);
// O link da linha do voto leva à enquete
await ev(A, `[...document.querySelectorAll(".msg.vote-msg .goto")].at(-1).click()`);
if (await ev(A, `document.querySelector('.msg[data-index="${POLL2}"]').classList.contains("flash")`) !== true) throw new Error("the vote link did not lead to the poll");
// Em português
await openSettings(A, "header");
await ev(A, `document.querySelector("#settings [data-lang='pt']").click()`);
const ptVote = await ev(A, `[...document.querySelectorAll(".msg.vote-msg .vote")].at(-1).textContent`);
const ptLabel = await text(A, `.msg[data-index="${POLL}"] .plabel`);
await ev(A, `document.querySelector("#settings [data-lang='en']").click()`);
await ev(A, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
if (ptVote !== `votou em “Green” na enquete do bloco ${POLL2} · “Colors?”` || ptLabel !== `Enquete · bloco ${POLL}`) throw new Error(`poll in Portuguese: ${ptVote} | ${ptLabel}`);
// Fraude: um voto repetido montado à mão no teste de fraude (type 8, info = a enquete, data = opção 0 e ação 1) é
// recusado pelo validator, e a cadeia não muda
await openSettings(A, "header");
await ev(A, `document.getElementById("fraud-toggle").click()`);
await ev(A, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
await resetFields();
await setField("type", "8");
await setField("info", String(POLL2));
await typeMsg("\u0000\u0001");
if (await field("length") !== "2") throw new Error(`vote length in the fraud test: ${await field("length")}`);
await ev(A, `document.getElementById("send").click()`);
await until(A, `/^(Rejected|Accepted|Error)/.test(document.getElementById("fraud-result").textContent)`, "the duplicate vote answer");
const dupVote = await result();
if (dupVote !== "Rejected: DUPLICATE_VOTE" || await msgs(A) !== base + 9) throw new Error(`duplicate vote: ${dupVote}`);
console.log(`fraud: duplicate vote -> ${dupVote}`);
await openSettings(A, "header");
await ev(A, `document.getElementById("fraud-toggle").click()`);
await ev(A, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
await typeMsg("");
console.log("polls:", JSON.stringify(await pollRows(A, POLL)), JSON.stringify(await pollRows(A, POLL2)));
// Teclado físico (o Firefox headless não tem ponteiro grosso): Shift+Enter não envia e a caixa cresce com as linhas;
// Enter envia, a quebra de linha chega inteira ao outro aparelho e a caixa volta a uma linha
const MULTI = "first line\nsecond line\nthird line";
const boxHeight = () => ev(A, `document.getElementById("text").getBoundingClientRect().height`);
const enter = (shift: boolean) => ev(A, `document.getElementById("text").dispatchEvent(new KeyboardEvent("keydown",
  { key: "Enter", shiftKey: ${shift}, bubbles: true, cancelable: true }))`);
const beforeMulti = await msgs(A), oneLine = await boxHeight();
await typeMsg(MULTI);
await enter(true);
await sleep(500);
if (await msgs(A) !== beforeMulti) throw new Error("Shift+Enter sent the message");
const threeLines = await boxHeight();
if (!(threeLines > oneLine * 2)) throw new Error(`the message box did not grow: ${oneLine} -> ${threeLines}`);
// O Enter começa a prova de trabalho na mesma hora: a caixa e o "+" travam até o validator aceitar, e destravam depois
const lockedNow = await ev(A, `(() => { document.getElementById("text").focus();
  document.getElementById("text").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const t = document.getElementById("text");
  return JSON.stringify([t.disabled, document.getElementById("plus").disabled, getComputedStyle(t).cursor]); })()`);
if (lockedNow !== JSON.stringify([true, true, "not-allowed"])) throw new Error(`the message box was not locked while sending: ${lockedNow}`);
await until(B, `[...document.querySelectorAll(".msg .text")].some(e => e.textContent === ${JSON.stringify(MULTI)})`,
  "B to see the multi-line message");
await until(A, `document.getElementById("text").value === ""`, "the message box to clear");
if (await boxHeight() !== oneLine) throw new Error(`the message box did not shrink back: ${await boxHeight()} != ${oneLine}`);
const unlocked = await ev(A, `JSON.stringify([document.getElementById("text").disabled, document.getElementById("plus").disabled,
  document.activeElement === document.getElementById("text")])`);
if (unlocked !== JSON.stringify([false, false, true])) throw new Error(`the message box did not unlock (or lost the focus): ${unlocked}`);
console.log(`multi-line: Shift+Enter kept it, Enter sent it (box locked while sending, then unlocked with focus); box ${oneLine} -> ${threeLines} -> ${oneLine} px`);
console.log("height A:", await ev(A, `document.getElementById("height").textContent`));
// A cadeia ganhou um bloco no teste de fraude: a impressão digital final é a da cabeça atual, que o script confere com
// a da cadeia exportada
const fpEnd = await ev(A, `document.getElementById("fingerprint").textContent`);
console.log(`FINGERPRINT ${await ev(A, `document.getElementById("height").textContent`)} ${fpEnd}`);
console.log("E2E OK");
await cmd("session.end").catch(() => {});
Deno.exit(0);
