#!/bin/sh
# Provisiona os containers do Bizas: carrega as imagens (docker load) se faltarem, cria a rede e o volume e cria os dois
# containers com --restart unless-stopped. É idempotente: rodar de novo não recria o que já existe, a não ser um
# container de outra versão
#
# Na placa roda uma vez, no 1º boot; nos seguintes, quem religa os containers é o próprio dockerd. No PC, é usado pelo
# scripts/containers-test.sh
#
# Uso: provision.sh [diretório-com-os-tars]
#   HOST_PORT  porta do host para a página (padrão 80)
# POSIX sh: roda no busybox da placa
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/version.env"
TARS="${1:-$DIR}"
HOST_PORT="${HOST_PORT:-80}"

info() { echo "[provision] $*"; }
die() { echo "[provision] ERROR: $*" >&2; exit 1; }

# Privilégio mínimo: sem capabilities, sem escalar privilégio, rootfs somente leitura e poucos processos. O
# usuário 65532 vem do Dockerfile
COMMON_OPTS="--restart unless-stopped --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64"

load_image() { # imagem
  ref="$1:$VERSION"
  if docker image inspect "$ref" >/dev/null 2>&1; then
    return 0
  fi
  tar="$TARS/$1-$VERSION.tar"
  [ -f "$tar" ] || die "image $ref missing and $tar does not exist"
  info "docker load $tar (this may take a while)"
  docker load -i "$tar"
  docker image inspect "$ref" >/dev/null 2>&1 || die "$tar does not contain $ref"
}

# Remove o container se ele for de outra versão; devolve 0 se ele já existe na versão certa
exists_at_version() { # nome imagem
  img="$(docker inspect -f '{{.Config.Image}}' "$1" 2>/dev/null || true)"
  [ -z "$img" ] && return 1
  [ "$img" = "$2:$VERSION" ] && return 0
  info "$1 runs $img; recreating with $2:$VERSION"
  docker rm -f "$1" >/dev/null
  return 1
}

load_image "$IMG_VALIDATOR"
load_image "$IMG_SERVER"

# Rede definida pelo usuário: só nela o nome "validator" resolve pelo DNS embutido do Docker
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
docker volume inspect "$VOLUME" >/dev/null 2>&1 || docker volume create "$VOLUME" >/dev/null

# validator: sem porta no host; único com volume
if ! exists_at_version "$IMG_VALIDATOR" "$IMG_VALIDATOR"; then
  info "creating $IMG_VALIDATOR"
  # shellcheck disable=SC2086
  docker create --name "$IMG_VALIDATOR" --network "$NETWORK" --network-alias validator \
    -v "$VOLUME:/data" $COMMON_OPTS "$IMG_VALIDATOR:$VERSION" >/dev/null
fi

# server: única porta publicada; sem volume
if ! exists_at_version "$IMG_SERVER" "$IMG_SERVER"; then
  info "creating $IMG_SERVER (port $HOST_PORT -> 5000)"
  # shellcheck disable=SC2086
  docker create --name "$IMG_SERVER" --network "$NETWORK" \
    -p "$HOST_PORT:5000" $COMMON_OPTS "$IMG_SERVER:$VERSION" >/dev/null
fi

docker start "$IMG_VALIDATOR" "$IMG_SERVER" >/dev/null
info "containers started: $IMG_VALIDATOR, $IMG_SERVER"
