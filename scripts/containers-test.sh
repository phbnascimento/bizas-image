#!/usr/bin/env bash
# Testa os containers no PC, do jeito que a placa vai provisioná-los: apaga as imagens locais, roda docker/provision.sh
# a partir dos tars (docker load), confere privilégios, portas e volume com docker inspect, espera os dois ficarem
# "healthy" e roda o teste ponta a ponta no navegador contra eles
#
# Em arm64 os containers rodam sob qemu: funcionamento vale, tempo NÃO vale
#
# Uso: scripts/containers-test.sh [amd64|arm64]   (padrão amd64)
#   Requer scripts/containers-build.sh <arch> antes.
#   Recusa rodar se já existir container, rede ou volume do Bizas, para não
#   apagar nada que não tenha criado. Remove tudo o que criou ao sair
set -euo pipefail

ARCH="${1:-amd64}"
case "$ARCH" in arm64 | amd64) ;; *) echo "usage: $0 [amd64|arm64]" >&2; exit 2 ;; esac
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../docker/version.env
. "$ROOT/docker/version.env"
TARS="$ROOT/output/containers/$ARCH"
PORT=18080
V="$IMG_VALIDATOR" S="$IMG_SERVER"

FAILURES=0
ok() { echo "  ok    $*"; }
fail() { echo "  FAIL  $*"; FAILURES=$((FAILURES + 1)); }
check() { # descrição valor-obtido valor-esperado
  if [ "$2" = "$3" ]; then ok "$1 = $2"; else fail "$1: got '$2', want '$3'"; fi
}

for t in "$TARS/$V-$VERSION.tar" "$TARS/$S-$VERSION.tar"; do
  [ -f "$t" ] || { echo "ERROR: $t does not exist; run scripts/containers-build.sh $ARCH" >&2; exit 1; }
done
for c in "$V" "$S"; do
  if docker container inspect "$c" >/dev/null 2>&1; then echo "ERROR: container $c already exists" >&2; exit 1; fi
done
if docker network inspect "$NETWORK" >/dev/null 2>&1; then echo "ERROR: network $NETWORK already exists" >&2; exit 1; fi
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then echo "ERROR: volume $VOLUME already exists" >&2; exit 1; fi
if ss -ltnH "sport = :$PORT" | grep -q .; then echo "ERROR: port $PORT in use" >&2; exit 1; fi

cleanup() {
  echo "== cleaning up"
  docker rm -f "$V" "$S" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== removing local images, so provisioning loads them from the tars"
docker image rm "$V:$VERSION" "$S:$VERSION" >/dev/null 2>&1 || true

echo "== provisioning"
HOST_PORT="$PORT" "$ROOT/docker/provision.sh" "$TARS"
echo "== provisioning again (must be idempotent)"
IDS_BEFORE="$(docker inspect -f '{{.Id}}' "$V" "$S")"
HOST_PORT="$PORT" "$ROOT/docker/provision.sh" "$TARS"
check "containers recreated on the 2nd run" "$(docker inspect -f '{{.Id}}' "$V" "$S")" "$IDS_BEFORE"

echo "== waiting for healthy (up to 60 s)"
for _ in $(seq 120); do
  hv="$(docker inspect -f '{{.State.Health.Status}}' "$V")"
  hs="$(docker inspect -f '{{.State.Health.Status}}' "$S")"
  [ "$hv" = healthy ] && [ "$hs" = healthy ] && break
  sleep 0.5
done
check "$V health" "$hv" healthy
check "$S health" "$hs" healthy

echo "== checks (docker inspect)"
for c in "$V" "$S"; do
  check "$c image architecture" "$(docker image inspect -f '{{.Architecture}}' "$(docker inspect -f '{{.Image}}' "$c")")" "$ARCH"
  check "$c user" "$(docker inspect -f '{{.Config.User}}' "$c")" "65532:65532"
  check "$c read-only rootfs" "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$c")" "true"
  check "$c dropped capabilities" "$(docker inspect -f '{{json .HostConfig.CapDrop}}' "$c")" '["ALL"]'
  check "$c added capabilities" "$(docker inspect -f '{{json .HostConfig.CapAdd}}' "$c")" "null"
  check "$c security-opt" "$(docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$c")" '["no-new-privileges"]'
  check "$c privileged" "$(docker inspect -f '{{.HostConfig.Privileged}}' "$c")" "false"
  check "$c restart policy" "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$c")" "unless-stopped"
  check "$c network" "$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c")" "$NETWORK "
