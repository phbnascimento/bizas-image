# Bizas

<p align="center"><img src="assets/bizas.png" alt="Logo do Bizas" width="160"></p>

Imagem Linux própria para a **Raspberry Pi 4**, gerada com **Buildroot** 2026.05.1, que ao ligar sobe sozinha a
aplicação em **containers Docker**: o **Bizas**, um chat em que cada mensagem é **assinada no aparelho de quem
escreve** e **encadeada à anterior**, formando um histórico que qualquer pessoa pode verificar. Os participantes
abrem o IP da placa no navegador; não é preciso instalar nada.

Projeto final de Sistemas Embarcados (UNISANTA, 2026). A meta central é a aplicação
**responder em menos de 15 s** depois que a placa é ligada.

## Simples e portátil

O Bizas inteiro cabe em **dois binários Go estáticos e uma página**. Não há banco de dados, interpretador,
servidor web à parte, CDN nem conta em serviço nenhum.

- **Dois binários, nada mais:** cada container é uma imagem `FROM scratch` com um único arquivo, `/app`: sem
  shell, sem bibliotecas, sem sistema base. São cerca de 2,9 MB (validator) e 3,1 MB (server) em arm64. O código
  usa a biblioteca padrão do Go e uma única dependência externa, `github.com/coder/websocket`.
- **A cadeia é um arquivo:** o histórico inteiro é `chain.bin`, blocos de 512 bytes um atrás do outro, sem
  índice nem esquema. É o mesmo formato que a página baixa em `/chain` e que o `validator verify` confere em
  qualquer computador com Go.
- **Um formato de bloco, qualquer plataforma:** o bloco tem layout fixo e inteiros em little-endian por regra, sem
  JSON nem serialização ambígua. Os bytes e as assinaturas não dependem da linguagem, da arquitetura nem de uma
  biblioteca: o navegador (JavaScript) e o validator (Go) produzem os mesmos bytes, provados por um vetor de teste
  compartilhado.
- **Nada para instalar no aparelho:** quem participa só abre o IP da placa no navegador. A criptografia e o QR
  code vêm embutidos na página, e ela funciona por `http://` na rede local, sem HTTPS e sem internet.
- **Mesmo código em outras arquiteturas:** o Go compila o mesmo código para as arquiteturas que ele suporta
  trocando uma variável (`GOARCH`). As imagens são geradas e testadas em **arm64**, para a Raspberry Pi, e em
  **amd64**, no PC; o teste completo dos containers roda nas duas.
- **Build sem internet:** as dependências Go ficam em `application/vendor/`, as bibliotecas JavaScript estão
  copiadas no repositório com o SHA-256 anotado, e a imagem do compilador Go é fixada por digest.
- **Manutenção em poucos comandos:** `set-date`, `set-auto-date` e `reset-chat`, no console da placa.

## A imagem e sua arquitetura

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
bibliotecas): cerca de 2,9 MB e 3,1 MB em arm64.

|               | `bizas-validator`                                        | `bizas-server`                           |
|---------------|----------------------------------------------------------|------------------------------------------|
| Papel         | único dono da cadeia: confere, grava e serve o histórico | Página, WebSocket e repasse ao validator |
| Porta no host | **nenhuma**                                              | 80 → 5000                                |
| Volume        | `bizas-data` em `/data`                                  | **Nenhum**                               |

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
- **Usuário padrão:** `anon`, senha `bizasprotocol`, sem privilégios (não está no grupo do Docker e não usa
  `reset-chat`, `set-date` nem `set-auto-date`, que são do `root`). É criado no build por
  `buildroot-external/board/bizas/rpi4/users.txt`.
- **Boas-vindas do console:** antes do login aparecem a arte do Bizas (`assets/bizas-ascii-20lines.txt`, em magenta), "Bem-vindo!
  bizas vN.N" e a tabela de nomes e RAs (em amarelo). O `/etc/issue` é gerado no build por `scripts/lib/make-issue.py`, com a
  versão do `docker/version.env`; não se edita à mão.
- **Prompt do shell:** `diretório β `, com o diretório atual em amarelo claro e o β em magenta e negrito
  (`rootfs-overlay/etc/profile.d/prompt.sh`), igual para `root` e `anon`.
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
  e não entra na medição do tempo de boot, que é feita depois do provisionamento.
