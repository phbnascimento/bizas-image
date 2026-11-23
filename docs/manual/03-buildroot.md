# 3. Configuração do Buildroot

A imagem parte do `raspberrypi4_64_defconfig` do Buildroot 2026.05.1 e muda só o que a aplicação
precisa. As mudanças estão em um único arquivo,
[`buildroot-external/board/bizas/rpi4/buildroot.fragment`](../../buildroot-external/board/bizas/rpi4/buildroot.fragment).
O `scripts/configure-buildroot.sh` mescla esse fragmento ao defconfig da Pi, confere cada opção no
`.config` e grava o resultado em
[`buildroot-external/configs/bizas_rpi4_defconfig`](../../buildroot-external/configs/bizas_rpi4_defconfig),
que é o que o `scripts/build-image.sh` usa.

As customizações ficam num `BR2_EXTERNAL` próprio (`buildroot-external/`, nome `BIZAS`), separado da
árvore do Buildroot, que não é alterada.

## 3.1 Como ler as tabelas

- **Caminho no menuconfig** e **dependências** vêm do `Config.in` do Buildroot 2026.05.1 em `buildroot/`.
- **Tamanho** é medido pelo `make graph-size` do Buildroot (`output/buildroot/graphs/package-size-stats.csv`),
  que soma o tamanho dos arquivos de cada pacote no rootfs. O rootfs inteiro soma 218 833 017 bytes. Onde
  a opção não instala um pacote, o tamanho é o do arquivo que ela produz, medido com `ls -l`.
- **Boot** é o raciocínio técnico sobre o efeito no tempo de inicialização. Não é uma medida.
- **Licença** vem do `make legal-info` (capítulo 5).

O defconfig gravado tem 41 linhas. Comparado com o `raspberrypi4_64_defconfig`, ele tem as 11 opções
abaixo, todas do fragmento.

## 3.2 Opções alteradas pelo projeto

### `BR2_TARGET_GENERIC_HOSTNAME`

| Campo                 | Conteúdo                                                       |
|-----------------------|----------------------------------------------------------------|
| Caminho no menuconfig | System configuration → System hostname                         |
| Valor                 | `"bizas"` (padrão do Buildroot: `"buildroot"`)                 |
| Motivo                | Identifica a placa no console e na rede (`/etc/hostname`).     |
| Dependências          | `BR2_ROOTFS_SKELETON_DEFAULT` (skeleton padrão, que é o usado) |
| Tamanho               | nenhum efeito mensurável                                       |
| Boot                  | nenhum: o init já define o hostname em qualquer caso           |
| Segurança             | nenhum                                                         |
| Licença               | nenhum                                                         |

### `BR2_TARGET_GENERIC_ISSUE`

| Campo                 | Conteúdo                                                      |
|-----------------------|---------------------------------------------------------------|
| Caminho no menuconfig | System configuration → System banner                          |
| Valor                 | `"Bizas"` (padrão do Buildroot: `"Welcome to Buildroot"`)     |
| Motivo                | Mensagem do `/etc/issue`, mostrada antes do login no console. |
| Dependências          | `BR2_ROOTFS_SKELETON_DEFAULT`                                 |
| Tamanho               | nenhum efeito mensurável                                      |
| Boot                  | nenhum                                                        |
| Segurança             | nenhum                                                        |
| Licença               | nenhum                                                        |

### `BR2_TARGET_GENERIC_ROOT_PASSWD`

| Campo                 | Conteúdo                                                                                                                                                                                                                  |
|-----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Caminho no menuconfig | System configuration → Enable root login with password → Root password                                                                                                                                                    |
| Valor                 | `"bizasprotocol"` (padrão: vazio, sem senha)                                                                                                                                                                              |
| Motivo                | Acesso de manutenção pelo console (HDMI ou serial). A imagem não tem SSH.                                                                                                                                                 |
| Dependências          | `BR2_TARGET_ENABLE_ROOT_LOGIN` (padrão `y`) e `BR2_ROOTFS_SKELETON_DEFAULT`. Com senha não vazia, seleciona `BR2_PACKAGE_HOST_MKPASSWD`, que gera o hash no build.                                                        |
| Tamanho               | nenhum efeito mensurável                                                                                                                                                                                                  |
| Boot                  | nenhum                                                                                                                                                                                                                    |
| Segurança             | O `/etc/shadow` guarda só o hash, no método `BR2_TARGET_GENERIC_PASSWD_METHOD="sha-256"` (SHA-256 crypt, `$5$`). A senha está documentada; o login exige acesso físico à placa, porque não há serviço de login pela rede. |
| Licença               | nenhum                                                                                                                                                                                                                    |

