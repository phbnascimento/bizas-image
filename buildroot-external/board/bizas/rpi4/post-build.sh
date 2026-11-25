#!/usr/bin/env bash
# Embarca a aplicação no rootfs: copia os tars dos containers (arm64), o docker/provision.sh e o docker/version.env
# para /opt/bizas, de onde o /etc/init.d/S99bizas os usa no 1º boot. Também gera o /etc/issue (boas-vindas do console)
# com a versão do docker/version.env, para ela nunca ficar atrasada, tira o S80dnsmasq do pacote (o dnsmasq é do
# S39wifi-ap) e põe ao lado do firmware do Wi-Fi as licenças dele
#
# Os tars não ficam no Git nem no overlay: são gerados por scripts/containers-build.sh arm64, que grava o SHA-256 de
# cada um em evidence/hashes-containers.txt. Aqui se confere que o tar embarcado é exatamente o registrado e que é
# mesmo arm64, antes de copiar
#
# $1 = TARGET_DIR (o Buildroot passa). BR2_EXTERNAL_BIZAS_PATH vem do ambiente
set -euo pipefail

TARGET="${1:?usage: post-build.sh TARGET_DIR}"
EXT="${BR2_EXTERNAL_BIZAS_PATH:?BR2_EXTERNAL_BIZAS_PATH not set}"
ROOT="$(cd "$EXT/.." && pwd)"
# shellcheck source=../../../../docker/version.env
. "$ROOT/docker/version.env"
TARS="$ROOT/output/containers/arm64"
HASHES="$ROOT/evidence/hashes-containers.txt"
DEST="$TARGET/opt/bizas"

die() { echo "post-build: ERROR: $*" >&2; exit 1; }

[ -f "$HASHES" ] || die "$HASHES not found; run scripts/containers-build.sh arm64"
for img in "$IMG_VALIDATOR" "$IMG_SERVER"; do
  tar="$TARS/$img-$VERSION.tar"
  [ -f "$tar" ] || die "$tar not found; run scripts/containers-build.sh arm64"
  want="$(awk -v f="$img-$VERSION.tar" '$2 == f {print $1}' "$HASHES")"
  [ -n "$want" ] || die "$img-$VERSION.tar is not listed in $HASHES"
  got="$(sha256sum "$tar" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || die "$tar has sha256 $got, but $HASHES records $want"
  python3 -I "$ROOT/scripts/lib/check-image-tar.py" "$tar" arm64 || die "$tar is not a linux/arm64 image"
done

# O Buildroot nunca apaga de TARGET_DIR o que sobrou de um build anterior: sem isto, os tars de uma versão antiga
# ficariam em /opt/bizas ao lado dos novos
rm -rf "$DEST"
mkdir -p "$DEST"
for img in "$IMG_VALIDATOR" "$IMG_SERVER"; do
  install -m 0644 "$TARS/$img-$VERSION.tar" "$DEST/"
done
install -m 0755 "$ROOT/docker/provision.sh" "$DEST/provision.sh"
install -m 0644 "$ROOT/docker/version.env" "$DEST/version.env"
# Quem sobe o dnsmasq é o S39wifi-ap, junto com o hostapd; o S80dnsmasq do pacote subiria uma segunda instância
rm -f "$TARGET/etc/init.d/S80dnsmasq"
# O firmware do Wi-Fi é distribuído na imagem, e a licença da Broadcom exige que vá junto uma cópia dela (seção 2 do
# LICENCE.broadcom_bcm43xx). O pacote linux-firmware instala só os binários; as licenças vão para /lib/firmware, ao lado
# deles, como no próprio linux-firmware. BUILD_DIR vem do ambiente do Buildroot
FW_SRC="$(ls -d "${BUILD_DIR:?BUILD_DIR not set}"/linux-firmware-*/ 2>&1 | head -1 || true)"
[ -d "$FW_SRC" ] || die "linux-firmware build directory not found in $BUILD_DIR: $FW_SRC"
for lic in LICENCE.broadcom_bcm43xx LICENCE.cypress; do
  [ -f "$FW_SRC/$lic" ] || die "$FW_SRC$lic not found"
  install -m 0644 "$FW_SRC/$lic" "$TARGET/lib/firmware/$lic"
done
# A arte vem de assets/; o gerador dobra os \ e os %, que o getty trata como escape
python3 -I "$ROOT/scripts/lib/make-issue.py" "$ROOT/assets/bizas-ascii-20lines.txt" "$VERSION" > "$TARGET/etc/issue"
echo "post-build: application installed in /opt/bizas ($IMG_VALIDATOR and $IMG_SERVER $VERSION)"