- **Boots seguintes:** com a marca presente, o `S99bizas` não faz nada. Quem religa os containers é o
  próprio `dockerd` (`--restart unless-stopped`), sem comando `docker` no caminho crítico.
- **Desligamento:** o `S99bizas stop` não para os containers, de propósito. Um `docker stop` os
  marcaria como parados manualmente, e o `unless-stopped` não os religaria no boot seguinte.
- **Medição:** do instante em que a placa é energizada até a primeira resposta válida de `/health`,
  vista de outro equipamento, em três boots frios seguidos (`scripts/measure-boot.sh`).

### Gerar, conferir e gravar a imagem

```sh
scripts/fetch-buildroot.sh          # obtém o Buildroot 2026.05.1 e confere o SHA-256
scripts/configure-buildroot.sh      # gera e confere o defconfig (não compila nada)
scripts/containers-build.sh arm64   # os tars dos containers que vão para a imagem
scripts/build-image.sh              # compila; gera sdcard.img e bizas-rpi4.img.xz, hashes em evidence/
scripts/check-image.sh              # confere a imagem pronta sem montar nada
scripts/flash-sd.sh                 # grava no microSD e confere lendo de volta
```

- **`build-image.sh`:** carrega o `bizas_rpi4_defconfig` e compila. Gera `output/buildroot/images/sdcard.img` e a
  versão compactada `output/images/bizas-rpi4.img.xz`, com o SHA-256 das duas em `evidence/hashes-image.txt`. O
  `bizas-rpi4.img`, que sai de `xz -dk bizas-rpi4.img.xz` (e que a release lista no `SHA256SUMS`), é o próprio
  `sdcard.img`: o mesmo arquivo, com o mesmo hash, só com outro nome.
- **`check-image.sh`:** lê o rootfs com `debugfs` e a partição de boot com `mtools`. Confere:
  - `/opt/bizas` e os tars, contra `evidence/`;
  - os scripts de init, as permissões e a senha do root;
  - `config.txt` e `cmdline.txt`;
  - o kernel, contra o fragmento do Docker e o `check-config.sh` do docker-engine (resultado em
    `evidence/kernel-check-config.txt`);
  - os scripts, passados pelo `sh` do BusyBox da própria imagem.
- **`flash-sd.sh`:** pede o dispositivo digitado duas vezes e recusa o disco do sistema. Só grava a imagem cujo
  hash está registrado e, no fim, lê o cartão de volta para comparar.

## O Bizas: chat assinado e encadeado

### Identidade

Ao abrir a página pela primeira vez, aparece só uma tela com o campo da chave privada: a pessoa gera uma
nova (botão de dado, com `crypto.getRandomValues`) ou cola uma que já tem (64 caracteres hexadecimais, a seed
de 32 bytes). A página mostra a chave pública correspondente, em hex, e a pessoa confirma que é aquela que
quer usar. Só então a seed é gravada no `localStorage` do navegador (chave `bizas.seed`) e a página conecta.
O par de chaves é **Ed25519**, com o tweetnacl embutido na página, sem CDN. Enquanto a chave privada está
válida no campo, a tela mostra também o QR code dela (aviso: não compartilhe a chave privada com ninguém).

Clicar no ID de uma pessoa (na barra ou numa mensagem) abre um painel com a chave pública completa, o QR code
dela, um nome, uma cor e uma nota de texto livre que só este navegador guarda (`bizas.names`, `bizas.hues` e
`bizas.notes` no `localStorage`; a nota é só para você, para anotar algo sobre o dono da chave), o
índice e a hora do primeiro bloco dela e quantos blocos enviou. O "ver", à direita do ID em cada mensagem, abre
no mesmo lugar os campos do bloco: o valor bruto de cada um (`room`, `stamp`, `nonce`, `info`, `type`, `length`,
`author`, `sig`, `prev` e os bytes usados do `data`) e, embaixo, uma leitura dele, como a data UTC do carimbo, o
nome do tipo e quantos bits zero a assinatura tem. A engrenagem abre as configurações: língua
(português ou inglês) e tema (claro ou escuro), guardados em `bizas.lang` e `bizas.theme`. O QR code vem do
`qrcode-generator` (MIT), embutido na página.

