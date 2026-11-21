#!/usr/bin/env bash
# Compila a imagem da Raspberry Pi 4 a partir do bizas_rpi4_defconfig e grava o SHA-256 do resultado em evidence/
#
# Antes de compilar: buildroot/ tem de ser o 2026.05.1 (scripts/fetch-buildroot.sh) e os tars arm64 dos containers têm
# de existir (scripts/containers-build.sh arm64); o post-build confere os tars contra evidence/hashes-containers.txt
#
# Saída: output/buildroot/images/sdcard.img e output/images/bizas-rpi4.img.xz, com os hashes em evidence/hashes-image.txt
#
# Uso: scripts/build-image.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BR="$ROOT/buildroot"
EXT="$ROOT/buildroot-external"
OUT="$ROOT/output/buildroot"
BR_VERSION="2026.05.1"

die() { echo "ERROR: $*" >&2; exit 1; }

[ -f "$BR/Makefile" ] || die "buildroot/ not found; run scripts/fetch-buildroot.sh"
grep -qxF "export BR2_VERSION := $BR_VERSION" "$BR/Makefile" || die "buildroot/ is not Buildroot $BR_VERSION"
# shellcheck source=../docker/version.env
. "$ROOT/docker/version.env"
for img in "$IMG_VALIDATOR" "$IMG_SERVER"; do
  [ -f "$ROOT/output/containers/arm64/$img-$VERSION.tar" ] || die "missing $img-$VERSION.tar; run scripts/containers-build.sh arm64"
done

echo "== loading bizas_rpi4_defconfig"
make -C "$BR" O="$OUT" BR2_EXTERNAL="$EXT" bizas_rpi4_defconfig >/dev/null

echo "== building (the first build downloads and compiles the toolchain, kernel and Docker: it takes a while)"
START="$(date +%s)"
make -C "$BR" O="$OUT"
echo "== build took $(( $(date +%s) - START )) s"

IMG="$OUT/images/sdcard.img"
[ -f "$IMG" ] || die "$IMG was not produced"
mkdir -p "$ROOT/output/images"
XZ="$ROOT/output/images/bizas-rpi4.img.xz"
echo "== compressing to $(realpath --relative-to="$ROOT" "$XZ")"
xz -T0 -6 -c "$IMG" > "$XZ.part" && mv "$XZ.part" "$XZ"

mkdir -p "$ROOT/evidence"
{
  (cd "$OUT/images" && sha256sum sdcard.img)
  (cd "$ROOT/output/images" && sha256sum bizas-rpi4.img.xz)
} > "$ROOT/evidence/hashes-image.txt"
echo "== evidence/hashes-image.txt"
cat "$ROOT/evidence/hashes-image.txt"
ls -l "$IMG" "$XZ"
