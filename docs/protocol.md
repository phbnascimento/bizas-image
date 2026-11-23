# Protocolo do Bizas

Como o navegador, o `server` e o `validator` conversam. O código de referência é
[`application/bizas/block.go`](../application/bizas/block.go) (bloco),
[`application/bizas/chain.go`](../application/bizas/chain.go) (cadeia e API do validator),
[`application/server/server.go`](../application/server/server.go) e
[`application/server/static`](../application/server/static/) (página).

```
navegador ──HTTP/WebSocket──▶ server :5000 ──HTTP interno──▶ validator :8081
 (assina)                    (repassa, transmite)              (confere, guarda)
```

- **O navegador assina.** A chave privada é gerada e usada só nele (tweetnacl, Ed25519).
- **O server repassa.** Ele só confere se o frame tem 512 bytes; nunca decide se um bloco é válido.
- **O validator decide.** Ele é o único que acrescenta blocos à cadeia, e o server só transmite o que
  ele aceitou.

## 1. O bloco

Cada mensagem é um bloco de **512 bytes**, com inteiros em little-endian:

| offset | bytes | campo    | conteúdo                                                                                                |
|-------:|------:|----------|---------------------------------------------------------------------------------------------------------|
| 0      | 8     | `room`   | nome da sala, completado com zeros (padrão: `Bizas`)                                                    |
| 8      | 8     | `stamp`  | `int64`, nanossegundos desde 1970-01-01 UTC, no relógio do validator (seção 3)                          |
| 16     | 8     | `nonce`  | `uint64`, variado pela prova de trabalho até a assinatura ter os bits zero exigidos                     |
| 24     | 4     | `info`   | `uint32`; no gênese, o N da prova de trabalho (0 a 20); nos outros blocos, livre (0)                    |
| 28     | 2     | `type`   | `uint16`: 0 `TEXT`, 1 `MONO`, 2 `MONO_RLE`, 3 `COLORED`, 4 `COLORED_RLE`, 5 `NETWORK_ACTION`, 6 `OTHER` |
| 30     | 2     | `length` | `int16`, bytes usados de `data` (0 a 320)                                                               |
| 32     | 32    | `author` | chave pública Ed25519 de quem assinou                                                                   |
| 64     | 64    | `sig`    | assinatura Ed25519                                                                                      |
| 128    | 64    | `prev`   | `sig` do bloco anterior (zeros no primeiro bloco)                                                       |
| 192    | 320   | `data`   | conteúdo; texto em UTF-8, resto zerado                                                                  |

- **O que se assina:** os 512 bytes com `sig` zerado. Isso inclui os bytes de `data` além de
  `length`.
- **O encadeamento:** é feito pelo campo `prev`, que guarda a **assinatura** do bloco anterior. Não há
  hash separado. Como a assinatura cobre o bloco inteiro, inclusive o `prev` dele, alterar qualquer
  bloco antigo quebra o encadeamento de todos os seguintes.
- **Limite do texto:** são 320 **bytes** UTF-8, não 320 caracteres. "Olá" tem 3 caracteres e 4 bytes.

### Prova de trabalho

Quem cria o gênese escolhe **N**, a quantidade de bits zero que toda assinatura da cadeia precisa ter no começo, e o
grava no `info` do gênese. A página sugere 10, e o máximo é 20 (`MaxWorkBits`). Os bits contam do mais alto do
primeiro byte da `sig` em diante: com N = 10, o primeiro byte é `00` e o segundo fica abaixo de `40`.

A regra vale para todos os blocos, inclusive o gênese. Como a assinatura Ed25519 é determinística, o único jeito de
mudá-la sem mudar a mensagem é o `nonce`: quem envia assina, confere os bits e, se faltarem, soma 1 ao `nonce` e
assina de novo. Cada bit a mais dobra o número médio de tentativas: com N = 10, são em média 1024 assinaturas por
mensagem. A página faz essa busca no próprio navegador, num único núcleo, em fatias curtas para a tela continuar
respondendo, e mostra o número de tentativas abaixo da barra de mensagem.

Com N = 0, nenhum bit é exigido. Uma cadeia cujo gênese tem `info` 0 não precisa de prova de trabalho.

### Regras de validade

Um bloco isolado é válido quando:
- `0 ≤ length ≤ 320`;
- a assinatura confere com `author`.

Um bloco novo entra na cadeia quando, além disso:
- **com a cadeia vazia (gênese):** `prev` é todo zero, e `info` (o N) vai de 0 a 20. Quem envia o primeiro bloco
  define a sala e o N.