O navegador guarda estes dados no `localStorage`, só neste aparelho; nada deles vai para a cadeia nem para o server:

- **`bizas.seed`:** a chave privada (a seed de 32 bytes, em hexadecimal). É a identidade da pessoa: sem ela, não dá
  para assinar como aquele autor, e limpar os dados do site a apaga, e a identidade junto.
- **`bizas.names`, `bizas.notes` e `bizas.hues`:** o nome, a nota e a cor que este aparelho dá a cada chave pública.
- **`bizas.lang` e `bizas.theme`:** a língua e o tema.

Nas configurações, **Enable Fraud Test** expande a barra de baixo e mostra todos os campos do bloco (`room`,
`stamp`, `nonce`, `info`, `type`, `length`, `author`, `sig`, `prev`), menos o `data`, que é o texto da
mensagem. Cada campo pode ser editado à mão, e o botão *default* ao lado devolve o valor que a mensagem normal
teria. A opção "sign automatically" refaz a assinatura depois das edições, para que a recusa venha das regras do
protocolo (`NO_TIMESTAMP_CONTINUITY`, `INVALID_ROOM`, `NO_HASH_CONTINUITY`, `INVALID_LENGTH`,
`TIMESTAMP_IN_FUTURE`); desmarcada, ou com `sig` ou `author` editados, a recusa é `FRAUD`. Ao enviar, a página faz a
prova de trabalho variando o `nonce`, a não ser que o `nonce` ou a `sig` tenham sido digitados: um `nonce` digitado
cuja assinatura não tem os bits zero exigidos é recusado com `INSUFFICIENT_WORK`. O código que o
validator devolve aparece abaixo dos campos, que ficam logo abaixo da barra de mensagem. "Reset all fields" volta todos os
campos ao valor padrão de uma vez. Nada é reenviado automaticamente, e o bloco só entra na cadeia se
o validator o aceitar.

Abaixo do botão de restaurar há quatro opções, uma por linha: editar o `room` em bytes (hexadecimal) em vez de texto
(o padrão é texto, como `Bizas`); atualizar o `stamp` automaticamente (desmarcada, ele fica congelado no instante em
que a opção foi desmarcada); editar o `stamp` como data UTC (`2030-01-01 00:04:05.123456789`) em vez de nanossegundos; e
assinar automaticamente depois das edições. Ao trocar o modo de um campo já editado, o texto é convertido, quando dá.

- **A chave privada nunca sai do aparelho.** O servidor só recebe mensagens já assinadas.
- O ID mostrado na tela são os 4 primeiros bytes da chave pública, em hex (ex.: `1d060702`).
- Se o usuário limpar os dados do site, a seed some e a identidade some com ela.

### O bloco

Cada mensagem vira um **bloco de 512 bytes**, com layout fixo e inteiros em little-endian:

| bytes | campo    | conteúdo                                                                    |
|------:|----------|-----------------------------------------------------------------------------|
| 8     | `room`   | nome da sala (padrão `Bizas`)                                               |
| 8     | `stamp`  | instante em nanossegundos desde 1970 (UTC)                                  |
| 8     | `nonce`  | número variado pela prova de trabalho                                       |
| 4     | `info`   | no gênese, o N da prova de trabalho; nos outros, livre (as enquetes o usam) |
| 2     | `type`   | tipo do conteúdo (`TEXT`, …; `POLL` e `VOTE` nas enquetes)                  |
| 2     | `length` | quantos bytes de `data` estão em uso (0 a 320)                              |
| 32    | `author` | chave pública de quem assinou                                               |
| 64    | `sig`    | assinatura Ed25519                                                          |
| 64    | `prev`   | **assinatura do bloco anterior**                                            |
| 320   | `data`   | o texto, em UTF-8                                                           |

- **O que se assina:** os 512 bytes inteiros, com o campo `sig` zerado.
- **Por que layout fixo e little-endian:** é o que torna o protocolo portável entre plataformas distintas. Os bytes
  assinados têm de ser idênticos em qualquer implementação, senão a assinatura não confere. Por isso cada campo tem
  offset e tamanho fixos, e a ordem dos bytes dos inteiros é mandatória (little-endian), em vez de depender da máquina,
  da linguagem ou de uma biblioteca de serialização. Hoje há duas implementações, o navegador (JavaScript) e o servidor
  (Go), e um vetor de teste compartilhado (`application/bizas/testdata/vector.txt`) prova que as duas produzem bytes e
  assinaturas idênticos.

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
   informou ao conectar, faz a prova de trabalho (abaixo) e envia.
