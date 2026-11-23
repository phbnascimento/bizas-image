# 4. Kernel e drivers

## 4.1 Origem e configuração

| Item                 | Valor                                                                                                                                    |
|----------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| Fonte                | `raspberrypi/linux`, commit `21b410140c47ffab5668399f6f143c7d7b935c8b` (do `raspberrypi4_64_defconfig`)                                  |
| Versão               | Linux 6.12.61, `CONFIG_LOCALVERSION="-v8"`                                                                                               |
| Base da configuração | `bcm2711_defconfig` (`BR2_LINUX_KERNEL_DEFCONFIG="bcm2711"`)                                                                             |
| Fragmento do projeto | [`kernel-config/docker.fragment`](../../kernel-config/docker.fragment), via `BR2_LINUX_KERNEL_CONFIG_FRAGMENT_FILES`                     |
| Imagem               | `Image` sem compressão (`kernel=Image` no `config.txt`), 24 707 584 bytes                                                                |
| Device tree          | `bcm2711-rpi-4-b.dtb` na partição de boot; o Buildroot compila também os da Pi 400 e dos CM4 e CM4S (`BR2_LINUX_KERNEL_INTREE_DTS_NAME`) |
| Overlay              | `dtoverlay=miniuart-bt` no `config.txt`                                                                                                  |

O container não tem kernel próprio: usa o da placa. Por isso o kernel precisa dos recursos de que o Docker
depende para isolar processos, limitar recursos, montar a rede `bizas-net`, publicar a porta 80 e montar as
camadas das imagens.

O overlay `miniuart-bt`, segundo o `overlays/README` do `rpi-firmware`, passa o Bluetooth da placa para o
mini-UART (`ttyS0`) e devolve o UART0 (`ttyAMA0`) aos GPIOs 14 e 15. É nesse `ttyAMA0` que fica o console
serial (`console=ttyAMA0,115200`).

## 4.2 O fragmento do Docker

O valor final de cada opção foi lido no `.config` do kernel compilado
(`output/buildroot/build/linux-custom/.config`). A coluna `bcm2711_defconfig` é o valor que a mesma árvore
do kernel gera sem o fragmento (`make ARCH=arm64 bcm2711_defconfig` numa cópia limpa do mesmo tarball).

| Opção                                                                                                                                                                        | `bcm2711_defconfig` | Final | Para quê                                                                     |
|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:-------------------:|:-----:|------------------------------------------------------------------------------|
| `CONFIG_NAMESPACES`, `CONFIG_UTS_NS`, `CONFIG_IPC_NS`, `CONFIG_PID_NS`, `CONFIG_NET_NS`, `CONFIG_USER_NS`                                                                    | y                   | y     | isolamento de hostname, IPC, processos, rede e usuários de cada container    |
| `CONFIG_CGROUPS`, `CONFIG_CGROUP_CPUACCT`, `CONFIG_CGROUP_DEVICE`, `CONFIG_CGROUP_FREEZER`, `CONFIG_CGROUP_SCHED`, `CONFIG_CPUSETS`, `CONFIG_MEMCG`                          | y                   | y     | controle de CPU, memória e dispositivos por container                        |
| `CONFIG_CGROUP_PIDS`                                                                                                                                                         | y                   | y     | o `--pids-limit 64` dos dois containers                                      |
| `CONFIG_BPF_SYSCALL`, `CONFIG_CGROUP_BPF`                                                                                                                                    | y                   | y     | no cgroup v2, o `runc` controla o acesso a dispositivos com eBPF             |
| `CONFIG_KEYS`, `CONFIG_POSIX_MQUEUE`                                                                                                                                         | y                   | y     | recursos gerais que o Docker exige                                           |
| `CONFIG_SECCOMP`, `CONFIG_SECCOMP_FILTER`                                                                                                                                    | y                   | y     | perfil seccomp padrão do Docker                                              |
| `CONFIG_VETH`                                                                                                                                                                | m                   | **y** | par de interfaces que liga cada container à `bizas-net`                      |
| `CONFIG_BRIDGE`, `CONFIG_BRIDGE_NETFILTER`                                                                                                                                   | m                   | m     | a ponte da `docker0` e da `bizas-net` (ver 4.3)                              |
| `CONFIG_NETFILTER`, `CONFIG_NETFILTER_ADVANCED`                                                                                                                              | y                   | y     | base do netfilter                                                            |
| `CONFIG_NF_CONNTRACK`, `CONFIG_NF_NAT`                                                                                                                                       | m                   | **y** | NAT da porta publicada 80 → 5000                                             |
| `CONFIG_NETFILTER_XTABLES`, `CONFIG_NETFILTER_XT_MATCH_ADDRTYPE`, `CONFIG_NETFILTER_XT_MATCH_CONNTRACK`, `CONFIG_NETFILTER_XT_MARK`, `CONFIG_NETFILTER_XT_TARGET_MASQUERADE` | m                   | **y** | regras que o `dockerd` cria com o `iptables`                                 |
| `CONFIG_IP_NF_IPTABLES`, `CONFIG_IP_NF_FILTER`, `CONFIG_IP_NF_NAT`, `CONFIG_IP_NF_TARGET_MASQUERADE`, `CONFIG_IP_NF_RAW`                                                     | m                   | **y** | o `iptables` do Buildroot é o legacy (xtables), que usa as tabelas `IP_NF_*` |
| `CONFIG_IP6_NF_IPTABLES`, `CONFIG_IP6_NF_FILTER`, `CONFIG_IP6_NF_NAT`, `CONFIG_IP6_NF_TARGET_MASQUERADE`, `CONFIG_IP6_NF_RAW`                                                | m                   | m     | o equivalente para IPv6 (ver 4.3)                                            |
| `CONFIG_OVERLAY_FS`                                                                                                                                                          | m                   | **y** | driver de armazenamento `overlay2` das camadas das imagens                   |