### `BR2_ROOTFS_OVERLAY`

| Campo                 | Conteúdo                                                                                                                                                                   |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Caminho no menuconfig | System configuration → Root filesystem overlay directories                                                                                                                 |
| Valor                 | `"$(BR2_EXTERNAL_BIZAS_PATH)/../rootfs-overlay"` (padrão: vazio)                                                                                                           |
| Motivo                | Copia para o rootfs os arquivos do projeto: `/etc/init.d/S99bizas` (provisionamento no 1º boot) e `/usr/bin/set-date` e `/usr/bin/set-auto-date` (hora real da página).    |
| Dependências          | nenhuma                                                                                                                                                                    |
| Tamanho               | 3 scripts de shell; nenhum efeito mensurável                                                                                                                               |
| Boot                  | Acrescenta o `S99bizas` ao fim do `rcS`. Depois do 1º boot, ele só confere a existência da marca `/var/lib/bizas/provisioned` e sai, sem executar nenhum comando `docker`. |
| Segurança             | Os comandos de `/usr/bin` são usados pelo root no console e falam com a porta de manutenção do server, que só escuta no loopback do container.                             |
| Licença               | arquivos do projeto                                                                                                                                                        |

### `BR2_ROOTFS_POST_BUILD_SCRIPT`

| Campo                 | Conteúdo                                                                                                                                                                                          |
|-----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Caminho no menuconfig | System configuration → Custom scripts to run before creating filesystem images                                                                                                                    |
| Valor                 | `"board/raspberrypi4-64/post-build.sh $(BR2_EXTERNAL_BIZAS_PATH)/board/bizas/rpi4/post-build.sh"` (padrão do defconfig da Pi: só o primeiro)                                                      |
| Motivo                | O primeiro script é o da Raspberry Pi (acrescenta um `getty` no `tty1`). O segundo embarca a aplicação: copia para `/opt/bizas` os tars arm64 dos containers, o `provision.sh` e o `version.env`. |
| Dependências          | nenhuma no kconfig. O script exige os tars de `scripts/containers-build.sh arm64` e `python3` no host.                                                                                            |
| Tamanho               | Os dois tars somam 5 923 328 bytes (3 077 632 do server e 2 845 696 do validator). No `graph-size`, os arquivos sem pacote somam 5 930 563 bytes, quase todos desses tars.                        |
| Boot                  | Nenhum nos boots seguintes. No 1º boot, os tars são carregados pelo `docker load`, fora da medição normal de boot.                                                                                |
| Segurança             | Antes de copiar, confere que o SHA-256 de cada tar é o registrado em `evidence/hashes-containers.txt` e que a imagem dentro dele é `linux/arm64`; se não for, o build para.                       |
| Licença               | aplicação do projeto (capítulo 5)                                                                                                                                                                 |

### `BR2_LINUX_KERNEL_CONFIG_FRAGMENT_FILES`

| Campo                 | Conteúdo                                                                                                                                                                                                                                                                            |
|-----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Caminho no menuconfig | Kernel → Linux Kernel → Additional configuration fragment files                                                                                                                                                                                                                     |
| Valor                 | `"$(BR2_EXTERNAL_BIZAS_PATH)/../kernel-config/docker.fragment"` (padrão: vazio)                                                                                                                                                                                                     |
| Motivo                | Garante no kernel os recursos de que o Docker precisa (capítulo 4).                                                                                                                                                                                                                 |
| Dependências          | `BR2_LINUX_KERNEL`                                                                                                                                                                                                                                                                  |
| Tamanho               | O kernel `Image` completo tem 24 707 584 bytes.                                                                                                                                                                                                                                     |
| Boot                  | O fragmento torna embutidas 14 opções que o `bcm2711_defconfig` deixa como módulo (netfilter, NAT, `veth`, `overlay`). Embutidas, elas não dependem de `modprobe` quando o `dockerd` monta a rede e o armazenamento; em troca, o kernel que o firmware carrega fica um pouco maior. |
| Segurança             | Mantém `SECCOMP_FILTER`, usado pelo perfil seccomp padrão do Docker, e os namespaces que isolam os containers.                                                                                                                                                                      |
| Licença               | GPL-2.0 (o kernel)                                                                                                                                                                                                                                                                  |

