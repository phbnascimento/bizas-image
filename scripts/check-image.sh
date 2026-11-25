#!/usr/bin/env bash
# Confere a imagem pronta sem montar nada: lê o rootfs com debugfs e a partição de boot com mtools, confere o kernel
# contra o fragmento do Docker e o check-config.sh do próprio docker-engine, confere o ponto de acesso Wi-Fi (rede,
# senha, DHCP, programas, firmware e driver) e passa os scripts de init pelo sh do BusyBox da imagem e os .conf do AP
# pelo hostapd e pelo dnsmasq da imagem (via binfmt/qemu)
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

for f in etc/init.d/S39wifi-ap etc/init.d/S99bizas usr/bin/set-date usr/bin/set-auto-date usr/bin/reset-chat; do
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

echo "== Wi-Fi access point"
# Os .conf da imagem têm de ser os do overlay: o pacote hostapd instala um hostapd.conf de exemplo no mesmo lugar
for f in etc/hostapd.conf etc/dnsmasq.conf; do
  [ "$(rd "cat /$f")" = "$(cat "$ROOT/rootfs-overlay/$f")" ] && ok "/$f equals the overlay" || fail "/$f differs from the overlay or is missing"
done
# Linhas de opção, sem comentários
opts() { rd "cat $1" | grep -vE '^[[:space:]]*(#|$)'; }
for line in interface=wlan0 driver=nl80211 ssid=BizasChat wpa=2 wpa_key_mgmt=WPA-PSK rsn_pairwise=CCMP; do
  opts /etc/hostapd.conf | grep -qxF "$line" && ok "hostapd.conf: $line" || fail "hostapd.conf lacks $line"
done
PSK="$(opts /etc/hostapd.conf | sed -n 's/^wpa_passphrase=//p')"
[ "$PSK" = embarcados2026 ] && ok "hostapd.conf: WPA2 passphrase is the documented one" || fail "hostapd.conf passphrase: '$PSK'"
[ "${#PSK}" -ge 8 ] && [ "${#PSK}" -le 63 ] && ok "WPA2 passphrase has ${#PSK} characters (8 to 63)" \
  || fail "WPA2 passphrase has ${#PSK} characters; WPA2 needs 8 to 63"
for line in port=0 interface=wlan0 dhcp-range=192.168.50.10,192.168.50.100,255.255.255.0,12h; do
  opts /etc/dnsmasq.conf | grep -qxF "$line" && ok "dnsmasq.conf: $line" || fail "dnsmasq.conf lacks $line"
done
grep -vE '^[[:space:]]*#' "$ROOT/rootfs-overlay/etc/init.d/S39wifi-ap" | grep -qxF 'ADDR=192.168.50.1/24' \
  && ok "S39wifi-ap puts 192.168.50.1/24 on wlan0" || fail "S39wifi-ap does not set ADDR=192.168.50.1/24"
for f in /usr/sbin/hostapd /usr/bin/hostapd_cli /usr/sbin/dnsmasq /usr/sbin/iw; do
  [ -n "$(mode "$f")" ] && ok "$f present" || fail "$f missing"
done
# Um serviço, um script: o S80dnsmasq do pacote subiria uma segunda instância (o post-build.sh o tira)
DUP="$(names /etc/init.d | grep -E 'hostapd|dnsmasq' | tr '\n' ' ' || true)"
[ -z "$DUP" ] && ok "no hostapd/dnsmasq init script besides S39wifi-ap" || fail "extra init scripts: $DUP"
# O firmware que o brcmfmac pede em brcm/ é, em parte, symlink para ../cypress/; o linux-firmware só cria o link se o
# alvo existir. Segue o link (relativo) e confere que o alvo é um arquivo de verdade
resolve() {
  local p="$1" dest n=0
  while [ "$n" -lt 5 ]; do
    dest="$(rd "stat $p" | sed -n 's/^Fast link dest: "\(.*\)"$/\1/p')"
    [ -z "$dest" ] && { echo "$p"; return; }
    # -s: normaliza o caminho sem seguir links do PC (no PC, /lib pode apontar para /usr/lib)
    case "$dest" in /*) p="$dest" ;; *) p="$(realpath -m -s "$(dirname "$p")/$dest")" ;; esac
    n=$((n + 1))
  done
  echo "$p"
}
for f in brcm/brcmfmac43455-sdio.bin brcm/brcmfmac43455-sdio.clm_blob 'brcm/brcmfmac43455-sdio.raspberrypi,4-model-b.txt' \
  regulatory.db regulatory.db.p7s; do
  real="$(resolve "/lib/firmware/$f")"
  if rd "stat $real" | grep -q 'Type: regular'; then ok "/lib/firmware/$f -> $real"; else fail "/lib/firmware/$f does not resolve to a file ($real)"; fi
done
# A licença da Broadcom exige uma cópia dela junto do firmware; o post-build.sh copia as duas do linux-firmware
FW_BUILD="$(ls -d "$OUT"/build/linux-firmware-*/ 2>&1 | head -1 || true)"
for lic in LICENCE.broadcom_bcm43xx LICENCE.cypress; do
  if [ -f "$FW_BUILD/$lic" ] && [ "$(rd "cat /lib/firmware/$lic")" = "$(cat "$FW_BUILD/$lic")" ]; then
    ok "/lib/firmware/$lic equals the linux-firmware one"
  else
    fail "/lib/firmware/$lic missing or different from $FW_BUILD$lic"
  fi
