#!/usr/bin/env bash
# Sobe o Bizas no PC para testar a página: compila o validator e o server, roda os dois como processos locais (sem
# Docker) e escuta no IP da rede local, para abrir a página no próprio PC ou em outro aparelho da mesma rede
#
# Nem tudo existe fora da placa: não há containers, nem o init, nem os comandos set-date e set-auto-date em /usr/bin (o
# set-date funciona chamando o binário, como mostrado ao subir). A cadeia fica em output/dev/data/chain.bin
#
# Uso: scripts/dev-server.sh [--port N] [--fresh]
#   --port N   porta da página (padrão 8080); N+1 é a porta de manutenção (só loopback) e N+2 o validator (só loopback)
#   --fresh    apaga a cadeia de uma execução anterior antes de subir
# Para com Ctrl+C
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="$ROOT/output/dev"
PORT=8080
FRESH=no

die() { echo "ERROR: $*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) [ "$#" -ge 2 ] || die "--port needs a number"; PORT="$2"; shift 2 ;;
    --fresh) FRESH=yes; shift ;;
    -h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (use --port N or --fresh)" ;;
  esac
done
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65533 ] || die "--port must be a number from 1024 to 65533"
ADMIN_PORT=$((PORT + 1))
VALIDATOR_PORT=$((PORT + 2))

for p in "$PORT" "$ADMIN_PORT" "$VALIDATOR_PORT"; do
  if ss -ltnH "sport = :$p" | grep -q .; then
    ss -ltnp "sport = :$p" >&2
    die "port $p is already in use; pick another with --port"
  fi
done

mkdir -p "$DEV"
[ "$FRESH" = no ] || rm -rf "$DEV/data"
mkdir -p "$DEV/data"

echo "== building"
( cd "$ROOT/application" && go build -o "$DEV/validator" ./validator && go build -o "$DEV/server" ./server )

PIDS=()
cleanup() {
  trap - EXIT INT TERM
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  echo
  echo "stopped; the chain is kept in output/dev/data (use --fresh to start from an empty one)"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

ADDR="127.0.0.1:$VALIDATOR_PORT" DATA_DIR="$DEV/data" "$DEV/validator" 2> >(sed -u 's/^/[validator] /' >&2) &
PIDS+=($!)
ADDR="0.0.0.0:$PORT" ADMIN_ADDR="127.0.0.1:$ADMIN_PORT" VALIDATOR_URL="http://127.0.0.1:$VALIDATOR_PORT" \
  "$DEV/server" 2> >(sed -u 's/^/[server]    /' >&2) &
PIDS+=($!)

ready=""
for _ in $(seq 100); do
  if [ "$(curl -s --max-time 1 "http://127.0.0.1:$PORT/health" || true)" = ok ]; then ready=1; break; fi
  for p in "${PIDS[@]}"; do kill -0 "$p" 2>/dev/null || die "a process exited while starting; see the log above"; done
  sleep 0.1
done
[ -n "$ready" ] || die "the server did not answer /health"

# Endereços IPv4 desta máquina, sem loopback nem os das redes do Docker
IPS="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $2, $4}' | cut -d/ -f1 | grep -vE '^(docker|br-|veth)' || true)"

echo
echo "Bizas is up. Open it from this PC or from another device on the same network:"
echo "  http://127.0.0.1:$PORT"
if [ -n "$IPS" ]; then
  while read -r ifname ip; do echo "  http://$ip:$PORT   ($ifname)"; done <<<"$IPS"
else
  echo "  (no network address found besides loopback)"
fi
echo
echo "Other devices cannot connect? Check the firewall of this PC for TCP port $PORT."
echo "Show the date on the page (the board runs this through docker exec):"
echo "  ADMIN_ADDR=127.0.0.1:$ADMIN_PORT $DEV/server set-date 2026-11-20-00-39-55"
echo "  ADMIN_ADDR=127.0.0.1:$ADMIN_PORT $DEV/server set-auto-date"
echo "Verify the chain:  curl -s http://127.0.0.1:$PORT/chain -o /tmp/chain.bin && $DEV/validator verify /tmp/chain.bin"
echo "Press Ctrl+C to stop."

wait -n "${PIDS[@]}" || true
die "a process exited; see the log above"