2. O **server** não decide nada: confere só se o frame tem 512 bytes e repassa ao validator.
3. O **validator** confere o bloco contra a cabeça: assinatura, sala, carimbo de tempo que não volta
   para trás nem está à frente do relógio da placa, `prev` igual à assinatura da cabeça e a prova de
   trabalho. Se tudo
   confere, grava o bloco em disco e só então o acrescenta.
4. O server transmite o bloco aceito a todos os navegadores conectados, inclusive a quem enviou, para
   quem isso serve de confirmação. Confirmado significa gravado.
5. Cada navegador confere a assinatura e a prova de trabalho de novo, sem confiar no servidor.

**Prova de trabalho.** Quem envia a primeira mensagem, o gênese, escolhe N, de 0 a 20 (a página sugere 10), e o
grava no `info` do gênese. Toda assinatura da sala, inclusive a do gênese, tem de começar com N bits zero. A
assinatura Ed25519 não muda se a mensagem não muda, então o navegador soma 1 ao `nonce` e assina de novo até achar
uma assinatura com os bits zero: em média, 2^N tentativas (1024 com N = 10). O cabeçalho da página mostra o N da sala,
e a linha abaixo da barra de mensagem mostra as tentativas enquanto a busca roda. Uma assinatura do tweetnacl levou
3,5 ms no PC de desenvolvimento (medido no Deno); a estimativa para N = 10 nesse PC é de cerca de 3,6 s por
mensagem.

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

### Exemplo de extensão: enquetes (polls)

As enquetes **não fazem parte do protocolo em si**: são um exemplo de extensão construída só com os campos livres do
bloco, `type` e `info`. Esse mecanismo funciona como uma espécie de **plugin**, que acrescenta uma função ao chat sem
mexer no que já existia: o formato do bloco, a assinatura e o encadeamento não mudam.

Em termos técnicos, é um **soft fork**, pois a extensão só acrescenta regras. Toda cadeia válida com as enquetes também
é válida para um validator que não as conhece, porque ele ignora o `type`; o contrário não vale. Uma cadeia com um voto
repetido, por exemplo, passa no `validator verify` da versão 0.3 (`valid: 17 blocks`) e é recusada pelo atual
(`INVALID: DUPLICATE_VOTE at block 16 (of 17)`).

- **Criar:** o botão "+", à esquerda da barra de mensagem, abre um menu que por enquanto só tem "📊 Create New Poll"
  ("📊 Criar Nova Enquete", em português). Ele abre o painel lateral com a pergunta, de 2 a 10 opções e a caixa "One
  choice per person", que torna as opções mutuamente exclusivas. A enquete vai num bloco `POLL`: a pergunta e as
  opções no `data`, e a exclusividade no bit 0 do `info`.
- **Votar:** a enquete aparece como uma mensagem, com uma barra por opção, a porcentagem e o número de votos ao lado.
  Clicar numa opção vota, e clicar de novo retira o voto. Cada voto é um bloco `VOTE`, com o índice do bloco da enquete
  no `info`, e aparece como uma linha: "`1d060702` voted for “Pizza” in the poll at block 6 · “Where shall we eat?”".
- **Um voto por opção:** em nenhuma enquete alguém vota duas vezes na mesma opção; o validator recusa o bloco com
  `DUPLICATE_VOTE`, e a pessoa só pode retirar o voto. Numa enquete exclusiva, cada pessoa tem no máximo um voto ativo.
- **Trocar de opção numa enquete exclusiva:** são dois blocos, a retirada do voto atual e o voto novo, que a página
  envia em sequência com um clique. Cada um paga a própria prova de trabalho, então a troca leva o dobro do tempo de uma
  mensagem. Com dois blocos, a regra fica simples (um voto ativo por pessoa) e a retirada continua sendo o único jeito
  de desfazer um voto.

As regras completas, a codificação e os códigos de erro estão em [docs/protocol.md](docs/protocol.md).

