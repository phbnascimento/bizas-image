# Bizas

Chat em que cada mensagem é **assinada no aparelho de quem escreve** e **encadeada à anterior**,
formando um histórico que qualquer pessoa pode verificar. Roda numa **Raspberry Pi 4** com uma imagem
Linux própria, gerada com Buildroot, e com a aplicação em containers Docker. Os participantes abrem o
IP da placa no navegador; não é preciso instalar nada.

Projeto final de Sistemas Embarcados (UNISANTA, 2026). A meta central do edital é a aplicação
**responder em menos de 15 s** depois que a placa é ligada.

## Como o chat funciona

### Identidade

Ao abrir a página pela primeira vez, o navegador gera um par de chaves **Ed25519** com o tweetnacl,
que vem embutido na página, sem CDN. A seed de 32 bytes fica no `localStorage` do navegador (chave
`bizas.seed`).

- **A chave privada nunca sai do aparelho.** O servidor só recebe mensagens já assinadas.
- O ID mostrado na tela são os 4 primeiros bytes da chave pública, em hex (ex.: `1d060702`).
- Se o usuário limpar os dados do site, a seed some e a identidade some com ela.

### O bloco

Cada mensagem vira um **bloco de 512 bytes**, com layout fixo e inteiros em little-endian:

| bytes | campo | conteúdo |
|---:|---|---|
| 8 | `room` | nome da sala (padrão `Bizas`) |
| 8 | `stamp` | instante em nanossegundos desde 1970 (UTC) |
| 8 | `nonce` | número aleatório |
| 4 + 2 | `info`, `type` | uso livre e tipo do conteúdo (`TEXT`, …) |
| 2 | `length` | quantos bytes de `data` estão em uso (0 a 320) |
| 32 | `author` | chave pública de quem assinou |
| 64 | `sig` | assinatura Ed25519 |
| 64 | `prev` | **assinatura do bloco anterior** |
| 320 | `data` | o texto, em UTF-8 |

- **O que se assina:** os 512 bytes inteiros, com o campo `sig` zerado.
- **Por que layout fixo:** o navegador (JavaScript) e o servidor (Go) precisam gerar exatamente os
  mesmos bytes, senão a assinatura não confere. Um vetor de teste compartilhado
  (`application/bizas/testdata/vector.txt`) prova que os dois lados produzem bytes e assinaturas
  idênticos.

### O encadeamento

Cada bloco guarda, no campo `prev`, a assinatura do bloco anterior. O primeiro bloco (a *gênese*) tem
`prev` zerado.

![Três blocos encadeados: o prev de cada bloco guarda a assinatura (sig) do anterior](assets/chain.svg)

Como a assinatura cobre o bloco inteiro, inclusive o `prev`, alterar qualquer bloco antigo invalida a
assinatura dele, e o bloco seguinte deixa de apontar para uma assinatura válida. A adulteração aparece
na verificação.

### Caminho de uma mensagem

```
navegador ──WebSocket──▶ server ──HTTP interno──▶ validator
 monta e assina          confere o tamanho         confere assinatura, sala,
 o bloco, com a hora     (512 bytes) e repassa     carimbo e encadeamento;
 da placa                                          grava em disco e acrescenta
   ▲                          │
   └── todos os navegadores ◀─┘ o server transmite só o que o validator aceitou
       recebem o bloco e conferem a assinatura de novo
```

1. O navegador monta o bloco sobre a última mensagem que conhece (a *cabeça*), com a hora que a placa
   informou ao conectar, assina e envia.
2. O **server** não decide nada: confere só se o frame tem 512 bytes e repassa ao validator.
3. O **validator** confere o bloco contra a cabeça: assinatura, sala, carimbo de tempo que não volta
   para trás nem está à frente do relógio da placa, e `prev` igual à assinatura da cabeça. Se tudo
   confere, grava o bloco em disco e só então o acrescenta.
4. O server transmite o bloco aceito a todos os navegadores conectados, inclusive a quem enviou, para
   quem isso serve de confirmação. Confirmado significa gravado.
5. Cada navegador confere a assinatura de novo, sem confiar no servidor.

**Dois aparelhos ao mesmo tempo.** Se dois aparelhos assinam sobre a mesma cabeça, o validator aceita
o primeiro e recusa o segundo, devolvendo a cabeça nova. O navegador recusado refaz o bloco sobre ela e
reenvia sozinho, até 3 tentativas.

