# 5. Licenças e versões

Este capítulo lista o software que vai para a placa e o que só é usado para gerá-la, com versão, licença e
fonte. A parte do Buildroot vem do `make legal-info`; o resto foi conferido nos arquivos do repositório e
no registro de origem de cada componente.

## 5.1 Como o manifesto é gerado

```sh
make -C buildroot O="$PWD/output/buildroot" legal-info
```

O comando grava em `output/buildroot/legal-info/`:

- `manifest.csv` e `host-manifest.csv`: pacote, versão, licença, arquivos de licença, arquivo-fonte e site;
- `licenses/` e `host-licenses/`: o texto da licença de cada pacote;
- `sources/` e `host-sources/`: os fontes usados, com os patches aplicados;
- `buildroot.config`: a configuração do Buildroot;
- `legal-info.sha256`: o SHA-256 de cada arquivo coletado.

O diretório ocupa 836 MiB e não entra no Git: ele é regenerado pelo comando acima.

O `legal-info` registra estes avisos, que valem para a imagem atual:

- o código-fonte do próprio Buildroot não é salvo; ele é o tarball `buildroot-2026.05.1.tar.gz`, conferido
  pelo `scripts/fetch-buildroot.sh`;
- a licença do toolchain da Bootlin não é salva (o pacote do Buildroot não define os arquivos de licença);
  ela está no `summary.csv` do próprio toolchain (seção 5.2);
- no kernel, o `legal-info` não acha hash conhecido para `COPYING` e para os arquivos de
  `LICENSES/` e reporta `ERROR: No hash found`. Os arquivos são copiados mesmo assim para
  `licenses/linux-custom/`, e o comando termina com sucesso.

## 5.2 Software na placa, do Buildroot

`manifest.csv`, pacotes do rootfs e da partição de boot:

| Pacote                       | Versão                                                      | Licença                                                                                                                                              | Fonte                            |
|------------------------------|-------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------|
| `linux`                      | commit `21b410140c47ffab5668399f6f143c7d7b935c8b` (6.12.61) | GPL-2.0                                                                                                                                              | github.com/raspberrypi/linux     |
| `rpi-firmware`               | commit `063bcab6c8a90efb0d19f69d88cbbc7ec79cab68`           | BSD-3-Clause                                                                                                                                         | github.com/raspberrypi/firmware  |
| `busybox`                    | 1.38.0                                                      | GPL-2.0, bzip2-1.0.4                                                                                                                                 | busybox.net                      |
| `docker-engine`              | 28.3.3                                                      | Apache-2.0 (dependências vendorizadas podem não estar listadas)                                                                                      | github.com/moby/moby             |
| `docker-cli`                 | 28.3.3                                                      | Apache-2.0 (idem)                                                                                                                                    | github.com/docker/cli            |
| `containerd`                 | 2.0.7                                                       | Apache-2.0 (idem)                                                                                                                                    | github.com/containerd/containerd |
| `runc`                       | 1.3.5                                                       | Apache-2.0, LGPL-2.1 (libseccomp) (idem)                                                                                                             | github.com/opencontainers/runc   |
| `iptables`                   | 1.8.11                                                      | GPL-2.0                                                                                                                                              | netfilter.org                    |
| `libseccomp`                 | 2.6.0                                                       | LGPL-2.1                                                                                                                                             | github.com/seccomp/libseccomp    |
| `util-linux`                 | 2.41.5                                                      | GPL-2.0+, BSD-4-Clause, LGPL-2.1+ (libblkid, libfdisk, libmount), BSD-3-Clause (libuuid), BSD-2-Clause (xxhash), ISC (rfkill), MIT (hardlink, flock) | kernel.org                       |
| `kmod`                       | 34.2                                                        | LGPL-2.1+ (biblioteca), GPL-2.0+ (ferramentas)                                                                                                       | kernel.org                       |
| `xz`                         | 5.8.3                                                       | Public Domain, BSD-0-Clause, GPL-2.0+, GPL-3.0+, LGPL-2.1+                                                                                           | github.com/tukaani-project/xz    |
| `toolchain-external-bootlin` | 2025.08-1: glibc 2.41-70-g1502c248, gcc 14.3.0              | glibc: GPL-2.0+ (programas), LGPL-2.1+, BSD-3-Clause, MIT (biblioteca); bibliotecas de runtime do gcc: GPL-3.0-with-GCC-exception                    | toolchains.bootlin.com           |

O `legal-info` declara a licença do toolchain como `unknown`. Os valores da tabela vêm de
`output/buildroot/host/opt/ext-toolchain/summary.csv`, o manifesto que a Bootlin distribui com o toolchain;
o `README.txt` ao lado aponta os fontes e os textos de licença em `toolchains.bootlin.com/downloads/releases/`.
No rootfs, os arquivos do toolchain (bibliotecas de runtime) somam 5 638 516 bytes, pelo `graph-size`.

## 5.3 Software na placa, da aplicação

Os containers `bizas-validator:0.2` e `bizas-server:0.2` são `FROM scratch`: cada um tem só o binário
`/app`, compilado estaticamente (`CGO_ENABLED=0`). Dentro deles vão:

| Componente                                       | Versão    | Licença      | Fonte                                                    | Integridade                                                       |
|--------------------------------------------------|-----------|--------------|----------------------------------------------------------|-------------------------------------------------------------------|
| Código do Bizas                                  | 0.2       | —            | este repositório (`application/`)                        | SHA-256 dos tars em `evidence/hashes-containers.txt`              |
| Biblioteca padrão do Go (compilada nos binários) | Go 1.27.3 | BSD-3-Clause | imagem `golang:1.27.3-alpine`                            | imagem fixada por digest (5.4)                                    |
| `github.com/coder/websocket` (só no server)      | v1.8.15   | ISC          | `application/vendor/`, declarado em `application/go.mod` | `application/go.sum`                                              |
| `tweetnacl-js`, `nacl-fast.min.js` (página)      | 1.0.3     | Unlicense    | registro do npm, pacote `tweetnacl`                      | SHA-256 `3ec535c0…a5131` em `application/server/tweetnacl.sha256` |
| `qrcode-generator`, `qrcode.js` (página)         | 1.4.4     | MIT          | registro do npm, pacote `qrcode-generator`               | SHA-256 `18ae399f…f1780` em `application/server/qrcode.sha256`    |

- **Módulos Go:** `application/go.mod` exige `go 1.23` e declara um único módulo externo,
  `github.com/coder/websocket v1.8.15`. O build usa `application/vendor/` com `GOFLAGS=-mod=vendor` e
  `GOPROXY=off`, então nenhum módulo é baixado. A licença do módulo está em
  `application/vendor/github.com/coder/websocket/LICENSE.txt`.
- **Arquivos JavaScript embutidos:** `scripts/fetch-tweetnacl.sh` e `scripts/fetch-qrcode.sh` baixam o
  pacote do npm e só o aceitam se o `integrity` SHA-512 bater com o valor fixado no próprio script. O SHA-256
  de cada arquivo copiado vai para o `.sha256` correspondente, e o teste Go `TestVendoredHashes` reprova se
  o arquivo embutido na página não tiver esse SHA-256.
- **Licenças dos pacotes npm:** conferidas no campo `license` dos metadados do registro
  (`registry.npmjs.org/tweetnacl/1.0.3` e `registry.npmjs.org/qrcode-generator/1.4.4`). O cabeçalho do
  `qrcode.js` também declara a licença MIT.

## 5.4 Usado só no build

Nada desta tabela vai para a placa.

| Componente                         | Versão                                                                                                            | Licença                           | Uso                                                                     |
|------------------------------------|-------------------------------------------------------------------------------------------------------------------|-----------------------------------|-------------------------------------------------------------------------|
| Buildroot                          | 2026.05.1                                                                                                         | GPL-2.0+                          | gera a imagem                                                           |
| Imagem `golang`                    | `1.27.3-alpine`, digest `sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18` (Alpine 3.24.4) | Go: BSD-3-Clause                  | estágio de build dos dois Dockerfiles; o estágio final é `FROM scratch` |
| Go do host do Buildroot (`go-src`) | 1.26.3                                                                                                            | BSD-3-Clause                      | compila o Docker para a placa                                           |
| `genimage`                         | 19                                                                                                                | GPL-2.0                           | monta o `sdcard.img`                                                    |
| `e2fsprogs`                        | 1.47.4                                                                                                            | GPL-2.0, MIT-like (libss e libet) | gera o ext4 e fornece o `debugfs` do `check-image.sh`                   |
| `mtools`                           | 4.0.48                                                                                                            | GPL-3.0+                          | monta a partição vfat e é usado pelo `check-image.sh`                   |
| `dosfstools`                       | 4.2                                                                                                               | GPL-3.0+                          | gera a partição vfat                                                    |
| `mkpasswd`                         | do Buildroot 2026.05.1                                                                                            | GPL-2.0+                          | gera o hash da senha do root                                            |

O `host-manifest.csv` lista 45 pacotes de host ao todo; os da tabela são os que produzem ou conferem os
artefatos. Na máquina de build também são usados o Docker Engine e o Buildx (para gerar as imagens dos
containers) e, só nos testes, o Deno, o Firefox e o `zbarimg`. Nenhum deles vai para a imagem.

## 5.5 Versões fixadas

| O quê                                                      | Onde está fixado                                                                                               |
|------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| Buildroot 2026.05.1 e o SHA-256 do tarball                 | `scripts/fetch-buildroot.sh`                                                                                   |
| Configuração do Buildroot                                  | `buildroot-external/configs/bizas_rpi4_defconfig`                                                              |
| Kernel (commit) e firmware (commit)                        | herdados do `raspberrypi4_64_defconfig`, com hash conferido pelo Buildroot (`BR2_DOWNLOAD_FORCE_CHECK_HASHES`) |
| Versão dos containers (`0.2`) e imagem `golang` por digest | `docker/version.env`                                                                                           |
| Módulos Go                                                 | `application/go.mod`, `application/go.sum` e `application/vendor/`                                             |
| `tweetnacl` 1.0.3 e `qrcode-generator` 1.4.4               | `integrity` em `scripts/fetch-*.sh`, SHA-256 em `application/server/*.sha256`                                  |

Nenhuma imagem usa a tag `latest`.
