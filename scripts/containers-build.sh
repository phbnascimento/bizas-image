#!/usr/bin/env bash
# Gera as imagens do validator e do server, exporta cada uma em tar (docker save) e confere a arquitetura dentro do tar
# antes de qualquer uso. Para arm64 (a placa), grava o SHA-256 dos tars em evidence/
#
# Uso: scripts/containers-build.sh [arm64|amd64]   (padrão arm64)
#   amd64 serve só para testar no PC sem qemu
set -euo pipefail

ARCH="${1:-arm64}"
case "$ARCH" in arm64 | amd64) ;; *) echo "usage: $0 [arm64|amd64]" >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../docker/version.env
. "$ROOT/docker/version.env"
OUT="$ROOT/output/containers/$ARCH"
mkdir -p "$OUT"

for name in validator server; do
  img="IMG_${name^^}"; img="${!img}"
  ref="$img:$VERSION"
  echo "== build $ref (linux/$ARCH)"
  docker buildx build --platform "linux/$ARCH" --load \
    --build-arg "GOLANG_IMAGE=$GOLANG_IMAGE" \
    -f "$ROOT/docker/Dockerfile.$name" -t "$ref" "$ROOT/application"

  tar="$OUT/$img-$VERSION.tar"
  docker save "$ref" -o "$tar"
  echo "== checking $tar"
  python3 -I "$ROOT/scripts/lib/check-image-tar.py" "$tar" "$ARCH"
  echo "tar size: $(stat -c %s "$tar") bytes"
done

if [ "$ARCH" = arm64 ]; then
  mkdir -p "$ROOT/evidence"
  ( cd "$OUT" && sha256sum "$IMG_VALIDATOR-$VERSION.tar" "$IMG_SERVER-$VERSION.tar" ) \
    > "$ROOT/evidence/hashes-containers.txt"
  echo "== evidence/hashes-containers.txt"
  cat "$ROOT/evidence/hashes-containers.txt"
fi
