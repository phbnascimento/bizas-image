#!/usr/bin/env bash
# Confere a imagem pronta sem montar nada: lê o rootfs com debugfs e a partição de boot com mtools, confere o kernel
# contra o fragmento do Docker e o check-config.sh do próprio docker-engine, e passa os scripts de init pelo sh do
# BusyBox da imagem (via binfmt/qemu)
#
# Uso: scripts/check-image.sh   (depois de scripts/build-image.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/output/buildroot"
ROOTFS="$OUT/images/rootfs.ext4"
BOOT="$OUT/images/boot.vfat"
DEBUGFS="$OUT/host/sbin/debugfs"
MTYPE="$OUT/host/bin/mtype"
MDIR="$OUT/host/bin/mdir"
BOARD="$ROOT/buildroot-external/board/bizas/rpi4"
# shellcheck source=../docker/version.env
. "$ROOT/docker/version.env"

FAILURES=0
ok() { echo "  ok    $*"; }
fail() { echo "  FAIL  $*"; FAILURES=$((FAILURES + 1)); }
die() { echo "ERROR: $*" >&2; exit 1; }

for f in "$ROOTFS" "$BOOT" "$DEBUGFS" "$MTYPE" "$MDIR"; do
  [ -e "$f" ] || die "$f not found; run scripts/build-image.sh"
done

# Antes de concluir algo sobre o conteúdo, provar que deu para ler o rootfs
rd() { "$DEBUGFS" -R "$1" "$ROOTFS" 2>/dev/null; }
case "$("$DEBUGFS" -R 'stat /etc/hostname' "$ROOTFS" 2>&1)" in
  *"Inode:"*) ;;
  *) die "could not read $ROOTFS as ext4" ;;
esac
# Nomes de um diretório: o "ls -p" do debugfs dá uma linha /inode/modo/uid/gid/nome/tamanho/ por entrada
names() { rd "ls -p $1" | awk -F/ 'NF > 6 && $6 != "." && $6 != ".." {print $6}' | sort; }
# debugfs mostra o modo em octal com o tipo; só os 4 últimos dígitos interessam
mode() { rd "stat $1" | sed -n 's/.*Mode: *0*\([0-7]*\).*/\1/p' | tail -c 5; }

echo "== rootfs ($(realpath --relative-to="$ROOT" "$ROOTFS"))"
[ "$(rd 'cat /etc/hostname')" = bizas ] && ok "hostname bizas" || fail "hostname: $(rd 'cat /etc/hostname')"
SHADOW_ROOT="$(rd 'cat /etc/shadow' | grep '^root:' | cut -d: -f2)"
case "$SHADOW_ROOT" in
  '$5$'*) ok "root has a SHA-256 crypt password" ;;
  *) fail "root password field in /etc/shadow: '${SHADOW_ROOT:-empty}'" ;;
esac
if command -v openssl >/dev/null; then
  SALT="$(echo "$SHADOW_ROOT" | cut -d'$' -f3)"
  [ "$(openssl passwd -5 -salt "$SALT" bizasprotocol)" = "$SHADOW_ROOT" ] \
    && ok "root password is bizasprotocol" || fail "root password hash does not match bizasprotocol"
fi

# Boas-vindas do console: o issue da imagem é o que o gerador faz da arte e da VERSION, e mostra a versão e os RAs
ISSUE_WANT="$(python3 -I "$ROOT/scripts/lib/make-issue.py" "$ROOT/assets/bizas-ascii-20lines.txt" "$(sed -n 's/^VERSION=//p' "$ROOT/docker/version.env")")"
ISSUE_GOT="$(rd 'cat /etc/issue')"
[ "$ISSUE_GOT" = "$ISSUE_WANT" ] && ok "/etc/issue is the welcome banner for $(sed -n 's/^VERSION=//p' "$ROOT/docker/version.env")" \
  || fail "/etc/issue differs from the welcome banner (art, version and members)"
for ra in 226146 226013 226326 230610; do
  echo "$ISSUE_GOT" | grep -q "[[:space:]]$ra\$" && ok "/etc/issue lists RA $ra" || fail "/etc/issue does not list RA $ra"
