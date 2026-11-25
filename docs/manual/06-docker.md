# 6. Docker

A aplicação roda em dois containers, cada um com um binário Go estático em `FROM scratch`:

- **`bizas-validator`:** confere e guarda a cadeia.
- **`bizas-server`:** serve a página, mantém o WebSocket e repassa cada bloco ao validator.

O protocolo entre os dois está em [`docs/protocol.md`](../protocol.md).

## 6.1 O Docker na imagem

O Docker Engine é compilado pelo Buildroot e iniciado pelo init, sem login (capítulo 5):

| Peça                                        | Como entra na imagem                                                                                                                                             |
|---------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `dockerd`, `containerd`, `runc`, `iptables` | pacote `docker-engine` (`BR2_PACKAGE_DOCKER_ENGINE`), com o `S60dockerd`, e os pacotes que ele seleciona (capítulo 3)                                            |
| comando `docker`                            | pacote `docker-cli` (`BR2_PACKAGE_DOCKER_CLI`), usado pelo `provision.sh` e pelos comandos de manutenção                                                         |
| kernel                                      | o fragmento [`kernel-config/docker.fragment`](../../kernel-config/docker.fragment) (capítulo 4)                                                                  |
| cgroups                                     | cgroup v2, montado em `/sys/fs/cgroup` pelo `S30cgroupfs2`                                                                                                       |
| storage driver                              | `overlay2`, o primeiro da lista de prioridade do `dockerd` 28.3.3, sobre o OverlayFS (`CONFIG_OVERLAY_FS` embutido, capítulo 4); a imagem não traz `daemon.json` |
| rede                                        | ponte e NAT do próprio Docker, sobre `veth`, `bridge` e netfilter do kernel; a rede dos containers é a `bizas-net` (seção 6.4)                                   |
| processo `init` do container                | nenhum (`BR2_PACKAGE_DOCKER_ENGINE_DOCKER_INIT_NONE`): cada container tem um único processo, o `/app`                                                            |

As imagens dos containers vêm dentro do rootfs, em `/opt/bizas`, como tars gerados por `docker save`, e são carregadas no
1º boot. Nada é baixado no boot.

| arquivo                                                                                                                          | papel                                                                                         |
|----------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| [`docker/Dockerfile.validator`](../../docker/Dockerfile.validator), [`docker/Dockerfile.server`](../../docker/Dockerfile.server) | build das imagens (contexto: `application/`)                                                  |
| [`docker/version.env`](../../docker/version.env)                                                                                 | versão das imagens, nomes da rede e do volume, `golang` fixado por digest                     |
| [`docker/provision.sh`](../../docker/provision.sh)                                                                               | `docker load`, criação da rede, do volume e dos containers (POSIX `sh`, para o init da placa) |
| [`scripts/containers-build.sh`](../../scripts/containers-build.sh)                                                               | build, `docker save`, conferência da arquitetura dentro do tar e SHA-256 em `evidence/`       |
| [`scripts/containers-test.sh`](../../scripts/containers-test.sh)                                                                 | testa no PC as imagens, a rede, o volume e os privilégios (seção 6.8)                         |

## 6.2 Por que dois containers

A razão é o **privilégio mínimo**. O server é o único exposto na rede e não tem volume nenhum. Se ele
for comprometido, não consegue reescrever a cadeia: só pode pedir ao validator que acrescente blocos,
e o validator confere a assinatura de cada um. Já o validator, o único que grava, não tem porta
publicada no host.

## 6.3 Imagens

- **Tag fixa:** `bizas-validator:0.5a` e `bizas-server:0.5a`. Nunca `latest`. A versão fica só em
  `docker/version.env`.
- **Imagem final:** `FROM scratch`, com o binário `/app` e nada mais. Sem shell e sem bibliotecas.
- **Build:** usa `golang:1.27.3-alpine`, fixada pelo digest do índice multi-arquitetura. O compilador
  roda nativo no PC e compila cruzado para arm64. As dependências vêm de `application/vendor/`, com
  `GOPROXY=off`, então o build não baixa módulos Go. Ele baixa apenas a imagem `golang`, se ela não
  estiver no cache.
- **Na placa:** as imagens chegam como tar (`docker save`) dentro da imagem do Buildroot e são
  carregadas no 1º boot. **Nada é baixado no boot.**

Tamanhos do build arm64 da versão 0.5a:

|           | tar         | binário `/app` |
|-----------|------------:|---------------:|
| validator | 2 851 328 B | 6 750 332 B    |
| server    | 3 094 528 B | 7 405 692 B    |

O tar é menor que o binário porque a camada vai comprimida. O SHA-256 de cada tar é gravado pelo
`containers-build.sh` em `evidence/hashes-containers.txt`. O hash identifica o artefato, mas não
prova reprodutibilidade.

## 6.4 Rede, portas e volume

|                    | validator                                              | server                                                                                                                         |
|--------------------|--------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| rede               | `bizas-net` (definida pelo usuário), alias `validator` | `bizas-net`                                                                                                                    |
| porta no container | 8081                                                   | 5000                                                                                                                           |
| porta no host      | **nenhuma**                                            | **80 → 5000** (a porta de manutenção, `127.0.0.1:5001`, não é publicada)                                                       |
| volume             | `bizas-data` em `/data` (a cadeia: `/data/chain.bin`)  | **nenhum**                                                                                                                     |
| variáveis          | `ADDR` (padrão `:8081`), `DATA_DIR` (padrão `/data`)   | `ADDR` (padrão `:5000`), `ADMIN_ADDR` (padrão `127.0.0.1:5001`, só loopback), `VALIDATOR_URL` (padrão `http://validator:8081`) |
| dispositivos       | nenhum                                                 | nenhum                                                                                                                         |

