// Imprime uma página em PDF com o Firefox headless pelo WebDriver BiDi (browsingContext.print). O Firefox já tem de
// estar escutando em --remote-debugging-port=<porta>; quem o sobe é o scripts/build-manual.sh
//
// Uso: deno run --allow-net=127.0.0.1:<porta> --allow-write=<dir> print-pdf.ts <porta> <url> <saída.pdf>
const [port, url, out] = Deno.args;
if (!port || !url || !out) {
  console.error("usage: print-pdf.ts <port> <url> <out.pdf>");
  Deno.exit(2);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error("cannot connect to Firefox")); });
let id = 0;
const waiting = new Map<number, (m: Record<string, unknown>) => void>();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
};
// deno-lint-ignore no-explicit-any
function cmd(method: string, params: unknown = {}): Promise<any> {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((ok, fail) =>
    waiting.set(i, (m) => (m.type === "error" ? fail(new Error(`${method}: ${m.error}: ${m.message}`)) : ok(m.result)))
  );
}

await cmd("session.new", { capabilities: {} });
const { context } = await cmd("browsingContext.create", { type: "tab" });
await cmd("browsingContext.navigate", { context, url, wait: "complete" });
// Espera as fontes e todas as imagens (o SVG dos diagramas) antes de imprimir
const ready = await cmd("script.evaluate", {
  expression: `document.fonts.ready
    .then(() => Promise.all([...document.images].map(i => i.complete ? i.naturalWidth > 0 :
      new Promise(r => { i.onload = () => r(true); i.onerror = () => r(false); }))))
    .then(a => a.filter(x => !x).length)`,
  target: { context }, awaitPromise: true,
});
const broken = ready.result?.value ?? -1;
if (broken !== 0) {
  console.error(`ERROR: ${broken} image(s) did not load`);
  Deno.exit(1);
}
const { data } = await cmd("browsingContext.print", {
  context, background: true, shrinkToFit: false,
  page: { width: 21, height: 29.7 }, margin: { top: 0, bottom: 0, left: 0, right: 0 },
});
const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
await Deno.writeFile(out, bytes);
console.log(`${bytes.length} bytes -> ${out}`);
await cmd("session.end").catch(() => {});
Deno.exit(0);