- **com a cadeia não vazia:** comparado com a cabeça (último bloco aceito),
  - `room` é igual;
  - `stamp` é maior ou igual;
  - `prev` é igual à `sig` da cabeça.
- **em qualquer caso:** a `sig` começa com N bits zero, sendo N o `info` do gênese;
- **em qualquer caso:** `stamp` não está mais de 5 s à frente do relógio do validator (seção 3).

As regras acima, menos a última, são de **validade**: valem para qualquer cadeia e são o que o
`validator verify` confere. A última é uma regra de **aceitação** do validator, que só vale na hora de
receber um bloco novo, porque depende do relógio dele naquele instante.

Os nomes de erro vêm de `bizas.ValidationError`:

| erro                      | quando                                                                                   |
|---------------------------|------------------------------------------------------------------------------------------|
| `FRAUD`                   | a assinatura não confere                                                                 |
| `INVALID_LENGTH`          | `length` fora de 0 a 320                                                                 |
| `INVALID_ROOM`            | sala diferente da cabeça                                                                 |
| `NO_TIMESTAMP_CONTINUITY` | `stamp` menor que o da cabeça                                                            |
| `NO_HASH_CONTINUITY`      | `prev` diferente da `sig` da cabeça, ou uma gênese com `prev` não zerado                 |
| `TIMESTAMP_IN_FUTURE`     | `stamp` mais de 5 s à frente do relógio do validator (só na aceitação)                   |
| `INSUFFICIENT_WORK`       | a `sig` não começa com os N bits zero que o gênese pede                                  |
| `INVALID_WORK_BITS`       | o gênese pede mais que 20 bits zero no `info`                                            |
| `CORRUPTED_TIMESTAMP`     | existe no código, mas hoje nunca ocorre: todo `int64` em nanossegundos é uma data válida |

## 2. Rotas públicas do server (porta 5000; 80 no host)

| rota          | resposta                                                                                                                                       |
|---------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| `GET /`       | a página (`index.html`, `style.css`, `app.js`, `bizas.js`, `when.js`, `nacl-fast.min.js`), embutida no binário com `go:embed`; nada vem de CDN |
| `GET /health` | `200 ok` só se o `/health` do validator também responder 200; senão `503`                                                                      |
| `GET /chain`  | a cadeia inteira, com os blocos de 512 bytes concatenados (`application/octet-stream`), para exportar e verificar fora da Pi                   |
| `GET /ws`     | WebSocket do chat (seção 3)                                                                                                                    |

**Porta de manutenção do server:** `ADMIN_ADDR`, padrão `127.0.0.1:5001`, só no loopback **de dentro do
container**. Ela não é publicada no host, e o server se recusa a iniciar se `ADMIN_ADDR` não for um
endereço de loopback. Tem uma rota:

- **`POST /clock`:** recebe no corpo a hora real em ns (string decimal). Calcula
  `real_offset = hora real − relógio do validator`, guarda **só em memória** e manda o aviso `time` a
  todas as páginas abertas. A calibração vale só para a execução atual do validator: se o `run_start`
  dele mudar, ela é descartada.

Quem chama essa rota são os comandos de manutenção, rodados como root no console da placa:

| comando                                    | o que faz                                                                                                                                                         |
|--------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `set-date AAAA-MM-DD-hh-mm-ss [--tz FUSO]` | informa a hora real. Sem `--tz`, a hora digitada é em UTC; `--tz -03:00` (ou `--tz=-03:00`, `+05:30`, `Z`) diz em que fuso ela foi digitada                       |
| `set-auto-date`                            | consulta a hora por SNTP (`pool.ntp.org`, `time.google.com`, `time.cloudflare.com`) pela rede conectada e a informa; sem rede, sai com erro e sugere o `set-date` |

Os dois são scripts em `/usr/bin` que repassam o pedido ao container (`docker exec bizas-server /app
set-date …`). Nenhum deles mexe no relógio da placa.

## 3. WebSocket `/ws`

O server recusa a conexão quando o `Origin` é diferente do `Host`; esse é o padrão do
`coder/websocket`.

### Do server para o navegador

- **Frame binário:** um ou mais blocos de 512 bytes concatenados. O **primeiro** frame binário depois
  de conectar é sempre o histórico completo, que pode vir vazio (0 bytes). Os seguintes trazem um
  bloco cada um, recém-aceito pelo validator, na ordem da cadeia.
