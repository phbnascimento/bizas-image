# 2. Ambiente de build

Este capítulo diz o que a máquina de build precisa ter e qual é a sequência de comandos que vai de um
clone do repositório até a imagem gravável `bizas-rpi4.img.xz` com o seu SHA-256.

## 2.1 Máquina de referência

Os scripts deste capítulo rodaram numa máquina x86_64 com estas versões:

| Item           | Versão                          |
|----------------|---------------------------------|
| Sistema        | CachyOS (Linux 7.3.3-1-cachyos) |
| GNU Make       | 4.4.1                           |
| GCC / G++      | 16.2.1                          |
| Python         | 3.14.9                          |
| Docker Engine  | 29.9.3                          |
| Docker Buildx  | 0.38.2                          |
| Go             | 1.27.3                          |
| Deno           | 2.9.8                           |
| Firefox        | 160.0                           |
| zbarimg (zbar) | 0.23.95                         |
| xz             | 5.8.3                           |
| curl           | 8.23.0                          |
| jq             | 1.8.2                           |
| Git            | 2.56.1                          |

As versões da tabela são as que foram usadas, não mínimos.

## 2.2 Ferramentas necessárias

### Para o Buildroot

O Buildroot 2026.05.1 lista como obrigatórios (`buildroot/docs/manual/prerequisite.adoc`): `which`, `sed`, `make`
(3.81 ou mais nova), `binutils`, `build-essential` (só no Debian e derivados), `diffutils`, `gcc` e `g++`
(4.8 ou mais novos), `bash`, `patch`, `gzip`, `bzip2`, `perl` (5.8.7 ou mais novo), `tar`, `cpio`, `unzip`,
`rsync`, `file` (em `/usr/bin/file`), `bc`, `findutils`, `awk` e `wget`.

O próprio Buildroot compila as ferramentas de host de que a imagem precisa (o `genimage`, o `mtools`, o
`debugfs` do e2fsprogs, o compilador Go do `docker-engine`) e baixa o toolchain externo da Bootlin. Elas
ficam em `output/buildroot/host/`.

### Para cada script do projeto

| Script                                                  | Precisa de                                                                             |
|---------------------------------------------------------|----------------------------------------------------------------------------------------|
| `scripts/fetch-buildroot.sh`                            | `curl`, `sha256sum`, `tar` e rede, só na primeira vez                                  |
| `scripts/configure-buildroot.sh`                        | o mesmo que o Buildroot                                                                |
| `scripts/containers-build.sh`                           | Docker com Buildx, `python3`                                                           |
| `scripts/build-image.sh`                                | o mesmo que o Buildroot, `xz`, `python3` (o post-build confere os tars)                |
| `scripts/check-image.sh`                                | emulação `qemu-aarch64` no kernel do PC (binfmt); `openssl` é opcional                 |
| `scripts/flash-sd.sh`                                   | `lsblk`, `sudo`, `dd`, `blockdev`, `sha256sum`                                         |
| `scripts/containers-test.sh`                            | Docker; para `arm64`, binfmt `qemu-aarch64`; mais o que o `browser.sh` pede            |
| `scripts/e2e/browser.sh`                                | `go`, `deno`, `firefox`, `curl`, `ip`, `ss`, `zbarimg`                                 |
| `scripts/build-manual.sh`                               | `python3` com `markdown-it-py` e `mdit-py-plugins`, `deno`, `firefox`                  |
| `scripts/fetch-tweetnacl.sh`, `scripts/fetch-qrcode.sh` | `curl`, `jq` e rede; só para trocar os arquivos embutidos, que já estão no repositório |

Notas:

- **Docker Buildx e arquitetura.** O `containers-build.sh arm64` não precisa de emulação: o estágio de build
  dos Dockerfiles roda na arquitetura do PC (`--platform=$BUILDPLATFORM`) e compila cruzado para arm64, e o
  estágio final (`FROM scratch`) só copia arquivos. A emulação `qemu-aarch64` por binfmt é usada para
  executar binários arm64 no PC: o BusyBox da imagem no `check-image.sh` e os containers no
  `containers-test.sh arm64`.