**Quem conecta depois** recebe o histórico inteiro ao abrir a página.

### A hora das mensagens

Quem fornece a hora é a **placa**, e não o celular. Ao conectar, a página recebe o relógio do validator
e assina cada mensagem com ele. Um aparelho com o relógio errado não muda nada.

O validator recusa um carimbo mais de 5 s à frente do próprio relógio. Sem essa regra, alguém poderia
mandar uma mensagem datada de 2100 e "congelar" o chat: toda mensagem seguinte teria de vir depois dela.

Se a placa religar com o relógio atrás da última mensagem gravada (sem RTC e sem internet, por
exemplo), o validator continua contando a partir da última mensagem. A ordem se mantém, mas o
carimbo é a hora da placa, que só é hora de calendário se o relógio dela estiver certo. Por isso, a
página mostra:

- **por padrão, a idade de cada mensagem** ("just now", "5 min ago"), medida no relógio da placa.
  Ela é certa mesmo com a placa achando que está em 1970;
- **data e hora, depois de um `set-date` ou `set-auto-date`.** Quem informa a hora real é a pessoa
  na manutenção, e a página converte a hora da placa na hora real. Vale para as mensagens da execução
  atual do validator e não sobrevive a um reinício. Os carimbos assinados não mudam: só a exibição
  muda;
- **"earlier session"** para mensagens de antes de um reinício do validator. O tempo em que a placa
  ficou desligada não foi contado, então nenhuma hora mostrada para elas seria confiável.

Comandos de manutenção, como root no console da placa:

```sh
set-date 2026-11-20-03-39-55                 # hora real em UTC (Greenwich), o padrão
set-date 2026-11-20-00-39-55 --tz -03:00     # a mesma hora, digitada no horário de Brasília
set-auto-date                                # consulta a hora pela rede (SNTP); sem rede, sai com erro
```

- **Formato da data:** do ano até os segundos, separados por hífen: `AAAA-MM-DD-hh-mm-ss`.
- **Flag `--tz`:** diz em que fuso a hora foi digitada. Sem ela, vale UTC. Aceita um deslocamento em
  relação a UTC (`-03:00`, `+05:30`) ou `Z` para UTC, e pode vir antes ou depois da data
  (`--tz -03:00` ou `--tz=-03:00`).
- **O que muda e o que não muda:** a flag só afeta como a hora digitada é lida. A página continua
  mostrando a hora no fuso de cada aparelho.

### Onde a cadeia fica guardada

No validator, em `/data/chain.bin`, no volume Docker `bizas-data`. O arquivo guarda só a cadeia, nos
mesmos blocos de 512 bytes do `GET /chain`, e passa por `fsync` a cada mensagem.

- **Queda de energia no meio de uma gravação:** deixa um pedaço incompleto no fim, que o validator
  descarta ao religar. Esse pedaço nunca tinha sido confirmado.
- **Bloco danificado no meio:** o validator mantém a parte válida e move o resto para um arquivo de
  quarentena ao lado, sem apagar nada.

O protocolo completo, com rotas, mensagens e códigos de erro, está em [docs/protocol.md](docs/protocol.md).

### Verificação por terceiros

A cadeia inteira pode ser baixada em `GET /chain` (link "Download the chain" na página) e conferida
fora da Pi:

```sh
cd application && go build -o validator ./validator
./validator verify chain.bin    # "valid: N blocks" ou "INVALID: <erro> at block <i> (of N)"
```

### Impressão digital da cadeia

A página mostra, ao lado do número de blocos, a **impressão digital** da cadeia: os 16 primeiros
dígitos hex da assinatura do último bloco (ex.: `blocks 4 · fingerprint f881f48ff0301551`).

- **Por que ela resume o histórico inteiro:** a assinatura de cada bloco cobre o `prev`, que é a
  assinatura do anterior, e assim até a gênese. Se qualquer bloco anterior fosse diferente, a
  assinatura da cabeça também seria. Não é preciso um hash à parte.
- **Para que serve:** duas pessoas que veem a mesma altura e a mesma impressão digital têm o mesmo
  histórico até ali. É assim que alguém confere se o seu histórico bate com o dos demais, ou com uma
  cadeia exportada:

```sh
./validator fingerprint chain.bin       # "#4 f881f48ff0301551" (a cabeça)
./validator fingerprint chain.bin 2     # na altura 2, para comparar com quem viu só 2 blocos
```