done
# Cores: a arte em magenta (ESC[35m), o texto em amarelo claro (ESC[93m) e o reset antes do login (ESC[m, numa linha só)
printf '%s\n' "$ISSUE_GOT" | head -1 | grep -q "^$(printf '\033')\[35m" && ok "/etc/issue starts the art in magenta" \
  || fail "/etc/issue does not start the art in magenta"
printf '%s\n' "$ISSUE_GOT" | grep -q "^$(printf '\033')\[93m\$" && ok "/etc/issue sets the text in yellow" \
  || fail "/etc/issue does not set the text in yellow"
printf '%s\n' "$ISSUE_GOT" | tail -1 | grep -q "^$(printf '\033')\[m\$" && ok "/etc/issue resets the color at the end" \
  || fail "/etc/issue does not reset the color at the end"
echo "$ISSUE_GOT" | grep -q "^  Bem-vindo! bizas v$(sed -n 's/^VERSION=//p' "$ROOT/docker/version.env")\$" \
  && ok "/etc/issue greets with the current version" || fail "/etc/issue does not greet with the current version"

# Usuário padrão anon: sem privilégios (uid acima de 0), shell /bin/sh, home criado e a senha documentada
ANON_PASSWD="$(rd 'cat /etc/passwd' | grep '^anon:' || true)"
case "$ANON_PASSWD" in
  anon:x:[1-9]*:*:*:/home/anon:/bin/sh) ok "user anon: ${ANON_PASSWD#anon:x:}" ;;
  *) fail "user anon in /etc/passwd: '${ANON_PASSWD:-missing}'" ;;
esac
SHADOW_ANON="$(rd 'cat /etc/shadow' | grep '^anon:' | cut -d: -f2 || true)"
if command -v openssl >/dev/null; then
  SALT="$(echo "$SHADOW_ANON" | cut -d'$' -f3)"
  case "$SHADOW_ANON" in '$5$'*) [ "$(openssl passwd -5 -salt "$SALT" bizasprotocol)" = "$SHADOW_ANON" ] \
    && ok "anon password is bizasprotocol" || fail "anon password hash does not match bizasprotocol" ;;
    *) fail "anon password field in /etc/shadow: '${SHADOW_ANON:-empty}'" ;; esac
fi
[ -n "$(mode /home/anon)" ] && ok "/home/anon exists" || fail "/home/anon missing"
[ "$(rd 'cat /etc/profile.d/prompt.sh')" = "$(cat "$ROOT/rootfs-overlay/etc/profile.d/prompt.sh")" ] \
  && ok "/etc/profile.d/prompt.sh equals the overlay" || fail "/etc/profile.d/prompt.sh differs from the overlay or is missing"

for f in etc/init.d/S99bizas usr/bin/set-date usr/bin/set-auto-date usr/bin/reset-chat; do
  m="$(mode "/$f")"
  [ "$m" = 755 ] && ok "/$f mode 755" || fail "/$f mode ${m:-missing}"
  [ "$(rd "cat /$f")" = "$(cat "$ROOT/rootfs-overlay/$f")" ] && ok "/$f equals the overlay" || fail "/$f differs from the overlay"
done
[ -n "$(mode /etc/init.d/S60dockerd)" ] && ok "/etc/init.d/S60dockerd present" || fail "/etc/init.d/S60dockerd missing"
# Só um script de init da aplicação: o Buildroot nunca apaga de target/ o que sobrou de um build anterior
S9X="$(names /etc/init.d | grep -E '^S9' | tr '\n' ' ' || true)"
[ "$S9X" = "S99bizas " ] && ok "only S99bizas in the S9x slots" || fail "S9x init scripts: $S9X"