- **Frame de texto:** um aviso JSON. O primeiro, logo ao conectar e antes do histórico, é o relógio do
  validator. Os demais vão só a quem mandou um bloco recusado:

  ```json
  {"type": "time", "now": "1763600000000000000", "run_start": "1763590000000000000", "real_offset": "-2340000000"}
  {"type": "rejected", "error": "NO_HASH_CONTINUITY", "head": "<512 bytes em hex>"}
  {"type": "rejected", "error": "STORAGE_ERROR"}
  {"type": "error", "error": "INVALID_SIZE"}
  {"type": "error", "error": "VALIDATOR_UNAVAILABLE"}
  ```

  - Os valores do aviso `time` vêm em nanossegundos, como string decimal: passam de 2^53 e não cabem
    num número de JSON nem de JavaScript.
    - `now`: o relógio do validator, com o qual o navegador assina;
    - `run_start`: o início da execução atual do validator;
    - `real_offset`: hora real − hora da placa, informada pelo `set-date` ou pelo `set-auto-date`
      (seção 4). Fica ausente se ninguém a informou nesta execução do validator.
  - O aviso `time` também chega, sem reconectar, a todas as páginas abertas quando alguém roda o
    `set-date` ou o `set-auto-date`.
  - O campo `head` traz a cabeça atual da cadeia, quando o validator a envia.

### Do navegador para o server

- **Frame binário de exatamente 512 bytes:** um bloco assinado. Qualquer outro tamanho, ou um frame de
  texto, recebe `{"type":"error","error":"INVALID_SIZE"}`. Frames acima de 4096 bytes fecham a
  conexão.

### Ordem e confirmação

- **Ordem:** o server trata, um de cada vez, a entrada de um cliente (buscar o histórico e se
  inscrever) e cada envio (repassar ao validator e transmitir). Por isso todo cliente vê os blocos na
  ordem da cadeia, sem lacuna e sem repetição.
- **Confirmação:** quem enviou recebe o próprio bloco de volta, transmitido junto com os outros. Para
  o navegador, essa é a confirmação.
- **Cliente lento:** se a fila de saída de um cliente passar de 64 frames, ele é desconectado. Ao
  voltar, recebe o histórico de novo.

### Corrida entre aparelhos

Dois aparelhos que assinam sobre a mesma cabeça disputam a vez: o validator aceita o primeiro e recusa
o segundo com `NO_HASH_CONTINUITY` e a cabeça nova. O navegador recusado então:
1. encaixa a cabeça recebida na sua cópia local;
2. refaz o bloco sobre ela, faz a prova de trabalho de novo e reenvia, até 3 tentativas;
3. se a cabeça recebida não encaixa na cópia local, reconecta, recebe o histórico inteiro e reenvia a
   mensagem pendente que não estiver nele.

### Carimbo de tempo

**Quem fornece a hora é a placa.** O `stamp` entra nos bytes assinados, então é o navegador que o
grava, mas com o relógio do validator, e não com o do aparelho:

1. **Ao conectar:** o navegador recebe o aviso `time` e guarda a diferença entre esse relógio e o
   próprio.
2. **Ao assinar:** usa `max(relógio do validator, stamp_da_cabeça + 1)`. Um celular com o relógio
   errado não muda nada.
3. **Ao aceitar:** o validator recusa um `stamp` mais de 5 s à frente do próprio relógio
   (`TIMESTAMP_IN_FUTURE`).

- **Por que a regra existe (ataque de congelamento):** sem ela, um bloco datado, por exemplo, em 2100
  obrigaria todos os blocos seguintes a ter carimbo depois dele. O chat continuaria, mas toda mensagem
  dali em diante ficaria datada de 2100.
- **Validator reiniciado:** se o navegador receber `TIMESTAMP_IN_FUTURE`, a diferença de relógio que ele
  guardou ficou velha, por exemplo porque o validator reiniciou. Ele reconecta, recebe a hora de novo
  e reenvia.
- **Relógio do validator ("relógio efetivo"):** na partida, o validator parte de
  `max(relógio da placa, stamp da cabeça gravada)` e daí em diante conta o tempo decorrido. Se a placa
  acordar com o relógio atrás da última mensagem (sem RTC e sem internet, por exemplo), as mensagens
  novas continuam depois das gravadas, em vez de serem recusadas.
- **Consequência:** o `stamp` é a hora **da placa**. Ele garante a ordem, mas só é hora de calendário se
  o relógio da placa estiver certo. O tempo em que a placa ficou desligada não é contado.