- **Debian.** Os pacotes da lista acima têm os mesmos nomes no Debian (`build-essential` junto); o Docker vem de
  `docker-cli` e `docker-buildx`. Dentro de um container, o `containers-build.sh` precisa do socket do Docker do PC, e
  o `check-image.sh` usa a emulação `qemu-aarch64` do kernel do PC, que funciona dentro do container mesmo sem o
  `qemu` instalado nele, porque o registro tem a flag `F`.
- **`debugfs` e `mtools`.** O `check-image.sh` e o `flash-sd.sh` usam os que o Buildroot compila em
  `output/buildroot/host/`, não os do sistema.
- **Imagem `golang`.** O build dos containers usa `golang:1.27.3-alpine`, fixada por digest em
  `docker/version.env`. O Docker a baixa na primeira vez; depois ela fica no cache.

## 2.3 Espaço em disco

Medido com `du -s --block-size=1M` na árvore de trabalho que gerou a imagem 0.4a, com o `make legal-info` já
executado:

| Diretório                            | Conteúdo                                               | Tamanho    |
|--------------------------------------|--------------------------------------------------------|-----------:|
| `buildroot/`                         | árvore do Buildroot 2026.05.1                          | 904 MiB    |
| `buildroot/dl/` (dentro do anterior) | fontes baixadas pelo Buildroot                         | 834 MiB    |
| `output/buildroot/`                  | saída do Buildroot (total)                             | 12 048 MiB |
| `output/buildroot/build/`            | pacotes compilados                                     | 6 648 MiB  |
| `output/buildroot/host/`             | toolchain e ferramentas de host                        | 3 773 MiB  |
| `output/buildroot/legal-info/`       | fontes e licenças coletadas pelo `make legal-info`     | 836 MiB    |
| `output/buildroot/images/`           | `sdcard.img`, `rootfs.ext4`, `boot.vfat`, kernel, DTBs | 578 MiB    |
| `output/buildroot/target/`           | rootfs antes de ser empacotado                         | 215 MiB    |
| `output/images/`                     | `bizas-rpi4.img.xz`                                    | 79 MiB     |
| `output/containers/`                 | tars `docker save` (0.1 a 0.4a, arm64 e amd64)         | 60 MiB     |

Somando, a árvore de trabalho com o build completo ocupa cerca de 13 GiB (não cabe num `/tmp` em tmpfs pequeno), além da imagem `golang` no cache do
Docker (376 MB, pelo `docker images`). Sem o `legal-info`, que é opcional, a saída do Buildroot fica cerca
de 0,8 GiB menor.

## 2.4 Do zero até a imagem

```sh
git clone https://github.com/phbnascimento/bizas-image.git
cd bizas-image

scripts/fetch-buildroot.sh          # baixa o Buildroot 2026.05.1, confere o SHA-256 e extrai em buildroot/
scripts/configure-buildroot.sh      # regenera e confere o defconfig (opcional: ele já está versionado)
scripts/containers-build.sh arm64   # imagens dos containers, em tar, com o SHA-256 em evidence/
scripts/build-image.sh              # compila a imagem; SHA-256 em evidence/hashes-image.txt
scripts/check-image.sh              # confere a imagem pronta sem montar nada
```

O que cada passo faz e confere:

1. **`fetch-buildroot.sh`** baixa `buildroot-2026.05.1.tar.gz` para `output/dl/` e só extrai se o SHA-256
   for `4808d8f0812d7bdb72e6ec7629de2f17c417a3ce7bf5431f752bc9150a162849`, o publicado em
   `buildroot-2026.05.1.tar.gz.sign`. Nunca apaga um `buildroot/` existente; se ele for de outra versão,
   para com erro.