O fragmento muda de fato 14 opções, as marcadas em negrito, de módulo para embutidas. As demais já vinham
como o fragmento pede. Elas continuam no fragmento para que a configuração não dependa de uma mudança futura
no `bcm2711_defconfig`.

## 4.3 Opções que ficam como módulo

`=y` num fragmento é um pedido, não uma garantia. O kconfig rebaixa a opção para `=m` quando uma dependência
dela é módulo. No `bcm2711_defconfig`, `CONFIG_IPV6=m`, e a ponte depende de `IPV6 || IPV6=n`
(`net/bridge/Kconfig`). Por isso `CONFIG_BRIDGE` e `CONFIG_BRIDGE_NETFILTER` ficam `m`, e com eles as
tabelas `IP6_NF_*`.

Módulo também funciona, desde que alguém o carregue:

- a imagem tem o `kmod` (`BR2_PACKAGE_KMOD` e `BR2_PACKAGE_KMOD_TOOLS`, do defconfig da Pi) e
  `CONFIG_MODPROBE_PATH="/sbin/modprobe"`;
- o `dockerd` 28.3.3 carrega o `br_netfilter` sozinho ao configurar a ponte, e o `br_netfilter` traz junto o
  módulo `bridge` (`libnetwork/drivers/bridge/setup_bridgenetfiltering.go` e `internal/modprobe` no fonte
  do `docker-engine`).

## 4.4 Dispositivos e módulos no boot

A imagem usa o `/dev` **só com devtmpfs** (`BR2_ROOTFS_DEVICE_CREATION_DYNAMIC_DEVTMPFS`, com
`CONFIG_DEVTMPFS=y` e `CONFIG_DEVTMPFS_MOUNT=y`), sem `mdev` nem `eudev`. O kernel cria e remove os nós de
`/dev` sozinho. O que falta sem um gerenciador de dispositivos é a reação do espaço de usuário aos eventos
de hardware: segundo o manual do Buildroot, é o `mdev` que pode, por exemplo, carregar módulos quando um
dispositivo aparece. Nesta imagem, portanto, **nenhum módulo de hardware carrega sozinho**.

A imagem não depende disso. Os drivers do caminho de boot e de rede estão embutidos no kernel (`=y` no
`.config` final): Ethernet (`CONFIG_BCMGENET`, `CONFIG_BROADCOM_PHY`, `CONFIG_MDIO_BCM_UNIMAC`), controladores
do cartão SD (`CONFIG_MMC_SDHCI_IPROC`, `CONFIG_MMC_BCM2835`) e sistemas de arquivos (`CONFIG_EXT4_FS`,
`CONFIG_VFAT_FS`). O que o Docker usa como módulo é carregado pelo próprio `dockerd` (seção 4.3). Para carregar um módulo no boot, o mecanismo é o `/etc/init.d/S11modules` do
Buildroot. Ele lê cada arquivo `*.conf` de `/etc/modules-load.d/`, um módulo por linha, e chama
`modprobe` para cada um. Esse diretório entraria pelo `rootfs-overlay/`. A imagem não traz
`/etc/modules-load.d/`, e o `S11modules` não carrega nenhum módulo.

## 4.5 O `check-config.sh` do Docker

O `scripts/check-image.sh` roda o `contrib/check-config.sh` do próprio `docker-engine` 28.3.3 contra o
`.config` do kernel compilado e grava a saída em
[`evidence/kernel-check-config.txt`](../../evidence/kernel-check-config.txt). O script reprova se faltar
qualquer item da seção *Generally Necessary*.

Resultado:

- **Generally Necessary:** nenhum item faltando. Aparecem como módulo: `CONFIG_BRIDGE`,
  `CONFIG_BRIDGE_NETFILTER`, `CONFIG_IP_NF_MANGLE`, `CONFIG_IP6_NF_FILTER`, `CONFIG_IP6_NF_MANGLE`,
  `CONFIG_IP6_NF_TARGET_MASQUERADE`, `CONFIG_NETFILTER_XT_MATCH_IPVS`, `CONFIG_IP6_NF_RAW` e
  `CONFIG_IP6_NF_NAT`.
- **Optional Features faltando:** `CONFIG_MEMCG_SWAP`, `CONFIG_CGROUP_HUGETLB` e `CONFIG_SECURITY_SELINUX`.
  Nenhum é usado: o `/etc/fstab` da imagem não declara swap, os containers não usam hugepages, e o módulo
  de segurança habilitado no kernel é o AppArmor (`CONFIG_SECURITY_APPARMOR` aparece como `enabled`).
- **Storage Drivers:** `overlay` com `CONFIG_OVERLAY_FS` embutido, que é o usado. O `zfs` aparece como
  faltando, e a imagem não o usa.

As linhas `cgroup hierarchy` e `Limits` do arquivo não vêm do `.config`: o `check-config.sh` as lê do
sistema em que ele roda (`/sys/fs/cgroup` e `/proc`), ou seja, da máquina de build. Na placa, quem monta o
cgroup v2 é o `S30cgroupfs2`.