### Hora mostrada na página

Como o `stamp` pode não ser hora de calendário, a página escolhe o que mostrar
([`when.js`](../application/server/static/when.js)):

| situação                                                               | a página mostra                                                                          |
|------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| mensagem da execução atual do validator, sem `set-date`                | a **idade** da mensagem ("just now", "5 min ago"), medida no relógio da placa            |
| mensagem da execução atual, depois de um `set-date` ou `set-auto-date` | **data e hora**: `stamp + real_offset`, no fuso do aparelho                              |
| mensagem anterior a `run_start`                                        | "earlier session": o tempo desligado não foi contado, então nenhuma hora seria confiável |

O texto é atualizado a cada 15 s. Os carimbos assinados nunca mudam: o `set-date` só muda a exibição.
### Conferência no navegador

O navegador confere de novo a assinatura e a prova de trabalho de cada bloco que recebe. Assim não precisa
confiar no server para isso.

Se a cabeça mudar enquanto a prova de trabalho roda (outro aparelho encadeou antes), a página abandona a busca e
recomeça sobre a cabeça nova, sem gastar uma das 3 tentativas.

## 4. API interna do validator (porta 8081, sem porta no host)

| rota           | resposta                                                                                   |
|----------------|--------------------------------------------------------------------------------------------|
| `GET /health`  | `200 ok`, só depois de a cadeia gravada ter sido carregada e revalidada                    |
| `GET /chain`   | os blocos de 512 bytes concatenados, com o relógio efetivo no cabeçalho `X-Bizas-Now` (ns) |
| `POST /blocks` | corpo de exatamente 512 bytes (`application/octet-stream`)                                 |

Respostas do `POST /blocks`:

| status | corpo                                             | quando                                                                       |
|--------|---------------------------------------------------|------------------------------------------------------------------------------|
| `200`  | vazio                                             | aceito, **gravado em disco** (`fsync`) e acrescentado                        |
| `409`  | `{"error": "<ValidationError>", "head": "<hex>"}` | recusado pelas regras da seção 1; `head` vem vazio se a cadeia estiver vazia |
| `500`  | `{"error": "STORAGE_ERROR"}`                      | o bloco era válido, mas a gravação falhou; a cadeia ficou como estava        |
| `400`  | `{"error": "INVALID_SIZE"}`                       | corpo menor que 512 bytes                                                    |
| `413`  | `{"error": "INVALID_SIZE"}`                       | corpo maior que 512 bytes                                                    |

O validator trata um bloco de cada vez, sob um lock, e confere o bloco novo contra a cabeça com o
mesmo `bizas.ChainVerify` coberto pelo vetor de teste.

### Persistência

A cadeia é gravada em `DATA_DIR/chain.bin` (padrão `/data/chain.bin`, no volume `bizas-data`). Nada além
da cadeia é guardado.

- **Formato:** os mesmos blocos de 512 bytes concatenados do `GET /chain`. O próprio arquivo pode ser
  conferido com `validator verify` e `validator fingerprint`.
- **Gravação:** cada bloco aceito é acrescentado ao arquivo e passa por `fsync` antes da resposta 200.
  O server só transmite o bloco depois disso, então "confirmado" significa "gravado". Se a gravação
  falhar, o pedaço escrito é desfeito e a resposta é `STORAGE_ERROR`.
- **Na partida:**
  - **Pedaço final incompleto** (tamanho que não é múltiplo de 512, como numa queda de energia no meio
    da escrita): é descartado e registrado no log. Esse bloco nunca tinha sido confirmado.
  - **O resto é revalidado** com `VerifyChain`, só pela validade, nunca pela regra do relógio. Com a
    placa acordando atrasada, a regra do relógio faria o validator recusar o próprio histórico.
  - **Bloco inteiro inválido no meio** (dano ou adulteração, não queda de energia): o prefixo válido
    continua, e o resto vai para `chain.bin.quarantine-<ns>`, ao lado. Nada é apagado.
- **Tempo de partida:** a revalidação lê a cadeia inteira, então cresce com o tamanho dela e fica no
  caminho do boot. São 512 bytes e uma verificação Ed25519 por mensagem.
- **Falha ao abrir o arquivo:** o validator sai com erro, em vez de seguir sem guardar.

## 5. Identidade e impressão digital no navegador