### `BR2_PACKAGE_RPI_FIRMWARE_CONFIG_FILE`

| Campo                 | Conteúdo                                                                                                                                                                                                                                                                                                                   |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Caminho no menuconfig | Target packages → Hardware handling → Firmware → rpi-firmware → Path to a file stored as boot/config.txt                                                                                                                                                                                                                   |
| Valor                 | `"$(BR2_EXTERNAL_BIZAS_PATH)/board/bizas/rpi4/config.txt"` (defconfig da Pi: `board/raspberrypi4-64/config_4_64bit.txt`)                                                                                                                                                                                                   |
| Motivo                | O `config.txt` do projeto é o `config_4_64bit.txt` do Buildroot com duas linhas a mais: `disable_splash=1` e `boot_delay=0`.                                                                                                                                                                                               |
| Dependências          | `BR2_PACKAGE_RPI_FIRMWARE`, que depende de `BR2_arm` ou `BR2_aarch64`                                                                                                                                                                                                                                                      |
| Tamanho               | nenhum efeito mensurável                                                                                                                                                                                                                                                                                                   |
| Boot                  | Segundo a documentação do `config.txt` da Raspberry Pi, `disable_splash=1` não mostra a tela de arco-íris no boot. `boot_delay=0` está no arquivo com a intenção, registrada no comentário do próprio `config.txt`, de não haver espera antes de carregar o kernel. O `initial_turbo` não é usado, por decisão do projeto. |
| Segurança             | nenhum                                                                                                                                                                                                                                                                                                                     |
| Licença               | o `rpi-firmware` é BSD-3-Clause                                                                                                                                                                                                                                                                                            |

### `BR2_PACKAGE_RPI_FIRMWARE_CMDLINE_FILE`

| Campo                 | Conteúdo                                                                                                                                                                                                        |
|-----------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Caminho no menuconfig | Target packages → Hardware handling → Firmware → rpi-firmware → Path to a file stored as boot/cmdline.txt                                                                                                       |
| Valor                 | `"$(BR2_EXTERNAL_BIZAS_PATH)/board/bizas/rpi4/cmdline.txt"` (padrão: `board/raspberrypi/cmdline.txt`)                                                                                                           |
| Motivo                | A linha de comando do kernel é a do Buildroot com `quiet loglevel=3` no fim: `root=/dev/mmcblk0p2 rootwait console=tty1 console=ttyAMA0,115200 quiet loglevel=3`. A ordem dos `console=` é mantida (seção 7.4). |
| Dependências          | `BR2_PACKAGE_RPI_FIRMWARE`                                                                                                                                                                                      |
| Tamanho               | nenhum efeito mensurável                                                                                                                                                                                        |
| Boot                  | Com `loglevel=3`, só mensagens de nível menor que 3 (`KERN_ERR`) vão para os consoles, e menos texto é escrito no HDMI e na serial de 115200 baud durante o boot.                                               |
| Segurança             | nenhum                                                                                                                                                                                                          |
| Licença               | nenhum                                                                                                                                                                                                          |

### `BR2_PACKAGE_DOCKER_ENGINE`

