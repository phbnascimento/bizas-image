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
async function until(ctx: string, expr: string, what: string, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(ctx, expr)) return; await sleep(100); }
  throw new Error(`timed out waiting for: ${what}`);
}
await cmd("session.new", { capabilities: {} });
// skewMs desloca o relógio do aparelho (Date.now) antes de a página carregar. O carimbo assinado tem de vir do relógio
// do validator, e não do aparelho: com o relógio próprio, um aparelho adiantado seria recusado (TIMESTAMP_IN_FUTURE)
async function device(skewMs: number) {
  const { userContext } = await cmd("browser.createUserContext");
  const { context } = await cmd("browsingContext.create", { type: "tab", userContext });
  await cmd("script.addPreloadScript", {
    functionDeclaration: `() => { const real = Date.now; Date.now = () => real() + (${skewMs}); }`,
    contexts: [context],
  });
  await cmd("browsingContext.navigate", { context, url: BASE + "/", wait: "complete" });
  await until(context, `document.getElementById("status").textContent === "connected"`, "connect");
  return context;
}
const send = (ctx: string, text: string) => ev(ctx, `(() => { const t = document.getElementById("text"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input")); document.getElementById("send").click(); })()`);
const texts = (ctx: string) => ev(ctx, `JSON.stringify([...document.querySelectorAll(".msg .text")].map(e => e.textContent))`).then(JSON.parse);
const me = (ctx: string) => ev(ctx, `document.getElementById("me").textContent`);

// A atrasado 3 h, B adiantado 2 h
const A = await device(-3 * 3600_000), B = await device(2 * 3600_000);
console.log("device clocks: A -3 h, B +2 h");
// O teste só vale fora de contexto seguro: é assim que os celulares abrem http://<ip-da-placa>. Em localhost o
// navegador é mais permissivo
for (const c of [A, B]) {
  if (await ev(c, "window.isSecureContext") !== false) throw new Error("secure context: run through the LAN IP, not localhost");
}
console.log("isSecureContext=false on both devices");
// O style.css carregou: sem ele o body não é flex
if (await ev(A, "getComputedStyle(document.body).display") !== "flex") throw new Error("style.css was not applied");
const idA = await me(A), idB = await me(B);
console.log("ids", idA, idB);
if (idA === idB || !/^[0-9a-f]{8}$/.test(idA)) throw new Error("ids are equal or invalid");

await send(A, "Hello from A");
await until(B, `document.querySelectorAll(".msg").length === 1`, "B to see the 1st");
await send(B, "<b>hi</b> from B");
await until(A, `document.querySelectorAll(".msg").length === 2`, "A to see the 2nd");
// XSS: o texto tem de aparecer literal, sem virar elemento
if (await ev(A, `document.querySelectorAll(".msg .text b").length`) !== 0) throw new Error("innerHTML!");

// Corrida: os dois enviam ao mesmo tempo sobre a mesma cabeça; o reenvio automático tem de resolver
await Promise.all([send(A, "race A"), send(B, "race B")]);
await until(A, `document.querySelectorAll(".msg").length === 4`, "A to see all 4", 8000);
await until(B, `document.querySelectorAll(".msg").length === 4`, "B to see all 4", 8000);
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

// Mensagem acima de 320 bytes UTF-8: botão desabilitado
await ev(A, `(() => { const t = document.getElementById("text"); t.removeAttribute("maxlength"); t.value = "é".repeat(161); t.dispatchEvent(new Event("input")); })()`);
if (!(await ev(A, `document.getElementById("send").disabled`))) throw new Error("accepted 322 bytes");
console.log("height A:", await ev(A, `document.getElementById("height").textContent`));
console.log(`FINGERPRINT ${await ev(A, `document.getElementById("height").textContent`)} ${fpA}`);
console.log("E2E OK");
await cmd("session.end").catch(() => {});
Deno.exit(0);