- **Chave:** um par Ed25519 derivado de uma seed de 32 bytes, que a pessoa gera com `nacl.randomBytes` (que
  usa `crypto.getRandomValues`) ou cola em hex na primeira sessão. A página mostra a chave pública e só grava a
  seed no `localStorage` (`bizas.seed`) depois da confirmação; até lá não conecta.
- **ID mostrado:** os 4 primeiros bytes da chave pública, em hex.
- **Impressão digital da cadeia:** a página mostra os 8 primeiros bytes (16 hex) da assinatura do último
  bloco, que também aparece por inteiro ao passar o mouse. Como cada assinatura cobre o `prev`, ela
  compromete todo o histórico até ali: mesma altura e mesma impressão digital significam o mesmo
  histórico. O `validator fingerprint chain.bin [altura]` calcula o mesmo valor sobre uma cadeia
  exportada, e recusa calcular sobre uma cadeia inválida. Go e JS são conferidos pelo vetor de teste
  (linha `fingerprint=`).
- **Limpar os dados do site** apaga a seed, e com ela a identidade.

## 6. O que garante e o que não garante

O protocolo garante a **validade** de uma cadeia, e não o **consenso** sobre qual cadeia vale.

**Validade (garantida).** Uma cadeia é válida quando todas as assinaturas conferem com os autores
declarados e todo `prev` aponta para o bloco anterior. Numa cadeia válida:

- **ninguém assina em nome de outra pessoa** sem a chave privada dela, nem o server, nem o validator;
- **ninguém altera o bloco de outra pessoa**: um byte alterado dá `FRAUD`;
- **ninguém insere, remove ou reordena blocos no meio**: o encadeamento quebra
  (`NO_HASH_CONTINUITY`).

Qualquer pessoa confere a validade com `validator verify chain.bin`, sem confiar na Pi. O comando
responde `valid: N blocks` (código de saída 0) ou `INVALID: <erro> at block <i> (of N)` (código de
saída 1).

**Consenso (fora do alcance do protocolo).** Duas cadeias podem ser ambas válidas e divergir a partir de
um bloco:

- uma pode ser o começo da outra (o fim foi cortado);
- a partir de certo ponto, uma pode seguir com blocos assinados por outra chave.

Nenhuma das duas falsifica a mensagem de ninguém. A validade não diz qual delas é a cadeia; isso é
consenso. Aqui o consenso é a autoridade única do validator da Pi: vale a cadeia que ele guarda. Quem quer
confirmar que uma cadeia é a mesma que acompanhou compara a impressão digital (seção 5) na altura que
viu.

Mais dois pontos:

- **Qualquer um pode criar a gênese** quando a cadeia está vazia.
- **É um log encadeado e assinado, verificável por terceiros, não uma blockchain descentralizada.**

## 7. Testes
- **Vetor de teste:** `application/bizas/testdata/vector.txt` tem a chave pública, os 512 bytes e as
  assinaturas de uma cadeia de dois blocos montada com seed e campos fixos. O teste Go confere que o
  código ainda produz exatamente esse arquivo (para regravá-lo depois de uma mudança intencional de
  formato: `go test ./bizas -run TestVector -update`).
- **JS da página igual ao Go:** o `bizas.js` da página reproduz o mesmo vetor byte a byte, rodando no
  Deno com o mesmo tweetnacl embutido (`deno test --allow-read application/server/bizas.test.js`).
- **Tweetnacl conferido:** ele é o 1.0.3 do registro do npm, com o `integrity` conferido por
  `scripts/fetch-tweetnacl.sh`, e um teste do Go confere o SHA-256 do arquivo embutido.
- **Teste de fraude na página:** opção das configurações que expõe os campos do bloco (menos o `data`) para edição
  manual e mostra o código de recusa do validator. O teste no navegador monta blocos editados e confere, contra o
  validator de verdade, `NO_TIMESTAMP_CONTINUITY`, `INVALID_ROOM`, `NO_HASH_CONTINUITY`, `INVALID_LENGTH` (acima do
  limite e negativo), `FRAUD` (sem assinar de novo, `sig` digitada, `author` trocado), `INSUFFICIENT_WORK` (`nonce`
  digitado, cuja assinatura não tem os bits zero) e `TIMESTAMP_IN_FUTURE`. Com "assinar automaticamente", o envio
  faz a prova de trabalho variando o `nonce`; um `nonce` ou uma `sig` digitados vão como estão.
  `CORRUPTED_TIMESTAMP` não é alcançável: todo `int64` é um carimbo válido (`IsTimestampValid`).
  Os modos de edição do `room` (texto ou hexadecimal) e do `stamp` (nanossegundos ou data UTC) e o congelamento do
  `stamp` também passam por esse teste, e o `fraud.js` tem testes próprios (`bizas.test.js`) para a conversão sem
  perda entre data e nanossegundos.
