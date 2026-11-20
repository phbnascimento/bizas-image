// Como a página mostra a hora de uma mensagem. Funções puras, testadas em bizas.test.js
//
// A hora da placa pode não ser de calendário (sem RTC e sem internet), então o padrão é a idade da mensagem
// ("5 min ago"), medida no próprio relógio da placa. Com o set-date (ou set-auto-date), o server informa
// realOffset = hora real − hora da placa, e as mensagens desta execução do validator passam a mostrar data e hora.
// Mensagens anteriores a runStart são de uma sessão anterior: o tempo em que a placa ficou desligada não foi contado,
// então nenhuma hora mostrada para elas seria confiável

export function formatAge(ns) {
  const s = Number(ns / 1_000_000_000n);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// stamp, now, runStart e realOffset em ns (BigInt). runStart e realOffset podem ser null
export function formatWhen(stamp, { now, runStart = null, realOffset = null }) {
  if (runStart !== null && stamp < runStart) return "earlier session";
  if (realOffset !== null) return new Date(Number((stamp + realOffset) / 1_000_000n)).toLocaleString();
  const age = now - stamp;
  return formatAge(age > 0n ? age : 0n);
}