### É uma blockchain?

No sentido de **blocos encadeados e assinados, verificáveis por terceiros**, sim. No sentido de rede
descentralizada com consenso entre vários nós, **não**: existe um único _validator_, na Pi.

Para entender o que o sistema garante, é preciso separar **validade** de **consenso**.

**Validade: garantida pelo protocolo.** Uma cadeia é válida quando a assinatura de cada bloco confere
com o autor declarado e o `prev` de cada bloco aponta para o anterior. Numa cadeia válida:

- **ninguém se passa por outra pessoa**: sem a chave privada de alguém, ninguém assina em nome dela,
  nem o próprio servidor;
- **ninguém altera a mensagem de outra pessoa**: mudar um único byte invalida a assinatura do bloco;
- **a ordem é fixa**: inserir, remover ou trocar blocos no meio quebra o encadeamento.

Qualquer pessoa confere isso com `validator verify`, sem confiar na Pi.

**Consenso: fora do alcance do protocolo.** A validade não diz *qual* cadeia é a cadeia. Duas cadeias
podem ser ambas válidas e divergir a partir de um ponto. Por exemplo, uma cortada no fim, ou uma em que,
a partir de certo bloco, outra pessoa seguiu escrevendo com a própria chave. Nenhuma delas falsifica a
mensagem de ninguém; elas contam histórias diferentes depois do ponto em que se separam. Escolher entre
cadeias válidas é consenso, e aqui ele é simples: vale a cadeia que o _validator_ da Pi guarda. Quem
quer confirmar que uma cadeia é a mesma que acompanhou compara a [impressão digital](#impressão-digital-da-cadeia)
na altura que viu.

Duas placas montadas a partir deste repositório têm cadeias independentes. Reproduzir o sistema não é
o mesmo que descentralizá-lo.

## Arquitetura da imagem

```
Raspberry Pi 4 (4 GB)
└── Linux próprio, gerado com Buildroot 2026.05.1
    ├── kernel com o necessário para Docker (cgroups, namespaces, overlay, rede)
    ├── init, rede (Ethernet) e dockerd, iniciados sem login
    └── Docker
        └── rede bizas-net (definida pelo usuário)
            ├── bizas-validator  sem porta no host · volume bizas-data em /data
            └── bizas-server     porta 80 do host → 5000 · sem volume
```

### Os dois containers

Cada container tem um único binário Go estático, numa imagem `FROM scratch` (sem shell, sem
bibliotecas): cerca de 2,8 MB e 3,0 MB em arm64.

| | `bizas-validator` | `bizas-server` |
|---|---|---|
| papel | único dono da cadeia: confere, grava e serve o histórico | página, WebSocket e repasse ao validator |
| porta no host | **nenhuma** | 80 → 5000 |
| volume | `bizas-data` em `/data` | **nenhum** |

**Por que dois containers: privilégio mínimo.** O server é o único exposto na rede e não tem volume.
Se ele for comprometido, não consegue reescrever a cadeia; só pode pedir ao validator que acrescente
blocos, e o validator confere a assinatura de cada um.

Opções aplicadas aos dois containers:
- usuário não-root (65532);
- rootfs somente leitura;
- `--cap-drop ALL` e `no-new-privileges`;
- `--restart unless-stopped`;
- healthcheck a cada 5 s, pelo próprio binário (`/app health`).

Não há modo privilegiado, nem `docker.sock` montado, nem dispositivo repassado. Detalhes e
justificativas em [docs/containers.md](docs/containers.md).

### A imagem Buildroot

A configuração parte do `raspberrypi4_64_defconfig` do Buildroot 2026.05.1 e acrescenta só o que a
aplicação precisa (`buildroot-external/board/bizas/rpi4/buildroot.fragment`):

- **Docker:** `docker-engine` (dockerd, containerd, runc, iptables) e `docker-cli`.
- **Kernel:** o fragmento `kernel-config/docker.fragment` garante namespaces, cgroups, veth, bridge,
  netfilter/NAT e overlayfs.
- **rootfs ext4 de 1024 MB**, porque os 120 MB de fábrica não comportam o Docker e as imagens.
- **`config.txt` e `cmdline.txt` próprios:** o `config.txt` de 64 bits de fábrica, mais
  `disable_splash=1` e `boot_delay=0`; o `cmdline.txt` com `quiet loglevel=3`.
- **Acesso de manutenção:** pelo console (HDMI ou serial), usuário `root`, senha `bizasprotocol`. O
  Buildroot grava só o hash da senha (SHA-256 crypt) no `/etc/shadow`.
- **A aplicação:** o `post-build.sh` copia para `/opt/bizas` os tars arm64 dos containers, o
  `provision.sh` e o `version.env`. Antes, confere que cada tar tem o SHA-256 registrado em
  `evidence/hashes-containers.txt` e que é mesmo uma imagem `linux/arm64`.

`scripts/configure-buildroot.sh` aplica o fragmento, confere no `.config` cada opção pedida e grava
`buildroot-external/configs/bizas_rpi4_defconfig`.

### Boot e provisionamento

- **Ordem:** o init do BusyBox roda os scripts de `/etc/init.d`. O `S60dockerd` inicia o Docker, e o
  `S99bizas` cuida da aplicação.
- **1º boot:** o `S99bizas` espera o `dockerd` responder e roda o `/opt/bizas/provision.sh`. Ele
  carrega as imagens com `docker load`, cria a rede, o volume e os containers, e o script grava uma
  marca em `/var/lib/bizas/` quando os dois containers estão rodando. Esse passo é avisado no console
  e, pelas regras do edital, não entra na medição de tempo.
- **Boots seguintes:** com a marca presente, o `S99bizas` não faz nada. Quem religa os containers é o
  próprio `dockerd` (`--restart unless-stopped`), sem comando `docker` no caminho crítico.
- **Desligamento:** o `S99bizas stop` não para os containers, de propósito. Um `docker stop` os
  marcaria como parados manualmente, e o `unless-stopped` não os religaria no boot seguinte.
- **Medição:** do instante em que a placa é energizada até a primeira resposta válida de `/health`,
  vista de outro equipamento, em três boots frios seguidos (`scripts/measure-boot.sh`).

## Estrutura do repositório

```
application/            código da aplicação (módulo Go)
├── bizas/              biblioteca comum: bloco, assinatura, cadeia, API do validator e o vetor de teste
├── validator/          binário do validator (servir, health, verify)
├── server/             binário do server (HTTP, WebSocket) e a página embutida em static/
└── vendor/             dependências Go, para o build não precisar de rede
assets/                 imagens do README
buildroot-external/     BR2_EXTERNAL do projeto
├── configs/            bizas_rpi4_defconfig (gerado por scripts/configure-buildroot.sh)
└── board/bizas/rpi4/   fragmento do Buildroot, config.txt, cmdline.txt e post-build.sh
docker/                 Dockerfiles, versão das imagens e provisionamento
docs/                   protocolo e containers
evidence/               hashes gerados pelos scripts
kernel-config/          fragmento de kernel para o Docker
rootfs-overlay/         arquivos copiados para o rootfs (o init S99bizas)
scripts/                build, testes, medição de boot e utilitários
```

O código do Buildroot não é versionado: `scripts/fetch-buildroot.sh` baixa o tarball oficial
(2026.05.1), confere o SHA-256 publicado (`4808d8f0…a162849`) e o extrai em `buildroot/`, que o Git
ignora.

## Como rodar e testar (no PC)

Requisitos: Go 1.23 ou mais novo, Deno, Docker com buildx (e qemu para arm64), Firefox, `curl`, `jq`.

```sh
# testes Go (bloco, validator, server, página embutida)
cd application && go test -race ./... && cd ..

# o JavaScript da página serializa e assina igual ao Go
deno test --allow-read application/server/bizas.test.js

# ponta a ponta: dois "aparelhos" no Firefox headless, pela rede local
scripts/e2e/browser.sh

# containers: build, conferência da arquitetura e teste completo
scripts/containers-build.sh amd64 && scripts/containers-test.sh amd64
scripts/containers-build.sh arm64          # imagens para a Pi; hashes em evidence/

# Buildroot: obter o 2026.05.1 (confere o SHA-256) e gerar e conferir o defconfig (não compila nada)
scripts/fetch-buildroot.sh
scripts/configure-buildroot.sh
```

Os scripts de teste recusam rodar se encontram portas, containers, rede ou volume já em uso, para não
mexer em nada que não criaram.

## Documentação

- [docs/protocol.md](docs/protocol.md): formato do bloco, regras de validade, rotas, WebSocket e o que
  foi verificado.
- [docs/containers.md](docs/containers.md): imagens, rede, portas, volume, privilégios e
  provisionamento.
