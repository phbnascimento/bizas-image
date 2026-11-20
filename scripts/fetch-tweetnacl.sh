#!/usr/bin/env bash
# Baixa o tweetnacl-js fixado do registro do npm, confere o "integrity" (SHA-512) publicado pelo registro e copia o
# nacl-fast.min.js para a página embutida no server. Grava o SHA-256 do arquivo copiado em
# application/server/tweetnacl.sha256, que o teste do Go confere contra o arquivo embutido
#
# Só precisa de rede uma vez; o arquivo resultante vai para o repositório e o build da imagem não baixa nada
#
# Uso: scripts/fetch-tweetnacl.sh
set -euo pipefail

VERSION="1.0.3"
# integrity publicado pelo npm para o tweetnacl 1.0.3. Fixado aqui para que um registro adulterado (metadados e pacote
# trocados juntos) também reprove
PINNED_INTEGRITY="sha512-6rt+RN7aOi1nGMyC4Xa5DdYiukl2UWCbcJft7YhxReBGQD7OAM8Pbxw6YMo4r2diNEA8FEmu32YOn9rhaiE5yw=="
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/application/server/static/nacl-fast.min.js"
SUM_FILE="$ROOT/application/server/tweetnacl.sha256"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsS "https://registry.npmjs.org/tweetnacl/$VERSION" -o "$TMP/meta.json"
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
tar -xzf "$TMP/package.tgz" -C "$TMP/x" package/nacl-fast.min.js package/LICENSE
mkdir -p "$(dirname "$DEST")"
cp "$TMP/x/package/nacl-fast.min.js" "$DEST"
cp "$TMP/x/package/LICENSE" "$(dirname "$DEST")/nacl-LICENSE.txt"

( cd "$(dirname "$DEST")" && sha256sum nacl-fast.min.js ) > "$SUM_FILE"
echo "tweetnacl $VERSION verified ($INTEGRITY)"
cat "$SUM_FILE"