done
KVER="$(names /lib/modules | head -1)"
BRCM="/lib/modules/$KVER/kernel/drivers/net/wireless/broadcom/brcm80211/brcmfmac"
# O 43455 usa o submódulo wcc (tabela SDIO do driver, bcmsdh.c), carregado pelo próprio brcmfmac
for m in brcmfmac.ko.xz wcc/brcmfmac-wcc.ko.xz; do
  [ -n "$(mode "$BRCM/$m")" ] && ok "module $m ($KVER)" || fail "module $BRCM/$m missing"
done
# Lido para uma variável antes: com pipefail, o grep -q fechando o pipe cedo faria o debugfs morrer de SIGPIPE
MODDEP="$(rd "cat /lib/modules/$KVER/modules.dep")"
grep -q '/brcmfmac\.ko\.xz:' <<<"$MODDEP" && ok "brcmfmac in modules.dep" || fail "brcmfmac not in modules.dep"
grep -vE '^[[:space:]]*#' "$ROOT/rootfs-overlay/etc/init.d/S39wifi-ap" | grep -qE '^[[:space:]]*if ! modprobe brcmfmac' \
  && ok "S39wifi-ap loads brcmfmac" || fail "S39wifi-ap does not modprobe brcmfmac"

echo "== init scripts parsed by the image's own BusyBox sh (qemu)"
BB="$OUT/target/bin/busybox"
# A prova é rodar o BusyBox arm64, não olhar o registro do binfmt: dentro de um container o /proc/sys/fs/binfmt_misc
# não aparece, mas a emulação do kernel do PC funciona
BB_ERR=""
if [ -x "$BB" ]; then BB_ERR="$(QEMU_LD_PREFIX="$OUT/target" "$BB" true 2>&1 || echo "exit $?")"; else BB_ERR="missing $BB"; fi
if [ -z "$BB_ERR" ]; then
  for f in etc/init.d/S39wifi-ap etc/init.d/S99bizas usr/bin/set-date usr/bin/set-auto-date usr/bin/reset-chat \
    opt/bizas/provision.sh; do
    QEMU_LD_PREFIX="$OUT/target" "$BB" sh -n "$OUT/target/$f" && ok "busybox sh -n /$f" || fail "busybox sh -n /$f"
  done
  # Os .conf do AP passam pelo parser dos binários arm64 da imagem. O dnsmasq tem --test; o hostapd não: ele lê o
  # arquivo e depois tenta abrir a wlan0, que não existe no PC. Erro de sintaxe aparece antes, como "Line N:"
  OUT_DNSMASQ="$(QEMU_LD_PREFIX="$OUT/target" timeout 20 "$OUT/target/usr/sbin/dnsmasq" --test \
    -C "$ROOT/rootfs-overlay/etc/dnsmasq.conf" 2>&1 || echo "exit $?")"
  case "$OUT_DNSMASQ" in
    *"syntax check OK"*) ok "dnsmasq (arm64) accepts dnsmasq.conf" ;;
    *) fail "dnsmasq (arm64) rejects dnsmasq.conf: $(tr -s '\n' ' ' <<<"$OUT_DNSMASQ")" ;;
  esac
  OUT_HOSTAPD="$(QEMU_LD_PREFIX="$OUT/target" timeout 20 "$OUT/target/usr/sbin/hostapd" \
    "$ROOT/rootfs-overlay/etc/hostapd.conf" 2>&1 || true)"
  # Só vale se o hostapd chegou a ler o arquivo: o driver nl80211 só é iniciado depois de o .conf inteiro ser aceito
  if grep -qE '^Line [0-9]+:|Invalid configuration' <<<"$OUT_HOSTAPD"; then
    fail "hostapd (arm64) rejects hostapd.conf: $(grep -E '^Line [0-9]+:|Invalid configuration' <<<"$OUT_HOSTAPD" | tr '\n' ' ')"
  elif grep -qF "Failed to initialize driver 'nl80211'" <<<"$OUT_HOSTAPD"; then
    ok "hostapd (arm64) accepts hostapd.conf and stops only at the nl80211 driver (no wlan0 on the PC)"
  else
    fail "hostapd (arm64) did not get to wlan0: $(echo "$OUT_HOSTAPD" | tr '\n' ' ')"
  fi
else
  fail "cannot run the arm64 BusyBox ($BB_ERR); qemu-aarch64 has to be registered in the kernel (binfmt_misc)"
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
# Pilha sem fio do AP: vem do bcm2711_defconfig, não de um fragmento nosso
for sym in CONFIG_CFG80211 CONFIG_BRCMFMAC CONFIG_BRCMFMAC_SDIO; do
  if grep -qxE "$sym=(y|m)" "$KCONF"; then ok "$(grep -xE "$sym=(y|m)" "$KCONF") (Wi-Fi)"; else fail "$sym is not set (Wi-Fi)"; fi
done
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