2. **`configure-buildroot.sh`** carrega o `raspberrypi4_64_defconfig`, mescla o
   `buildroot-external/board/bizas/rpi4/buildroot.fragment` com o `merge_config.sh` do Buildroot, confere no
   `.config` cada opção pedida (o kconfig descarta em silêncio uma opção com dependência não satisfeita),
   grava o `bizas_rpi4_defconfig` e faz a ida e volta: recarrega o defconfig do zero e exige o mesmo
   resultado. Não compila nem baixa nada.
3. **`containers-build.sh arm64`** gera `bizas-validator:0.4a` e `bizas-server:0.4a`, exporta cada uma com
   `docker save` em `output/containers/arm64/`, confere dentro do tar a arquitetura declarada e a do binário
   `/app` (cabeçalho ELF), e grava o SHA-256 dos tars em `evidence/hashes-containers.txt`.
4. **`build-image.sh`** carrega o `bizas_rpi4_defconfig` e compila. O primeiro build baixa o toolchain, o
   kernel, o Docker e os demais fontes para `buildroot/dl/`. No fim do build do rootfs, o
   `post-build.sh` do projeto copia os tars para `/opt/bizas`, depois de conferir que o SHA-256 de cada um
   é o de `evidence/hashes-containers.txt` e que a imagem é `linux/arm64`. O script gera
   `output/buildroot/images/sdcard.img`, comprime em `output/images/bizas-rpi4.img.xz` (`xz -T0 -6`) e
   grava o SHA-256 dos dois em `evidence/hashes-image.txt`.
5. **`check-image.sh`** lê o rootfs com `debugfs` e a partição de boot com `mtools`, sem montar nada, e
   confere o conteúdo contra o repositório (capítulo 8).

O SHA-256 que acompanha a imagem entregue é a linha `bizas-rpi4.img.xz` de `evidence/hashes-image.txt`,
escrita pelo `build-image.sh`. Para conferir uma cópia baixada:

```sh
sha256sum bizas-rpi4.img.xz        # tem de ser igual à linha de evidence/hashes-image.txt
```

O `bizas-rpi4.img` que se obtém com `xz -dk bizas-rpi4.img.xz` é o próprio `sdcard.img`: o mesmo arquivo, com o mesmo
SHA-256, só com outro nome (a linha `sdcard.img` de `evidence/hashes-image.txt` vale para ele).

O hash identifica o artefato entregue. Ele não serve para comparar dois builds do mesmo código, porque os
sistemas de arquivos gerados guardam datas do momento do build.

Tamanhos do último build: `sdcard.img` com 1 107 296 768 bytes e `bizas-rpi4.img.xz` com 81 842 548 bytes.

## 2.5 Limpeza e reconstrução

Tudo o que os scripts geram fica em diretórios que o Git ignora: `buildroot/`, `output/` e os tars. O
repositório guarda só o que é preciso para reconstruir.

- **Reconstruir a imagem do zero, mantendo os fontes baixados:** apagar `output/buildroot/` e rodar de novo
  `scripts/build-image.sh`. Os fontes já baixados continuam em `buildroot/dl/` e não são baixados de novo.
- **Reconstruir só os containers:** `scripts/containers-build.sh arm64` e depois `scripts/build-image.sh`,
  que reempacota o rootfs com os tars novos.
- **Recomeçar do clone:** apagar `buildroot/` e `output/` e repetir a seção 2.4.

O post-build apaga e recria `/opt/bizas` em todo build, porque o Buildroot nunca apaga de
`output/buildroot/target/` o que sobrou de um build anterior; sem isso, tars de uma versão antiga ficariam
ao lado dos novos.

## 2.6 Mudança de versão dos containers

A versão das imagens fica só em `docker/version.env` (`VERSION=0.4a`), no esquema `MAJOR.MINOR` com uma
letra opcional para patch (`0.3a`, `0.3b`…). Ao mudar a versão ou o código da aplicação, a sequência é
`containers-build.sh arm64`, `build-image.sh` e `check-image.sh`: os hashes de `evidence/` são reescritos
pelos scripts, nunca à mão.