- **Rede definida pelo usuário:** só nela o nome `validator` resolve pelo DNS embutido do Docker; na
  `bridge` padrão, não.
- **Porta 80:** quem a publica é o `dockerd`. O processo do server, que não é root, escuta na 5000.
- **Porta de manutenção (`127.0.0.1:5001`):** escuta só no loopback **de dentro do container** e recebe
  a hora real do `set-date` e do `set-auto-date`, que entram por `docker exec`. Ninguém na rede alcança
  essa porta, e o server se recusa a iniciar se `ADMIN_ADDR` não for de loopback.
- **`reset-chat`:** o comando da placa para o validator, roda `validator reset` num container descartável
  da mesma imagem (`--rm`, `--network none`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, usuário
  65532), que renomeia `/data/chain.bin` para `chain.bin.reset-<ns>` no volume, e religa o validator e o
  server. O validator é `FROM scratch`, sem shell nem `mv`, por isso o próprio binário faz o arquivamento.
- **Saída para a internet:** só o `set-auto-date` usa, para consultar SNTP (UDP 123). A rede
  `bizas-net` sai pela NAT do Docker quando a placa tem rota; sem rede, o comando falha com mensagem
  clara, e nada mais depende disso.
- **Volume:** um volume nomeado novo herda o dono do diretório que já existe na imagem. Por isso o
  Dockerfile do validator cria `/data` com dono 65532. Sem isso, o usuário 65532 não conseguiria
  gravar.
- **Persistência:** o volume guarda só a cadeia, em `/data/chain.bin`, com `fsync` a cada bloco. Ela
  sobrevive à recriação do container e a reboots, e um pedaço final incompleto (queda de energia no meio
  da escrita) é descartado na partida. Detalhes em [protocol.md](../protocol.md#persistência).

## 6.5 Privilégios

Opções aplicadas aos dois containers pelo `provision.sh`:

| opção                              | efeito                                                                                         |
|------------------------------------|------------------------------------------------------------------------------------------------|
| `USER 65532:65532` (Dockerfile)    | **não roda como root**                                                                         |
| `--cap-drop ALL`                   | nenhuma capability do Linux; nenhuma é necessária, porque as portas internas são acima de 1024 |
| `--security-opt no-new-privileges` | nenhum processo ganha privilégio por setuid                                                    |
| `--read-only`                      | rootfs somente leitura; o validator só escreve no volume                                       |
| `--pids-limit 64`                  | limita o número de processos                                                                   |

- **Não usados:** `--privileged`, a montagem do `docker.sock` e o repasse de dispositivos. Por isso
  não há nada a justificar nesse ponto.
- **Única exceção ao somente leitura:** o volume do validator.

## 6.6 Reinicialização e saúde

- **Reinicialização:** `--restart unless-stopped` nos dois.
- **Saúde:** o `HEALTHCHECK` chama o próprio binário (`/app health`), porque `FROM scratch` não tem
  curl. A cada 5 s, esse comando faz GET em `/health` no `127.0.0.1`, na porta do `ADDR` do container (8081 no
  validator, 5000 no server).
- **O `/health` do server** só devolve 200 quando o validator também responde. Assim, `healthy` no
  server significa que a aplicação inteira está de pé.
- **O server não depende da ordem de partida:** os dois sobem em paralelo, e o server atende desde o
  início. Enquanto o validator não responde, o `/health` dá 503 e o WebSocket fecha com "validator
  unavailable".

## 6.7 Provisionamento no 1º boot

O `docker/provision.sh` faz, nesta ordem:
1. `docker load` das imagens que faltarem;
2. cria a rede e o volume, se faltarem;
3. cria os containers, se faltarem ou se forem de outra versão;
4. dá `docker start` nos dois.

Rodar de novo não recria nada. Na placa, quem o chama é o `/etc/init.d/S99bizas`, uma única vez, no 1º boot.

## 6.8 O que foi verificado, e onde

**No PC (Docker 29.9.3), pelo `scripts/containers-test.sh`, em amd64 nativo e em arm64 sob qemu:**
- **Arquitetura:** a config da imagem e o cabeçalho ELF do `/app` dentro de cada tar conferem com a
  arquitetura pedida.
- **Provisionamento:** carrega a partir dos tars depois de apagar as imagens locais. Rodado duas
  vezes, não recria nada.
- **Saúde:** os dois containers chegam a `healthy`.
- **`docker inspect`:** confirma usuário 65532, rootfs somente leitura, `CapDrop ["ALL"]`, nenhuma
  capability acrescentada, `no-new-privileges`, não privilegiado, `unless-stopped`, as portas e as
  montagens da tabela acima e o alias `validator`.
- **Volume:** o `/data` do volume novo tem dono `65532:65532`.
- **Portas:** o validator não responde em `127.0.0.1:8081` no host.
- **Persistência:** reiniciar o validator mantém a cadeia (o mesmo SHA-256 do `/chain`). Com 300 bytes
  soltos acrescentados ao `chain.bin` no volume, como numa queda de energia no meio da escrita, o
  validator os descarta na partida, registra no log e devolve a mesma cadeia.
- **Validator parado:** o `/health` do server vai para 503 e volta a 200 sozinho quando o validator
  é religado.
- **Ponta a ponta:** o `scripts/e2e/browser.sh` passa através dos containers, com dois aparelhos
  no Firefox pelo IP da LAN.
- **Sabotagem:** sem `--read-only`, sem `--cap-drop` e com porta publicada no validator, o teste
  reprovou nos cinco pontos.