done
check "$V published ports" "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$V")" "{}"
check "$V mounts" "$(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}} {{end}}' "$V")" "volume:$VOLUME:/data "
check "$S published ports" "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$S")" "{\"5000/tcp\":[{\"HostIp\":\"\",\"HostPort\":\"$PORT\"}]}"
check "$S mounts" "$(docker inspect -f '{{len .Mounts}}' "$S")" "0"
check "$V network alias" "$(docker inspect -f "{{json (index .NetworkSettings.Networks \"$NETWORK\").Aliases}}" "$V" | grep -o '"validator"' || true)" '"validator"'

echo "== volume owner (golang image only to have stat)"
check "owner of /data in the volume" "$(docker run --rm -v "$VOLUME:/data" "$GOLANG_IMAGE" stat -c %u:%g /data)" "65532:65532"

echo "== through the host port"
check "server /health" "$(curl -s --max-time 2 "http://127.0.0.1:$PORT/health")" "ok"
VALIDATOR_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$V")"
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:8081/health"; then
  fail "validator answers on 127.0.0.1:8081 on the host"
else
  ok "validator does not answer on 127.0.0.1:8081 on the host"
fi
echo "  (validator IP on $NETWORK: $VALIDATOR_IP; reachable only from inside it)"

echo "== validator goes down: the server must go to 503 and recover on its own"
docker stop "$V" >/dev/null
check "/health with validator stopped" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/health")" "503"
docker start "$V" >/dev/null
back=""
for _ in $(seq 60); do
  [ "$(curl -s --max-time 1 "http://127.0.0.1:$PORT/health")" = ok ] && { back=1; break; }
  sleep 0.5
done
check "/health after restarting the validator" "${back:-did not recover}" "1"

# O "docker kill" não simula uma queda do processo: ele marca o container como parado manualmente (moby
# daemon/kill.go, killWithSignal: HasBeenManuallyStopped = true), e aí o unless-stopped não religa

echo "== browser end-to-end test, against the containers"
e2e_rc=0
EXTERNAL_PORT="$PORT" LOG_VALIDATOR="docker logs $V" SET_DATE_CMD="docker exec $S /app" "$ROOT/scripts/e2e/browser.sh" \
  || e2e_rc=$?
check "end-to-end test" "$e2e_rc" "0"

echo "== set-date and set-auto-date: the board commands, run here against the real containers"
SETDATE="$ROOT/rootfs-overlay/usr/bin/set-date"
SETAUTO="$ROOT/rootfs-overlay/usr/bin/set-auto-date"
out="$(BIZAS_DIR="$ROOT/docker" "$SETDATE" 2026-11-20-00-39-55 2>&1)" && rc=0 || rc=$?
echo "  $out"
check "set-date exit code" "$rc" "0"
case "$out" in *"maps to 2026-11-20T00:39:55Z"*) ok "set-date read the date as UTC by default" ;; *) fail "set-date output: $out" ;; esac
out="$(BIZAS_DIR="$ROOT/docker" "$SETDATE" 2026-11-20-00-39-55 --tz -03:00 2>&1)" && rc=0 || rc=$?
check "set-date --tz -03:00: exit code" "$rc" "0"
case "$out" in *"maps to 2026-11-20T03:39:55Z"*) ok "set-date --tz -03:00 shifted the date by 3 h" ;; *) fail "set-date --tz output: $out" ;; esac
out="$(BIZAS_DIR="$ROOT/docker" "$SETDATE" 2026-11-20 2>&1)" && rc=0 || rc=$?
check "set-date with a bad date: exit code" "$rc" "2"
case "$out" in *"date must be YYYY-MM-DD-hh-mm-ss"*) ok "set-date explains the format" ;; *) fail "set-date output: $out" ;; esac
out="$(BIZAS_DIR="$ROOT/docker" "$SETAUTO" 2>&1)" && rc=0 || rc=$?
echo "  $out" | head -3
case "$rc:$out" in
  0:*"set-auto-date: ok:"*) ok "set-auto-date got the time from the network" ;;
  1:*"could not get the time from the network"*) ok "set-auto-date without network: clear error (rc 1)" ;;
  *) fail "set-auto-date: rc $rc, output: $out" ;;
esac
# Sem rede nenhuma, o resultado não pode depender da sorte: tem de falhar com a mensagem que diz o que fazer
out="$(docker run --rm --network none "$S:$VERSION" set-auto-date 2>&1)" && rc=0 || rc=$?
check "set-auto-date with no network at all: exit code" "$rc" "1"
case "$out" in
  *"could not get the time from the network"*"Use set-date"*) ok "set-auto-date with no network: English error suggesting set-date" ;;
  *) fail "set-auto-date with no network: $out" ;;
esac

# Espera o /health do server, que só dá 200 com o validator de pé e a cadeia carregada
wait_health() {
  for _ in $(seq 60); do
    [ "$(curl -s --max-time 1 "http://127.0.0.1:$PORT/health")" = ok ] && return 0
    sleep 0.5
  done
  return 1
}
chain_sum() { curl -sf "http://127.0.0.1:$PORT/chain" | sha256sum | cut -d' ' -f1; }

echo "== persistence: restarting the validator keeps the chain"
BEFORE_SIZE="$(curl -sf "http://127.0.0.1:$PORT/chain" | wc -c)"
BEFORE="$(chain_sum)"
check "chain size before restart (6 blocks from the browser test)" "$BEFORE_SIZE" "3072"
docker restart "$V" >/dev/null
wait_health || fail "validator did not come back after restart"
check "chain after validator restart" "$(chain_sum)" "$BEFORE"

echo "== power loss in the middle of a write: an incomplete tail is dropped on start"
docker run --rm -v "$VOLUME:/data" "$GOLANG_IMAGE" sh -c 'head -c 300 /dev/urandom >> /data/chain.bin'
check "chain.bin size with 300 stray bytes" \
  "$(docker run --rm -v "$VOLUME:/data" "$GOLANG_IMAGE" stat -c %s /data/chain.bin)" "$((BEFORE_SIZE + 300))"
docker restart "$V" >/dev/null
wait_health || fail "validator did not come back after the stray bytes"
check "chain after dropping the incomplete tail" "$(chain_sum)" "$BEFORE"
check "chain.bin size after start" \
  "$(docker run --rm -v "$VOLUME:/data" "$GOLANG_IMAGE" stat -c %s /data/chain.bin)" "$BEFORE_SIZE"
if docker logs "$V" 2>&1 | grep -q 'dropped an incomplete block'; then
  ok "validator logged the dropped tail"
else
  fail "validator did not log the dropped tail"
fi

echo "== logs (last lines)"
docker logs "$V" 2>&1 | tail -5
docker logs "$S" 2>&1 | tail -5

if [ "$FAILURES" -ne 0 ]; then echo "FAILED: $FAILURES failure(s)"; exit 1; fi
echo "CONTAINERS PASSED ($ARCH)"
