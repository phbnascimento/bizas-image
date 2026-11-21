#!/usr/bin/env bash
# Grava output/buildroot/images/sdcard.img no microSD e confere, lendo de volta, que o cartão ficou igual à imagem
#
# PERIGO: o dd sobrescreve o disco escolhido. Por isso o script:
#   - confere que a imagem contém a aplicação (/opt/bizas) e que é a registrada em evidence/hashes-image.txt
#   - lista os discos e pede para DIGITAR o dispositivo, duas vezes
#   - recusa o disco do sistema (/) e discos acima de 256 GB
#   - lê de volta do cartão exatamente o tamanho da imagem e compara o SHA-256
#
# Uso: scripts/flash-sd.sh [--fast]   (--fast pula a leitura de volta, que leva quase o mesmo tempo da gravação)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/output/buildroot"
IMG="$OUT/images/sdcard.img"
HASHES="$ROOT/evidence/hashes-image.txt"

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "== $*"; }
warn() { echo "WARNING: $*" >&2; }

[ "$(id -u)" -ne 0 ] || die "run as a normal user; the script asks for sudo only to write the card"

VERIFY=yes
case "${1:-}" in
  --fast) VERIFY=no ;;
  "") ;;
  *) die "unknown option: $1 (use --fast to skip the read-back check)" ;;
esac

[ -f "$IMG" ] || die "$IMG not found; run scripts/build-image.sh"

# A imagem tem de conter a aplicação: um sdcard.img sem os tars dá boot, sobe o dockerd e não tem chat
DEBUGFS="$OUT/host/sbin/debugfs"
ROOTFS="$OUT/images/rootfs.ext4"
[ -x "$DEBUGFS" ] && [ -f "$ROOTFS" ] || die "debugfs or rootfs.ext4 missing in output/buildroot; run scripts/build-image.sh"
# shellcheck source=../docker/version.env
. "$ROOT/docker/version.env"
for f in "$IMG_VALIDATOR-$VERSION.tar" "$IMG_SERVER-$VERSION.tar" provision.sh version.env; do
  "$DEBUGFS" -R "stat /opt/bizas/$f" "$ROOTFS" 2>&1 | grep -q '^Inode:' || die "the image has no /opt/bizas/$f"
done
info "the image contains /opt/bizas (containers $VERSION)"

# O cartão gravado tem de ser o artefato registrado: os timestamps de ext4 e vfat mudam o hash a cada build
info "computing the image SHA-256"
IMG_HASH="$(sha256sum "$IMG" | cut -d' ' -f1)"
REC_HASH="$(awk '$2 == "sdcard.img" {print $1}' "$HASHES" 2>/dev/null || true)"
[ -n "$REC_HASH" ] || die "$HASHES has no sdcard.img line; run scripts/build-image.sh"
[ "$REC_HASH" = "$IMG_HASH" ] || die "the image is not the one recorded in evidence/hashes-image.txt:
  recorded: $REC_HASH
  image:    $IMG_HASH
  Run scripts/build-image.sh again so the recorded hash describes this card"

echo
lsblk -d -o NAME,SIZE,MODEL,TRAN,RM,TYPE | grep -v 'loop'
echo
echo "RM=1 means removable media. A microSD is usually sdX (USB reader) or mmcblkX (built-in reader)."
read -r -p "Type ONLY the card device name (e.g. sdb or mmcblk0): " DEV
DEV="${DEV#/dev/}"
[[ "$DEV" =~ ^(sd[a-z]+|mmcblk[0-9]+)$ ]] || die "invalid name: '$DEV'"
[ -b "/dev/$DEV" ] || die "/dev/$DEV does not exist"

ROOT_SRC="$(findmnt -n -o SOURCE /)"
ROOT_DISK="$(lsblk -n -o PKNAME "$ROOT_SRC" 2>/dev/null | head -1 || true)"
[ "$DEV" != "$ROOT_DISK" ] || die "/dev/$DEV is YOUR SYSTEM disk. Aborted."

SIZE_GB=$(( $(lsblk -b -d -n -o SIZE "/dev/$DEV") / 1000000000 ))
[ "$SIZE_GB" -le 256 ] || die "/dev/$DEV has ${SIZE_GB} GB, too big to be the microSD. Aborted."
[ "$(cat "/sys/block/$DEV/removable" 2>/dev/null || echo 0)" = 1 ] || [[ "$DEV" != sd* ]] \
  || warn "/dev/$DEV is not marked removable (some USB readers are like this)"

echo
lsblk "/dev/$DEV"
echo
read -r -p "EVERYTHING on /dev/$DEV (${SIZE_GB} GB) will be ERASED. Type the name again to confirm: " CONF
[ "$CONF" = "$DEV" ] || die "confirmation does not match. Nothing was written."

info "unmounting the partitions of /dev/$DEV"
for p in $(lsblk -n -l -o NAME "/dev/$DEV" | tail -n +2); do
  sudo umount "/dev/$p" 2>/dev/null || true
done

IMG_SIZE="$(stat -c %s "$IMG")"
info "writing $(du -h "$IMG" | cut -f1) to /dev/$DEV"
T_WRITE=$(date +%s)
sudo dd if="$IMG" of="/dev/$DEV" bs=16M status=progress conv=fsync
sync
T_WRITE=$(( $(date +%s) - T_WRITE ))
info "write: ${T_WRITE} s"

if [ "$VERIFY" = no ]; then
  warn "read-back check skipped (--fast): nothing proves the card received the image"
  exit 0
fi

# Leitura de volta: iflag=count_bytes lê só o tamanho da imagem (o cartão é maior); o flushbufs descarta o cache de
# bloco, senão a leitura viria da memória. Sem iflag=direct: ele exige leitura alinhada ao setor, e o último bloco da
# imagem pode ser menor que 4 KB, o que daria falso erro
info "reading $IMG_SIZE bytes back from the card"
T_VERIFY=$(date +%s)
sudo blockdev --flushbufs "/dev/$DEV" \
  || warn "could not drop the block cache of /dev/$DEV; the read-back may come from memory"
CARD_HASH="$(sudo dd if="/dev/$DEV" bs=16M iflag=count_bytes count="$IMG_SIZE" status=none | sha256sum | cut -d' ' -f1)"
T_VERIFY=$(( $(date +%s) - T_VERIFY ))
[ "$CARD_HASH" = "$IMG_HASH" ] || die "the card does not match the image:
  image: $IMG_HASH
  card:  $CARD_HASH
  The write failed or the card is faulty"
info "the card matches the image byte by byte (read-back: ${T_VERIFY} s)"

mkdir -p "$ROOT/evidence"
{
  echo "date: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "device: /dev/$DEV (${SIZE_GB} GB)"
  echo "image: output/buildroot/images/sdcard.img ($IMG_SIZE bytes)"
  echo "image sha256: $IMG_HASH"
  echo "card sha256:  $CARD_HASH"
  echo "times: write ${T_WRITE} s, read-back ${T_VERIFY} s"
} > "$ROOT/evidence/sd-card-written.txt"
info "recorded in evidence/sd-card-written.txt"