# /opt/bizas: exatamente os 4 arquivos, e os tars são os registrados em evidence/
LISTED="$(names /opt/bizas | tr '\n' ' ')"
WANT="$(printf '%s\n' "$IMG_SERVER-$VERSION.tar" "$IMG_VALIDATOR-$VERSION.tar" provision.sh version.env | sort | tr '\n' ' ')"
[ "$LISTED" = "$WANT" ] && ok "/opt/bizas holds exactly: $WANT" || fail "/opt/bizas holds: $LISTED"
for img in "$IMG_VALIDATOR" "$IMG_SERVER"; do
  got="$(rd "cat /opt/bizas/$img-$VERSION.tar" | sha256sum | cut -d' ' -f1)"
  want="$(awk -v f="$img-$VERSION.tar" '$2 == f {print $1}' "$ROOT/evidence/hashes-containers.txt")"
  [ "$got" = "$want" ] && ok "$img tar in the image matches evidence/hashes-containers.txt" || fail "$img tar sha256 $got, evidence $want"
done
[ "$(mode /opt/bizas/provision.sh)" = 755 ] && ok "/opt/bizas/provision.sh mode 755" || fail "provision.sh mode"

echo "== init scripts parsed by the image's own BusyBox sh (qemu)"
BB="$OUT/target/bin/busybox"
if [ -x "$BB" ] && [ -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]; then
  for f in etc/init.d/S99bizas usr/bin/set-date usr/bin/set-auto-date usr/bin/reset-chat opt/bizas/provision.sh; do
    QEMU_LD_PREFIX="$OUT/target" "$BB" sh -n "$OUT/target/$f" && ok "busybox sh -n /$f" || fail "busybox sh -n /$f"
  done
else
  fail "cannot run the arm64 BusyBox (missing $BB or binfmt qemu-aarch64)"
fi

echo "== boot partition ($(realpath --relative-to="$ROOT" "$BOOT"))"
for f in config.txt cmdline.txt; do
  [ "$("$MTYPE" -i "$BOOT" "::$f")" = "$(cat "$BOARD/$f")" ] && ok "$f equals buildroot-external/board/bizas/rpi4/$f" \
    || fail "$f on the boot partition differs from the board file"
done
BOOTLS="$("$MDIR" -i "$BOOT" -b ::)"
for f in Image bcm2711-rpi-4-b.dtb start4.elf fixup4.dat; do
  grep -q "/$f\$" <<<"$BOOTLS" && ok "boot partition has $f" || fail "boot partition lacks $f"
done

echo "== kernel config (Docker)"
KCONF="$OUT/build/linux-custom/.config"
[ -f "$KCONF" ] || die "$KCONF not found"
while IFS= read -r opt; do
  sym="${opt%%=*}"
  if grep -qxE "$sym=(y|m)" "$KCONF"; then ok "$(grep -xE "$sym=(y|m)" "$KCONF")"; else fail "$sym is not set (asked $opt)"; fi
done < <(grep -vE '^[[:space:]]*(#|$)' "$ROOT/kernel-config/docker.fragment")
CHECK="$(ls "$OUT"/build/docker-engine-*/contrib/check-config.sh 2>/dev/null | head -1 || true)"
if [ -n "$CHECK" ]; then
  mkdir -p "$ROOT/evidence"
  bash "$CHECK" "$KCONF" > "$ROOT/evidence/kernel-check-config.txt" 2>&1 || true
  # Só a seção de requisitos obrigatórios vale como reprovação; os opcionais são registrados no arquivo
  MISSING="$(sed -n '/^Generally Necessary:/,/^Optional Features:/p' "$ROOT/evidence/kernel-check-config.txt" \
    | sed 's/\x1b\[[0-9;]*m//g' | grep -E ': missing' || true)"
  [ -z "$MISSING" ] && ok "docker check-config.sh: no Generally Necessary item missing (evidence/kernel-check-config.txt)" \
    || fail "docker check-config.sh, Generally Necessary missing:
$MISSING"
else
  fail "docker-engine contrib/check-config.sh not found in output/buildroot/build"
fi

if [ "$FAILURES" -ne 0 ]; then echo "IMAGE CHECK FAILED: $FAILURES failure(s)"; exit 1; fi
echo "IMAGE CHECK PASSED"