### Começar um chat novo

O `reset-chat`, como root no console da placa, começa um chat com a cadeia vazia:

```sh
reset-chat          # pede para digitar "reset" antes de continuar
reset-chat --yes    # sem pergunta
```

- **Nada é apagado:** a cadeia atual é renomeada para `chain.bin.reset-<ns>`, ao lado da nova, no volume
  `bizas-data`, e continua conferível com `validator verify`. Com a cadeia já vazia, nada é arquivado.
- **Como:** o comando para o validator, roda `validator reset` num container descartável da mesma imagem, sem
  rede, religa o validator e reinicia o server. As páginas abertas reconectam sozinhas e recebem o histórico
  vazio; a próxima mensagem é um gênese novo, com um N novo para a prova de trabalho.
- **Hora real:** depois do reset, a hora informada com `set-date` ou `set-auto-date` precisa ser informada de novo.

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

## Estrutura do repositório

```
buildroot-external/     BR2_EXTERNAL do projeto
├── configs/            bizas_rpi4_defconfig (gerado por scripts/configure-buildroot.sh)
└── board/bizas/rpi4/   fragmento do Buildroot, config.txt, cmdline.txt e post-build.sh
kernel-config/          fragmento de kernel para o Docker
rootfs-overlay/         arquivos copiados para o rootfs (o init S99bizas e os comandos de manutenção)
docker/                 Dockerfiles, versão das imagens e provisionamento
application/            código da aplicação (módulo Go)
├── bizas/              biblioteca comum: bloco, assinatura, cadeia, API do validator e o vetor de teste
├── validator/          binário do validator (servir, health, verify, fingerprint, reset)
├── server/             binário do server (HTTP, WebSocket) e a página embutida em static/
└── vendor/             dependências Go, para o build não precisar de rede
scripts/                build, testes, medição de boot e utilitários
evidence/               hashes gerados pelos scripts
docs/                   protocolo e containers
assets/                 imagens do README
```

O código do Buildroot não é versionado: `scripts/fetch-buildroot.sh` baixa o tarball oficial
(2026.05.1), confere o SHA-256 publicado (`4808d8f0…a162849`) e o extrai em `buildroot/`, que o Git
ignora.

## Como rodar e testar (no PC)

Requisitos: Go 1.23 ou mais novo, Deno, Docker com buildx (e qemu para arm64), Firefox, `curl`, `jq` e `zbarimg` (pacote `zbar`, para o teste do navegador ler o QR code).

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
```

Os scripts de teste recusam rodar se encontram portas, containers, rede ou volume já em uso, para não
mexer em nada que não criaram.

### Abrir a página no PC

```sh
scripts/dev-server.sh               # compila e sobe; para com Ctrl+C
scripts/dev-server.sh --port 9000   # outra porta (padrão 8080)
scripts/dev-server.sh --fresh       # começa com a cadeia vazia
```

O script roda o validator e o server como processos locais, sem Docker, e escuta em todas as interfaces. Ao subir,
mostra os endereços (`http://127.0.0.1:8080` e o IP de cada rede do PC), que também abrem em outro aparelho da mesma
rede. Se o outro aparelho não conectar, é o firewall do PC bloqueando a porta.

- **O que funciona:** a página, o chat, a cadeia gravada em `output/dev/data/chain.bin`, a impressão digital, o
  `/chain` e o `validator verify`.
- **O que não existe fora da placa:** os containers, o init e os comandos `set-date`, `set-auto-date` e `reset-chat`
  em `/usr/bin`. O script mostra, ao subir, como chamar os dois primeiros pelo binário
  (`ADMIN_ADDR=127.0.0.1:8081 output/dev/server set-date …`); no lugar do `reset-chat`, o `--fresh` começa com a
  cadeia vazia (e apaga a do PC).

## Documentação

- [docs/manual/](docs/manual/README.md): manual técnico (arquitetura, build, Buildroot, kernel, licenças,
  testes, gravação e recuperação); o PDF sai de `scripts/build-manual.sh`.
- [docs/protocol.md](docs/protocol.md): formato do bloco, regras de validade, rotas, WebSocket e o que
  foi verificado.
- [docs/containers.md](docs/containers.md): imagens, rede, portas, volume, privilégios e
  provisionamento.
