#!/usr/bin/env bash
# Baixa o qrcode-generator fixado do registro do npm (MIT, Kazuhiko Arase), confere o "integrity" (SHA-512) publicado
# pelo registro e copia o qrcode.js para a página embutida no server. Grava o SHA-256 do arquivo copiado em
# application/server/qrcode.sha256, que o teste do Go confere contra o arquivo embutido. A licença MIT está no
# cabeçalho do próprio qrcode.js
#
# Só precisa de rede uma vez; o arquivo resultante vai para o repositório e o build da imagem não baixa nada
#
# Uso: scripts/fetch-qrcode.sh
set -euo pipefail

VERSION="1.4.4"
# integrity publicado pelo npm para o qrcode-generator 1.4.4. Fixado aqui para que um registro adulterado (metadados e
# pacote trocados juntos) também reprove
PINNED_INTEGRITY="sha512-HM7yY8O2ilqhmULxGMpcHSF1EhJJ9yBj8gvDEuZ6M+KGJ0YY2hKpnXvRD+hZPLrDVck3ExIGhmPtSdcjC+guuw=="
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/application/server/static/qrcode.js"
SUM_FILE="$ROOT/application/server/qrcode.sha256"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsS "https://registry.npmjs.org/qrcode-generator/$VERSION" -o "$TMP/meta.json"
INTEGRITY="$(jq -r '.dist.integrity // empty' "$TMP/meta.json")"
TARBALL="$(jq -r '.dist.tarball // empty' "$TMP/meta.json")"
[ -n "$INTEGRITY" ] && [ -n "$TARBALL" ] || { echo "ERROR: metadata without dist.integrity/tarball" >&2; exit 1; }
if [ "$INTEGRITY" != "$PINNED_INTEGRITY" ]; then
  echo "ERROR: the registry publishes a different integrity for $VERSION" >&2
  echo "  registry: $INTEGRITY" >&2
  echo "  pinned:   $PINNED_INTEGRITY" >&2
  exit 1
fi

curl -fsS "$TARBALL" -o "$TMP/package.tgz"
[ -n "${SABOTAGE_TGZ:-}" ] && printf x >> "$TMP/package.tgz"  # só para testar a conferência
COMPUTED="sha512-$(openssl dgst -sha512 -binary "$TMP/package.tgz" | base64 -w0)"
if [ "$COMPUTED" != "$INTEGRITY" ]; then
  echo "ERROR: integrity mismatch" >&2
  echo "  registry: $INTEGRITY" >&2
  echo "  computed: $COMPUTED" >&2
  exit 1
fi

mkdir "$TMP/x"
tar -xzf "$TMP/package.tgz" -C "$TMP/x" package/qrcode.js
grep -q "Licensed under the MIT license" "$TMP/x/package/qrcode.js" || { echo "ERROR: no MIT notice in qrcode.js" >&2; exit 1; }
mkdir -p "$(dirname "$DEST")"
cp "$TMP/x/package/qrcode.js" "$DEST"

( cd "$(dirname "$DEST")" && sha256sum qrcode.js ) > "$SUM_FILE"
echo "qrcode-generator $VERSION verified ($INTEGRITY)"
cat "$SUM_FILE"