- **QR code conferido:** o `qrcode.js` (qrcode-generator 1.4.4, MIT) vem do registro do npm com o `integrity`
  conferido por `scripts/fetch-qrcode.sh`, e o mesmo teste do Go confere o SHA-256. O teste no navegador lê de
  volta, com o `zbarimg`, o QR code da chave privada (tela da chave) e o da chave pública (painel) e compara com
  a chave exibida.
- **Testes Go:** `go test -race ./...` em `application/`. Cobrem:
  - persistência: gravar e reabrir; pedaço final incompleto descartado; bloco corrompido no meio
    (prefixo mantido, resto na quarentena); falha de gravação (`STORAGE_ERROR`, nada muda);
  - relógio: carimbo além de 5 s recusado (inclusive o ano 2100); reboot com o relógio da placa em
    1970 carregando a cadeia gravada e aceitando a mensagem seguinte; `X-Bizas-Now` e
    `X-Bizas-Run-Start` no `/chain`;
  - hora mostrada: `set-date` lido no fuso certo e recusando formatos errados; SNTP contra um servidor
    local falso (resposta válida, de cliente, sem sincronia, curta ou ausente); a calibração chegando às
    páginas abertas e às novas, descartada quando o validator reinicia; a rota `/clock` inexistente na
    porta pública;
  - aceitação;
  - recusa por `prev` velho, com a cabeça devolvida;
  - frames de 511 e 513 bytes;
  - transmissão só do que foi aceito;
  - `Origin` estranho recusado com 403;
  - frame acima de 4096 bytes fechando a conexão com 1009;
  - `/health` com o validator fora do ar;
  - validator fora do ar durante um envio;
  - `validator verify` numa cadeia válida, numa adulterada e numa com gênese falsa.
- **Sabotagens:** cada conferência foi sabotada e reprovou. Os casos foram:
  - o server transmitindo o que foi recusado;
  - o validator aceitando sem conferir;
  - aceitar qualquer `Origin`;
  - tirar o limite de leitura;
  - um byte do tweetnacl alterado;
  - um offset errado no `bizas.js`;
  - um byte alterado no vetor de teste;
  - um byte alterado no pacote baixado do npm;
  - um `integrity` fixado errado;
  - persistência sem o descarte do pedaço final, sem a regra do carimbo no futuro, com o relógio só da
    placa (sem a cabeça como piso) e com a regra do relógio aplicada ao recarregar;
  - o navegador assinando com o próprio relógio (o aparelho adiantado é recusado);
  - a página ignorando a calibração do `set-date` (as datas não aparecem).
- **Ponta a ponta (`scripts/e2e/browser.sh`):** os binários reais rodando no PC, com a página aberta
  **pelo IP da LAN**, fora de contexto seguro (`isSecureContext === false`), como os celulares vão
  abri-la na Pi. São dois "aparelhos" isolados no Firefox 160 headless, controlados por WebDriver
  BiDi. Passaram:
  - mensagens indo e voltando;
  - texto com `<b>` aparecendo como texto;
  - um envio simultâneo resolvido pelo reenvio automático (o log do validator mostra uma recusa
    `NO_HASH_CONTINUITY` seguida do aceite);
  - a identidade mantida ao recarregar a página;
  - o botão desabilitado com 322 bytes;
  - a cadeia exportada aprovada pelo `validator verify`, e a mesma cadeia com um byte sabotado
    reprovada no bloco 2;
  - os dois aparelhos com o relógio desencontrado (um 3 h atrasado, outro 2 h adiantado), todas as
    mensagens aceitas;
  - a impressão digital igual nos dois aparelhos e na cadeia exportada;
  - as mensagens mostrando "just now"; depois do comando `set-date` de verdade, as duas páginas
    abertas mostrando a data informada sem recarregar, e mantendo-a depois de recarregar.
- **Containers (`scripts/containers-test.sh`):** reiniciar o validator mantém a cadeia; 300 bytes
  soltos no fim do `chain.bin`, como numa queda de energia, são descartados na partida, com registro
  no log. Os scripts `set-date` e `set-auto-date` da placa rodados contra os containers; o
  `set-auto-date` num container sem rede (`--network none`) sai com erro em inglês sugerindo o
  `set-date`.
