#!/usr/bin/env bash
# Obtém o Buildroot 2026.05.1 e o extrai em buildroot/, que o Git ignora
#
# O tarball oficial é baixado para output/dl/ (também ignorado) e só é extraído se o SHA-256 bater com o fixado aqui,
# que é o publicado em https://buildroot.org/downloads/buildroot-2026.05.1.tar.gz.sign. Se o tarball já estiver em
# output/dl/, não há download: o script funciona sem rede
#
# Nunca apaga nada: se buildroot/ já existe e é a versão certa, não faz nada; se é outra versão, para com erro
#
# Uso: scripts/fetch-buildroot.sh
set -euo pipefail

VERSION="2026.05.1"
SHA256="4808d8f0812d7bdb72e6ec7629de2f17c417a3ce7bf5431f752bc9150a162849"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DL="$ROOT/output/dl"
TARBALL="$DL/buildroot-$VERSION.tar.gz"
URL="https://buildroot.org/downloads/buildroot-$VERSION.tar.gz"
DEST="$ROOT/buildroot"

die() { echo "ERROR: $*" >&2; exit 1; }

if [ -e "$DEST" ]; then
  [ -f "$DEST/Makefile" ] || die "$DEST exists but has no Makefile; move it away and run again"
  if grep -qxF "export BR2_VERSION := $VERSION" "$DEST/Makefile"; then
    echo "buildroot/ is already Buildroot $VERSION; nothing to do"
    exit 0
  fi
  die "$DEST is not Buildroot $VERSION (see BR2_VERSION in $DEST/Makefile); move it away and run again"
fi

mkdir -p "$DL"
if [ ! -f "$TARBALL" ]; then
  echo "== downloading $URL"
  curl -fL --retry 3 -o "$TARBALL.part" "$URL"
  mv "$TARBALL.part" "$TARBALL"
fi

echo "== checking SHA-256"
GOT="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
if [ "$GOT" != "$SHA256" ]; then
  die "$TARBALL has SHA-256 $GOT, want $SHA256; delete it and run again"
fi

echo "== extracting into buildroot/"
TMP="$(mktemp -d "$ROOT/.buildroot-extract.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$TARBALL" -C "$TMP" --strip-components=1
grep -qxF "export BR2_VERSION := $VERSION" "$TMP/Makefile" || die "the extracted tree is not Buildroot $VERSION"
mv "$TMP" "$DEST"
trap - EXIT
echo "buildroot/ is Buildroot $VERSION ($(find "$DEST" -type f | wc -l) files)"
