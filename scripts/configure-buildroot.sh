#!/usr/bin/env bash
# Gera a configuração do Buildroot do Bizas de forma reproduzível e confere o resultado:
#   1. confere que buildroot/ é o Buildroot 2026.05.1 exigido pelo edital
#   2. carrega o raspberrypi4_64_defconfig e mescla buildroot-external/board/bizas/rpi4/buildroot.fragment
#   3. confere, no .config, cada opção do fragmento e as que o docker-engine seleciona
#   4. grava buildroot-external/configs/bizas_rpi4_defconfig (savedefconfig)
#   5. ida e volta: recarrega o defconfig gravado do zero e confere de novo
#
# Não compila nada e não baixa nada: só gera e confere a configuração. A saída fica em output/buildroot (ignorado)
#
# Uso: scripts/configure-buildroot.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BR="$ROOT/buildroot"
EXT="$ROOT/buildroot-external"
OUT="$ROOT/output/buildroot"
FRAGMENT="$EXT/board/bizas/rpi4/buildroot.fragment"
DEFCONFIG="$EXT/configs/bizas_rpi4_defconfig"
BR_VERSION="2026.05.1"

info() { echo "== $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
br_make() { make -C "$BR" O="$OUT" BR2_EXTERNAL="$EXT" "$@"; }

# 1. Versão do Buildroot. buildroot/ é ignorado pelo Git, então pode ser qualquer coisa
[ -f "$BR/Makefile" ] || die "$BR/Makefile not found; extract buildroot-$BR_VERSION.tar.gz into buildroot/"
grep -qxF "export BR2_VERSION := $BR_VERSION" "$BR/Makefile" \
  || die "buildroot/ is not Buildroot $BR_VERSION (see BR2_VERSION in $BR/Makefile)"

# Os scripts de init têm de ser executáveis no overlay: o Buildroot copia o modo como está
for f in "$ROOT"/rootfs-overlay/etc/init.d/S* "$ROOT"/rootfs-overlay/usr/bin/* "$EXT/board/bizas/rpi4/post-build.sh"; do
  [ -x "$f" ] || die "$f is not executable"
done
for f in "$ROOT"/rootfs-overlay/etc/init.d/S* "$ROOT"/rootfs-overlay/usr/bin/*; do
  sh -n "$f" || die "$f has a syntax error"
done

# Linhas de opção do fragmento, sem comentários nem linhas vazias
fragment_options() { grep -vE '^[[:space:]]*(#|$)' "$FRAGMENT"; }

# 3. Cada opção pedida tem de estar no .config exatamente como foi pedida. Se uma dependência não for satisfeita, o
# kconfig descarta a opção em silêncio; é isso que esta conferência pega
check_config() {
  local missing=0 opt
  while IFS= read -r opt; do
    if ! grep -qxF "$opt" "$OUT/.config"; then
      echo "  missing in .config: $opt" >&2
      missing=1
    fi
  done < <(fragment_options; printf '%s\n' \
    'BR2_aarch64=y' \
    'BR2_LINUX_KERNEL=y' \
    'BR2_PACKAGE_CONTAINERD=y' \
    'BR2_PACKAGE_IPTABLES=y' \
    'BR2_PACKAGE_CGROUPFS_V2_MOUNT=y' \
    'BR2_PACKAGE_KMOD=y')
  [ "$missing" -eq 0 ] || die "options above were dropped by kconfig (unmet dependency?); look them up in 'make menuconfig' with '/'"
}

# 2. Base da Pi 4 + fragmento
info "loading raspberrypi4_64_defconfig"
br_make raspberrypi4_64_defconfig >/dev/null
info "merging $(realpath --relative-to="$ROOT" "$FRAGMENT")"
LOG="$(KCONFIG_CONFIG="$OUT/.config" "$BR/support/kconfig/merge_config.sh" -m -O "$OUT" "$OUT/.config" "$FRAGMENT" 2>&1)" \
  || { echo "$LOG"; die "merge_config.sh failed"; }
LOG="$(br_make olddefconfig 2>&1)" || { echo "$LOG"; die "make olddefconfig failed"; }

info "checking .config"
check_config

# 4. defconfig versionado
info "saving $(realpath --relative-to="$ROOT" "$DEFCONFIG")"
br_make savedefconfig BR2_DEFCONFIG="$DEFCONFIG" >/dev/null

# 5. Ida e volta: do zero, só a partir do defconfig gravado
info "round trip: reloading bizas_rpi4_defconfig from scratch"
rm -f "$OUT/.config"
br_make bizas_rpi4_defconfig >/dev/null
check_config
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
br_make savedefconfig BR2_DEFCONFIG="$TMP" >/dev/null
cmp -s "$TMP" "$DEFCONFIG" || { diff "$DEFCONFIG" "$TMP" || true; die "savedefconfig changed after the round trip"; }

info "configuration OK: $(wc -l < "$DEFCONFIG") lines in bizas_rpi4_defconfig; nothing was built"
