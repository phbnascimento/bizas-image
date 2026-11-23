#!/usr/bin/env bash
# Teste ponta a ponta no PC: compila o validator e o server, sobe os dois, abre a página pelo IP da LAN
# em dois "aparelhos" isolados no Firefox headless e confere a cadeia exportada com "validator verify", inclusive com um
# byte sabotado
#
# Requer: go, deno, firefox, curl, ip, zbarimg (lê de volta os QR codes)
# Uso: scripts/e2e/browser.sh [ip-da-lan]
#   EXTERNAL_PORT=<porta>  não sobe os binários: testa o server que já responde
#                          em http://<ip-da-lan>:<porta> (ex.: os containers)
#   LOG_VALIDATOR="<cmd>"  comando que mostra o log do validator nesse caso
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
command -v zbarimg >/dev/null || { echo "ERROR: zbarimg not found (package zbar); the test reads the QR codes with it" >&2; exit 1; }
IP="${1:-}"
if [ -z "$IP" ]; then
  IP="$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}' || true)"
fi
case "$IP" in "" | 127.*) echo "ERROR: no LAN IP (found '${IP}'); pass one as an argument" >&2; exit 1 ;; esac

# Porta ocupada faria o teste falar com outro processo (e passar por engano)
PORTS="18081 15000 15001 9333"
[ -n "${EXTERNAL_PORT:-}" ] && PORTS="9333"
for port in $PORTS; do
  if ss -ltnH "sport = :$port" | grep -q .; then
    echo "ERROR: port $port already in use:" >&2; ss -ltnp "sport = :$port" >&2; exit 1
  fi
done

TMP="$(mktemp -d)"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

# O binário local também serve para o "validator verify" no fim
( cd "$ROOT/application" && go build -o "$TMP/validator" ./validator && go build -o "$TMP/server" ./server )

mkdir "$TMP/profile"
if [ -z "${EXTERNAL_PORT:-}" ]; then
  mkdir "$TMP/data"
  ADDR=127.0.0.1:18081 DATA_DIR="$TMP/data" "$TMP/validator" 2> "$TMP/validator.log" & PIDS+=($!)
  ADDR=0.0.0.0:15000 ADMIN_ADDR=127.0.0.1:15001 VALIDATOR_URL=http://127.0.0.1:18081 "$TMP/server" 2> "$TMP/server.log" & PIDS+=($!)
  # set-date pelo próprio binário, como na placa (lá via docker exec)
  SET_DATE_CMD="env ADMIN_ADDR=127.0.0.1:15001 $TMP/server"
  LOG_VALIDATOR="cat $TMP/validator.log"
fi
firefox --headless --no-remote --profile "$TMP/profile" --remote-debugging-port=9333 about:blank > "$TMP/firefox.log" 2>&1 & PIDS+=($!)

BASE="http://$IP:${EXTERNAL_PORT:-15000}"
ready=""
for _ in $(seq 100); do
  if curl -sf -o /dev/null --max-time 1 "$BASE/health" && curl -s -o /dev/null --max-time 1 http://127.0.0.1:9333/; then ready=1; break; fi
  sleep 0.2
done
[ -n "$ready" ] || { echo "ERROR: server or Firefox did not start" >&2; cat "$TMP"/*.log >&2; exit 1; }

echo "== page at $BASE"
RC=0
SET_DATE_CMD="${SET_DATE_CMD:-}" timeout 60 deno run --allow-net --allow-env=SET_DATE_CMD --allow-run --allow-write=/tmp "$ROOT/scripts/e2e/browser.ts" "$BASE" \
  | tee "$TMP/browser.out" || RC=${PIPESTATUS[0]}

echo "== validator log"; ${LOG_VALIDATOR:-true}
[ "$RC" -eq 0 ] || { echo "FAILED: browser test (rc=$RC)" >&2; exit 1; }

curl -sf "$BASE/chain" -o "$TMP/chain.bin"
echo "== validator verify (exported chain, $(stat -c %s "$TMP/chain.bin") bytes)"
"$TMP/validator" verify "$TMP/chain.bin"

# A impressão digital que a página mostra tem de ser a que qualquer pessoa calcula sobre a cadeia exportada
PAGE_FP="$(sed -n 's/^FINGERPRINT \([0-9]*\) \([0-9a-f]*\)$/#\1 \2/p' "$TMP/browser.out")"
FILE_FP="$("$TMP/validator" fingerprint "$TMP/chain.bin")"
echo "== fingerprint: page '$PAGE_FP', exported chain '$FILE_FP'"
[ -n "$PAGE_FP" ] && [ "$PAGE_FP" = "$FILE_FP" ] || { echo "FAILED: the page fingerprint does not match the exported chain" >&2; exit 1; }

# Sabotagem: um byte no data do bloco 2 tem de reprovar no bloco 2
cp "$TMP/chain.bin" "$TMP/sabotaged.bin"
printf '\x58' | dd of="$TMP/sabotaged.bin" bs=1 seek=$((512 * 2 + 200)) conv=notrunc status=none
echo "== validator verify (byte 1224 sabotaged)"
OUTPUT="$("$TMP/validator" verify "$TMP/sabotaged.bin" || true)"
echo "$OUTPUT"
case "$OUTPUT" in "INVALID: FRAUD at block 2 "*) ;; *) echo "FAILED: the sabotage was not detected at block 2" >&2; exit 1 ;; esac

echo "E2E PASSED"