| Campo                 | Conteúdo                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Caminho no menuconfig | Target packages → System tools → docker-engine                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Valor                 | `y`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Motivo                | O `dockerd`, que roda os containers da aplicação e os religa a cada boot. Traz o `/etc/init.d/S60dockerd`.                                                                                                                                                                                                                                                                                                                                                     |
| Dependências          | `BR2_PACKAGE_HOST_GO_TARGET_ARCH_SUPPORTS`, `BR2_PACKAGE_HOST_GO_TARGET_CGO_LINKING_SUPPORTS`, `BR2_TOOLCHAIN_HAS_THREADS`, `BR2_TOOLCHAIN_HEADERS_AT_LEAST_5_2`, `!BR2_TOOLCHAIN_USES_UCLIBC`, `BR2_USE_MMU`, `!BR2_PACKAGE_CGROUPFS_MOUNT`, `BR2_PACKAGE_LIBSECCOMP_ARCH_SUPPORTS`. Seleciona `BR2_PACKAGE_CONTAINERD`, `BR2_PACKAGE_IPTABLES`, `BR2_PACKAGE_LIBSECCOMP`, `BR2_PACKAGE_HOST_GO` e, sem systemd, `BR2_PACKAGE_CGROUPFS_V2_MOUNT` (seção 3.3). |
| Tamanho               | 66 772 467 bytes                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Boot                  | Põe o `S60dockerd` no caminho do boot. Depois do 1º boot, a aplicação depende do `dockerd` iniciar e religar os dois containers.                                                                                                                                                                                                                                                                                                                               |
| Segurança             | O `dockerd` roda como root no host. Os containers rodam sem root e sem capabilities (capítulo 1).                                                                                                                                                                                                                                                                                                                                                              |
| Licença               | Apache-2.0 (o `legal-info` avisa que as licenças das dependências vendorizadas podem não estar listadas)                                                                                                                                                                                                                                                                                                                                                       |

### `BR2_PACKAGE_DOCKER_CLI`

| Campo                 | Conteúdo                                                                                                                                                     |
|-----------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Caminho no menuconfig | Target packages → System tools → docker-cli                                                                                                                  |
| Valor                 | `y`                                                                                                                                                          |
| Motivo                | O comando `docker`, usado pelo provisionamento no 1º boot, pelo `set-date` e `set-auto-date` e pela manutenção no console.                                   |
| Dependências          | `BR2_PACKAGE_HOST_GO_TARGET_ARCH_SUPPORTS`, `BR2_PACKAGE_HOST_GO_TARGET_CGO_LINKING_SUPPORTS`, `BR2_TOOLCHAIN_HAS_THREADS`. Seleciona `BR2_PACKAGE_HOST_GO`. |
| Tamanho               | 26 888 864 bytes                                                                                                                                             |
| Boot                  | Nenhum depois do 1º boot: o `S99bizas` não chama o `docker` quando a marca de provisionamento existe.                                                        |
| Segurança             | Só o root usa o comando; o socket do Docker não é montado em nenhum container.                                                                               |
| Licença               | Apache-2.0 (mesmo aviso do `docker-engine`)                                                                                                                  |

### `BR2_TARGET_ROOTFS_EXT2_SIZE`

| Campo                 | Conteúdo                                                                                                                                                                              |
|-----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Caminho no menuconfig | Filesystem images → ext2/3/4 root filesystem → exact size                                                                                                                             |
| Valor                 | `"1024M"` (defconfig da Pi: `"120M"`)                                                                                                                                                 |
| Motivo                | O rootfs guarda o Docker (cerca de 174 MB pelos pacotes da seção 3.3), os tars, e em `/var/lib/docker` as camadas carregadas e o volume da cadeia. 120M não comporta nem os binários. |
| Dependências          | `BR2_TARGET_ROOTFS_EXT2`                                                                                                                                                              |
| Tamanho               | `sdcard.img` passa a ter 1 107 296 768 bytes; o `.img.xz` tem 81 812 196 bytes.                                                                                                       |
| Boot                  | Não muda o que o firmware e o kernel leem. Aumenta o que o `dd` grava no cartão.                                                                                                      |
| Segurança             | nenhum                                                                                                                                                                                |
| Licença               | nenhum                                                                                                                                                                                |

## 3.3 Pacotes selecionados automaticamente

Estes pacotes não estão no fragmento. O kconfig os seleciona porque o `docker-engine` ou o `containerd`
os exigem, e o `configure-buildroot.sh` confere que estão no `.config`.

| Pacote (símbolo)                                                                                 | Selecionado por                | Para quê                                                    | Tamanho no rootfs | Licença                                                 |
|--------------------------------------------------------------------------------------------------|--------------------------------|-------------------------------------------------------------|------------------:|---------------------------------------------------------|
| `containerd` (`BR2_PACKAGE_CONTAINERD`)                                                          | `docker-engine`                | gerencia o ciclo de vida dos containers                     | 69 921 736 B      | Apache-2.0                                              |
| `runc` (`BR2_PACKAGE_RUNC`)                                                                      | `containerd`                   | cria os containers (namespaces, cgroups)                    | 10 772 000 B      | Apache-2.0, LGPL-2.1 (libseccomp)                       |
| `iptables` (`BR2_PACKAGE_IPTABLES`)                                                              | `docker-engine`                | regras de NAT da porta publicada e da rede `bizas-net`      | 1 350 192 B       | GPL-2.0                                                 |
| `libseccomp` (`BR2_PACKAGE_LIBSECCOMP`)                                                          | `docker-engine`                | filtros seccomp dos containers                              | 183 848 B         | LGPL-2.1                                                |
| `cgroupfs-v2-mount` (`BR2_PACKAGE_CGROUPFS_V2_MOUNT`)                                            | `docker-engine`, sem systemd   | o `S30cgroupfs2`, que monta o cgroup v2 em `/sys/fs/cgroup` | 615 B             | não declarada no pacote                                 |
| `util-linux` (`BR2_PACKAGE_UTIL_LINUX`, com `_BINARIES`, `_MOUNT`, `_MOUNTPOINT`, `_PIVOT_ROOT`) | `containerd`                   | `mount`, `mountpoint` e `pivot_root` completos              | 5 518 760 B       | GPL-2.0+, BSD-4-Clause, LGPL-2.1+ e outras (capítulo 5) |
| `host-go` (`BR2_PACKAGE_HOST_GO`)                                                                | `docker-engine`, `docker-cli`  | compila o Docker no host (Go 1.26.3); não vai para a placa  | —                 | BSD-3-Clause                                            |
| `host-mkpasswd` (`BR2_PACKAGE_HOST_MKPASSWD`)                                                    | `BR2_TARGET_ENABLE_ROOT_LOGIN` | gera o hash da senha do root no build; não vai para a placa | —                 | GPL-2.0+                                                |

A pilha do Docker (`docker-engine`, `containerd`, `docker-cli` e `runc`) soma 174 355 067 bytes, cerca de
80% do rootfs.

## 3.4 O que vem do defconfig da Raspberry Pi

O projeto mantém, sem mudar, o resto do `raspberrypi4_64_defconfig`. Os itens que mais pesam nas decisões
da imagem:

| Opção                                                 | Valor                                                                    | Efeito                                                         |
|-------------------------------------------------------|--------------------------------------------------------------------------|----------------------------------------------------------------|
| `BR2_aarch64`, `BR2_cortex_a72`                       | `y`                                                                      | 64 bits, otimizado para o Cortex-A72 da Pi 4                   |
| `BR2_TOOLCHAIN_EXTERNAL_BOOTLIN_AARCH64_GLIBC_STABLE` | `y`                                                                      | toolchain externo da Bootlin (2025.08-1, glibc)                |
| `BR2_LINUX_KERNEL_CUSTOM_TARBALL_LOCATION`            | `raspberrypi/linux` no commit `21b410140c47ffab5668399f6f143c7d7b935c8b` | kernel Linux 6.12.61 da Raspberry Pi                           |
| `BR2_LINUX_KERNEL_DEFCONFIG`                          | `"bcm2711"`                                                              | `bcm2711_defconfig` como base do kernel                        |
| `BR2_SYSTEM_DHCP`                                     | `"eth0"`                                                                 | `eth0` por DHCP no `/etc/network/interfaces`                   |
| `BR2_PACKAGE_RPI_FIRMWARE_VARIANT_PI4`                | `y`                                                                      | firmware `start4.elf` / `fixup4.dat`                           |
| `BR2_PACKAGE_KMOD`, `BR2_PACKAGE_KMOD_TOOLS`          | `y`                                                                      | `modprobe` completo no rootfs                                  |
| `BR2_TARGET_ROOTFS_EXT2_4`                            | `y`                                                                      | rootfs ext4                                                    |
| `BR2_DOWNLOAD_FORCE_CHECK_HASHES`                     | `y`                                                                      | todo download do Buildroot precisa bater com um hash conhecido |

Do resto do Buildroot 2026.05.1, a imagem usa os padrões: init do BusyBox (`BR2_INIT_BUSYBOX`), `/dev`
por devtmpfs sem gerenciador de dispositivos (`BR2_ROOTFS_DEVICE_CREATION_DYNAMIC_DEVTMPFS`) e `/bin/sh` do
BusyBox.
