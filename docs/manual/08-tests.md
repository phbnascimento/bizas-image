# 8. Testes

Este capítulo lista os testes automáticos do projeto: o que cada um confere, como rodá-lo e o resultado
obtido. As saídas citadas são
da execução de 23/11/2026 na máquina de referência do capítulo 2, com o código da versão 0.4a.

Uma conferência só merece confiança depois de ser **sabotada**, ou seja, depois de se ver que ela reprova
quando o que ela confere está errado. A seção 8.9 lista as sabotagens feitas.

## 8.1 Como rodar

```sh
cd application && go test ./... && cd ..                  # testes Go: bloco, cadeia, validator, server, página embutida
deno test --allow-read application/server/bizas.test.js   # o JavaScript da página contra o vetor do Go
scripts/e2e/browser.sh                                    # ponta a ponta: dois "aparelhos" no Firefox, pela rede local
scripts/containers-build.sh amd64 && scripts/containers-test.sh amd64   # containers nativos no PC
scripts/containers-build.sh arm64 && scripts/containers-test.sh arm64   # containers arm64, sob qemu
scripts/configure-buildroot.sh                            # configuração do Buildroot
scripts/check-image.sh                                    # a imagem pronta
```

O `containers-test.sh` recusa rodar se já existir container, rede ou volume do Bizas, para não apagar nada
que não tenha criado, e remove ao sair tudo o que criou. Em arm64, os containers rodam sob emulação: o
funcionamento vale, o tempo não.

## 8.2 Funcional

| Caso                      | O que conferir                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Como                                                                                                                                                         | Resultado             |
|---------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------|
| Formato do bloco          | 512 bytes little-endian; os mesmos bytes e a mesma assinatura no Go e no JavaScript                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `TestVector`, `TestBlockSize`, `TestVerifiesVectorBlocks` (Go) e os testes de vetor do `bizas.test.js` (Deno), sobre `application/bizas/testdata/vector.txt` | passou                |
| Regras de validação       | recusas `FRAUD`, `INVALID_LENGTH`, `INVALID_ROOM`, `NO_HASH_CONTINUITY`, `NO_TIMESTAMP_CONTINUITY`, `TIMESTAMP_IN_FUTURE`, `INSUFFICIENT_WORK`, `INVALID_WORK_BITS`, `INVALID_POLL`, `INVALID_VOTE`, `DUPLICATE_VOTE`                                                                                                                                                                                                                                                                                                                                                         | `TestRejections`, `TestSabotage`, `TestSabotageChain`, `TestGenesisMustHaveZeroPrev`, `TestFutureTimestampRejected`, `TestProofOfWork`, `TestPolls`          | passou                |
| Prova de trabalho         | o N vem do `info` do gênese (até 20); blocos minerados são aceitos; bloco ou gênese sem os bits zero recebe `INSUFFICIENT_WORK`; N acima de 20 recebe `INVALID_WORK_BITS`; o `validator verify` aplica a mesma regra; o Go e o JavaScript chegam ao mesmo `nonce` minerando a cadeia do vetor; a mineração assíncrona da página dá o mesmo resultado da síncrona e pode ser cancelada; a página só oferece o campo de N com a cadeia vazia e recusa valores fora de 0 a 20                                                                                                    | `TestProofOfWork`, `TestVector` (linha `nonces` do vetor), os testes de mineração do `bizas.test.js`, `scripts/e2e/browser.sh`                               | passou                |
| Enquetes                  | o formato de `POLL` e `VOTE`; as recusas `INVALID_POLL`, `INVALID_VOTE` e `DUPLICATE_VOTE`; a troca de opção numa enquete exclusiva em dois blocos; a enquete não exclusiva; um voto que falhou ao gravar fica fora da contagem; o estado refeito na partida; uma cadeia antiga com enquete malformada vai para a quarentena; os 24 casos do vetor dão o mesmo código no Go e no JavaScript; na página, o menu do "+", o painel de criação, as barras, a linha de cada voto, o texto em português e um voto repetido montado no teste de fraude recusado com `DUPLICATE_VOTE` | `TestPolls`, `TestOldChainWithMalformedPollQuarantined`, `TestVector` (linhas `case`), os testes de enquete do `bizas.test.js`, `scripts/e2e/browser.sh`     | passou                |
| Verificação por terceiros | `validator verify` aceita a cadeia exportada e aponta o bloco adulterado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `TestVerifyChain`, `TestFingerprint` e o fim do `browser.sh`                                                                                                 | passou                |
| Chat ponta a ponta        | dois aparelhos isolados no Firefox, com relógios de −3 h e +2 h, abrem a página pelo IP da rede local, fora de contexto seguro, trocam mensagens, inclusive duas ao mesmo tempo, e veem o mesmo histórico e a mesma impressão digital                                                                                                                                                                                                                                                                                                                                         | `scripts/e2e/browser.sh`                                                                                                                                     | passou (saída abaixo) |
| Teste de fraude da página | cada campo editado à mão produz a recusa esperada do validator real                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `scripts/e2e/browser.sh`                                                                                                                                     | passou                |
| Página                    | tela da chave, QR (lido de volta com `zbarimg`), painel da chave, painel do bloco ("ver", com os campos iguais aos do `/chain.json`), idioma, tema, mensagem em branco bloqueada                                                                                                                                                                                                                                                                                                                                                                                              | `scripts/e2e/browser.sh`, `TestPageFiles`, `TestVendoredHashes`, `TestLogoIsTheAsset`, `TestLogoColor`                                                       | passou                |
| Hora                      | `set-date` e `set-auto-date` mudam a hora mostrada; os carimbos assinados não mudam                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `TestParseSetDate`, `TestParseSetDateArgs`, `TestSetDateCalibration`, `TestQuerySNTP`, `TestAutoDateNoNetworkMessage`, `browser.sh` e `containers-test.sh`   | passou                |

Resumo das execuções:

```text
ok   github.com/phbnascimento/bizas-image/application/bizas   0.776s
ok   github.com/phbnascimento/bizas-image/application/server  0.339s
(46 testes Go)

ok | 15 passed | 0 failed (4s)                                 # Deno
```

Trecho da saída do `scripts/e2e/browser.sh`, com N = 4 escolhido no gênese:

```text
== page at http://192.168.15.12:15000
device clocks: A -3 h, B +2 h
isSecureContext=false on both devices
zero bits per block: 9 5 6 8
block panel: fields of block 1 match /chain.json
A: [ "Hello from A", "<b>hi</b> from B", "race A", "race B" ]
B: [ "Hello from A", "<b>hi</b> from B", "race A", "race B" ]
fingerprint A: 00949bb5314d1b86 B: 00949bb5314d1b86
fraud: stamp before the previous block -> Rejected: NO_TIMESTAMP_CONTINUITY
fraud: another room (text) -> Rejected: INVALID_ROOM
fraud: wrong prev -> Rejected: NO_HASH_CONTINUITY
fraud: length above the limit -> Rejected: INVALID_LENGTH
fraud: negative length -> Rejected: INVALID_LENGTH
fraud: edit without signing again -> Rejected: FRAUD
fraud: typed signature -> Rejected: FRAUD
fraud: impersonating another author -> Rejected: FRAUD
fraud: nonce 1 without proof of work -> Rejected: INSUFFICIENT_WORK
fraud: another room (bytes) -> Rejected: INVALID_ROOM
fraud: stamp typed as a UTC date -> Rejected: NO_TIMESTAMP_CONTINUITY
poll vote line: 79b5562e voted for “Pizza” in the poll at block 6 · “Where shall we eat?”
fraud: duplicate vote -> Rejected: DUPLICATE_VOTE
polls: [["Pizza","0 · 0%",false],["<b>Sushi</b>","1 · 100%",true],["Tacos","0 · 0%",false]] [["Red","1 · 50%",true],["Green","1 · 50%",true]]
== validator verify (exported chain, 7680 bytes)
valid: 15 blocks
fingerprint: #15 01b861262170682e
== fingerprint: page '#15 01b861262170682e', exported chain '#15 01b861262170682e'
== validator verify (byte 1224 sabotaged)
INVALID: FRAUD at block 2 (of 15)
E2E PASSED
```

O texto `<b>hi</b>` aparece literal nos dois aparelhos, e a opção `<b>Sushi</b>` da enquete também: a página insere o
conteúdo das mensagens e das enquetes como texto, nunca como HTML.

**A extensão de enquetes é um soft fork.** A cadeia exportada acima, com as duas enquetes e os votos, foi conferida
também com o `validator verify` da versão 0.3, anterior às enquetes. Depois, dois votos iguais da chave de B (Pizza,
na enquete do bloco 6) foram acrescentados ao fim dela, minerados com o mesmo N:

| cadeia                           | validator 0.3      | validator 0.4                                 |
|----------------------------------|--------------------|-----------------------------------------------|
| a exportada pelo E2E             | `valid: 15 blocks` | `valid: 15 blocks`                            |
| a mesma com os dois votos iguais | `valid: 17 blocks` | `INVALID: DUPLICATE_VOTE at block 16 (of 17)` |

## 8.3 Imagem e configuração

| Caso                      | O que conferir                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Como                                                          | Resultado                                                               |
|---------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------|-------------------------------------------------------------------------|
| Configuração do Buildroot | cada opção do fragmento e as selecionadas pelo `docker-engine` estão no `.config`; o defconfig gravado reproduz o mesmo `.config` do zero                                                                                                                                                                                                                                                                                                                                 | `scripts/configure-buildroot.sh`                              | `configuration OK: 42 lines in bizas_rpi4_defconfig; nothing was built` |
| Rootfs                    | hostname, hash SHA-256 crypt e senha do root e do `anon` (usuário sem privilégios, com home), `prompt.sh` igual ao overlay, o `/etc/issue` igual ao que o gerador faz da arte, da versão e dos integrantes (com os 4 RAs e a saudação da versão atual), `S99bizas` e comandos de `/usr/bin` iguais ao overlay e com modo 755, `S60dockerd` presente, só o `S99bizas` nas posições `S9x`, `/opt/bizas` com exatamente os 4 arquivos e os tars com o SHA-256 de `evidence/` | `scripts/check-image.sh`, lendo o `rootfs.ext4` com `debugfs` | passou                                                                  |
| Scripts de init           | `S99bizas`, `set-date`, `set-auto-date`, `reset-chat` e `provision.sh` passam pelo `sh -n` do BusyBox arm64 da própria imagem                                                                                                                                                                                                                                                                                                                                             | `scripts/check-image.sh`, via binfmt `qemu-aarch64`           | passou                                                                  |
| Partição de boot          | `config.txt` e `cmdline.txt` iguais aos do repositório; `Image`, `bcm2711-rpi-4-b.dtb`, `start4.elf` e `fixup4.dat` presentes                                                                                                                                                                                                                                                                                                                                             | `scripts/check-image.sh`, lendo o `boot.vfat` com `mtools`    | passou                                                                  |
| Kernel                    | cada opção do `docker.fragment` está `=y` ou `=m`; nenhum item obrigatório do `check-config.sh` do Docker falta                                                                                                                                                                                                                                                                                                                                                           | `scripts/check-image.sh`                                      | passou                                                                  |

Resultado do `check-image.sh`: 85 conferências `ok`, nenhuma `FAIL`, `IMAGE CHECK PASSED`.

**Build do zero.** Os passos da seção 2.4 foram seguidos num container Debian 13 limpo (só os pacotes da seção 2.2,
mais `docker-cli` e `docker-buildx`), a partir de um clone novo da tag `0.4`, com o kernel e o daemon do Docker do PC:

| Passo                       | Tempo   |
|-----------------------------|--------:|
| `fetch-buildroot.sh`        | 19 s    |
| `configure-buildroot.sh`    | 18 s    |
| `containers-build.sh arm64` | 3 s     |
| `build-image.sh`            | 1 858 s |
| `check-image.sh` (85 `ok`)  | 1 s     |

O Docker do PC já tinha a imagem `golang` e as camadas no cache, então o `containers-build.sh` não parte de um cache
vazio. A máquina tem 20 threads e 15 GB de RAM. A lista de arquivos do rootfs é a mesma da árvore de trabalho
(2 155 arquivos); 47 deles têm conteúdo diferente: o BusyBox, as ferramentas do util-linux, o `xz`, o `runc`, os dois
tars dos containers, o `/etc/shadow` (o hash leva sal) e o `configs.ko.xz`. `/etc/issue`, `/etc/passwd` e o
`prompt.sh` são iguais. O build do zero não cabe num `/tmp` em tmpfs de 7,7 GB: a primeira tentativa, ali, parou com
`no space left on device` no `host-go`.

## 8.4 Containers

| Caso            | O que conferir                                                                                                                                                                 | Como                                                                                    | Resultado         |
|-----------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|-------------------|
| Provisionamento | `provision.sh` carrega as imagens dos tars (as imagens locais são apagadas antes), cria rede, volume e containers                                                              | `scripts/containers-test.sh`                                                            | passou            |
| Idempotência    | rodar o `provision.sh` de novo não recria os containers (mesmo ID)                                                                                                             | `scripts/containers-test.sh`                                                            | passou            |
| Saúde           | os dois ficam `healthy` em até 60 s                                                                                                                                            | `scripts/containers-test.sh`                                                            | passou            |
| Arquitetura     | a imagem carregada é da arquitetura pedida                                                                                                                                     | `docker inspect` no `containers-test.sh`; `check-image-tar.py` no `containers-build.sh` | `arm64` e `amd64` |
| Privilégios     | usuário `65532:65532`, rootfs somente leitura, `--cap-drop ALL` sem capability acrescentada, `no-new-privileges`, não privilegiado, `restart unless-stopped`, rede `bizas-net` | `docker inspect` no `containers-test.sh`                                                | passou nos dois   |
| Volume          | só o validator monta volume (`bizas-data` em `/data`); o dono de `/data` no volume novo é `65532:65532`                                                                        | `scripts/containers-test.sh`                                                            | passou            |

Os dois `containers-test.sh` (amd64 e arm64) terminaram com 57 conferências `ok` cada e
`CONTAINERS PASSED`. Cada um roda também o `browser.sh` inteiro contra os containers.

## 8.5 Rede

| Caso                     | O que conferir                                                                                                      | Como                                                   | Resultado           |
|--------------------------|---------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------|---------------------|
| Porta publicada          | só o server publica porta (5000 do container numa porta do host); o validator não publica nenhuma                   | `docker inspect` no `containers-test.sh`               | passou              |
| Validator fora do host   | nada responde em `127.0.0.1:8081` no host                                                                           | `curl` no `containers-test.sh`                         | passou              |
| Acesso pela rede local   | a página funciona aberta pelo IP da rede local, fora de contexto seguro (`isSecureContext=false`), como num celular | `scripts/e2e/browser.sh`                               | passou              |
| Origem                   | WebSocket com `Origin` diferente do `Host` é recusado com 403                                                       | `TestForeignOriginRefused`                             | passou              |
| Entrada inválida         | frame acima do limite fecha a conexão (`StatusMessageTooBig`); frame de tamanho errado recebe `INVALID_SIZE`        | `TestOversizedFrameClosesConnection`, `TestWrongFrame` | passou              |
| Porta de manutenção      | o server se recusa a iniciar se `ADMIN_ADDR` não for loopback                                                       | `requireLoopback` em `application/server/main.go`      | conferido no código |
| `set-auto-date` sem rede | sai com código 1 e uma mensagem em inglês que sugere o `set-date`                                                   | `TestAutoDateNoNetworkMessage` e `containers-test.sh`  | passou              |

## 8.6 Reinício de containers

| Caso                       | O que conferir                                                           | Como                                                                | Resultado |
|----------------------------|--------------------------------------------------------------------------|---------------------------------------------------------------------|-----------|
| Validator cai              | com o validator parado, o `/health` do server responde 503               | `docker stop` no `containers-test.sh`; `TestHealthFollowsValidator` | passou    |
| Validator volta            | depois de `docker start`, o `/health` volta a 200 sem reiniciar o server | `containers-test.sh`                                                | passou    |
| Envio com o validator fora | o navegador recebe `VALIDATOR_UNAVAILABLE`                               | `TestValidatorDownOnSubmit`                                         | passou    |
| Política de reinício       | os dois containers têm `restart unless-stopped`                          | `docker inspect` no `containers-test.sh`                            | passou    |

## 8.7 Persistência

| Caso                                | O que conferir                                                                                                                        | Como                                                                  | Resultado |
|-------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------|-----------|
| Reabrir a cadeia                    | o arquivo é a própria cadeia exportável e, reaberto, continua aceitando blocos                                                        | `TestPersistAndReopen`                                                | passou    |
| Reiniciar o validator               | a cadeia exportada antes e depois do `docker restart` tem o mesmo SHA-256 (3072 bytes, 6 blocos)                                      | `containers-test.sh`                                                  | passou    |
| Relógio atrasado depois do reinício | com o relógio da placa atrás do último carimbo, o validator aceita o histórico e as mensagens seguintes continuam depois das gravadas | `TestRebootWithClockBehind`, `TestRunStartAfterRebootWithClockBehind` | passou    |

## 8.8 Perda de energia

O validator só responde 200 a um bloco depois de gravá-lo e fazer `fsync` (`Append` em
`application/bizas/chain.go`). Na partida, ele confere o arquivo antes de escutar. Os testes reproduzem o
estado em que uma queda de energia deixaria o arquivo:

| Caso                     | Estado simulado                          | Comportamento esperado                                                                                                                                                                                                                                                                                                | Como                                                                                                                       | Resultado                                          |
|--------------------------|------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------|
| Escrita interrompida     | 300 bytes soltos no fim de `chain.bin`   | o pedaço incompleto é descartado, o arquivo volta a um múltiplo de 512 bytes e o validator registra `dropped an incomplete block at the end of the chain`                                                                                                                                                             | `TestIncompleteTailDropped`; no `containers-test.sh`, os bytes são acrescentados ao volume real e o validator é reiniciado | passou: 3372 → 3072 bytes, mesmo SHA-256 da cadeia |
| Bloco inteiro danificado | um byte trocado dentro do bloco 1 de 3   | o prefixo válido (bloco 0) fica; o resto vai, byte a byte, para `chain.bin.quarantine-<ns>`; nada é apagado                                                                                                                                                                                                           | `TestCorruptBlockQuarantined`                                                                                              | passou                                             |
| Chat novo                | `reset-chat --yes` com 6 blocos gravados | a cadeia vai inteira para `chain.bin.reset-<ns>` e passa no `validator verify`; a `/chain` volta vazia e o validator aceita um gênese novo; com a cadeia vazia, nada é arquivado; um arquivo `reset` que já existe nunca é sobrescrito; sem terminal e sem `--yes`, o comando recusa com código 2 e a cadeia não muda | `TestArchiveChain`; no `containers-test.sh`, o `reset-chat` da placa contra os containers                                  | passou                                             |
| Falha de escrita         | arquivo aberto só para leitura           | o bloco é recusado com 500 `STORAGE_ERROR`, e nem a memória nem o arquivo mudam                                                                                                                                                                                                                                       | `TestStorageErrorLeavesChainUnchanged`                                                                                     | passou                                             |

No provisionamento, a marca `/var/lib/bizas/provisioned` só é gravada depois que os dois containers estão
rodando, seguida de `sync`. Uma queda no meio do `docker load` deixa a marca ausente, e o boot seguinte
provisiona de novo; o `provision.sh` é idempotente (seção 8.4).

## 8.9 Sabotagens

| Conferência                                    | Sabotagem                                                                                                                                                                                    | Resultado                                                                                                                                                                                                                                                                                      |
|------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Assinatura do bloco                            | um byte do `data`, um byte depois do `length`, o `nonce`, um byte do `author`                                                                                                                | `FRAUD` no bloco certo (`TestSabotage`)                                                                                                                                                                                                                                                        |
| Limites do `length`                            | `length` acima do máximo e negativo                                                                                                                                                          | `INVALID_LENGTH` (`TestSabotage`)                                                                                                                                                                                                                                                              |
| Encadeamento                                   | bloco reassinado com `prev` trocado, sala trocada, carimbo voltando no tempo                                                                                                                 | `NO_HASH_CONTINUITY`, `INVALID_ROOM`, `NO_TIMESTAMP_CONTINUITY` (`TestSabotageChain`)                                                                                                                                                                                                          |
| Assinatura no JavaScript                       | um byte trocado no bloco                                                                                                                                                                     | a verificação falha (`bizas.test.js`)                                                                                                                                                                                                                                                          |
| `validator verify`                             | byte 1224 (bloco 2) da cadeia exportada trocado                                                                                                                                              | `INVALID: FRAUD at block 2 (of 15)` (`browser.sh`, toda execução)                                                                                                                                                                                                                               |
| Hashes dos tars na imagem                      | primeiro dígito do SHA-256 do validator trocado em `evidence/hashes-containers.txt`                                                                                                          | `FAIL  bizas-validator tar sha256 b38cf143…, evidence 038cf143…` e `IMAGE CHECK FAILED: 1 failure(s)`                                                                                                                                                                                          |
| Opções do Buildroot                            | três opções acrescentadas ao fragmento: dois símbolos inexistentes e `BR2_PACKAGE_SYSTEMD=y`, que depende do init systemd                                                                    | `missing in .config` para as três e `ERROR: options above were dropped by kconfig`                                                                                                                                                                                                             |
| Prova de trabalho no Go                        | `HasWork` sempre verdadeiro; sem o limite de 20 bits; `Append` e `ChainVerify` ignorando o trabalho dos blocos depois do gênese                                                              | `TestVector` (os nonces deixam de bater) e `TestProofOfWork` reprovaram                                                                                                                                                                                                                        |
| Prova de trabalho na página                    | o envio normal sem minerar; o teste de fraude enviando sem minerar                                                                                                                           | o `browser.sh` reprovou: no primeiro caso, com o N da sala errado no cabeçalho; no segundo, com `INSUFFICIENT_WORK` onde se esperava `TIMESTAMP_IN_FUTURE`                                                                                                                                     |
| `integrity` do tweetnacl e do qrcode-generator | um byte acrescentado ao pacote baixado (`SABOTAGE_TGZ=1`)                                                                                                                                    | `ERROR: integrity mismatch`, nos dois scripts, sem tocar no arquivo embutido                                                                                                                                                                                                                   |
| `reset-chat`                                   | `ArchiveChain` devolvendo sucesso sem arquivar; o script sem exigir terminal ou `--yes`                                                                                                      | `TestArchiveChain` reprovou; o script, rodado sem terminal com um `docker` falso, saiu com código 1 em vez do 2 que o `containers-test.sh` exige, sem chamar o `docker`                                                                                                                        |
| Enquetes no Go                                 | o `Append` sem as regras de enquete; o `ChainVerify` sem elas; a regra de exclusividade tirada                                                                                               | `TestPolls` reprovou nos três; `TestOldChainWithMalformedPollQuarantined` no segundo; `TestVector` no terceiro (o código do caso `vote_exclusive_second_option` deixa de bater)                                                                                                                |
| Usuário `anon` e prompt                        | o `prompt.sh` do overlay diferente do da imagem; a senha do `anon` errada na tabela, com a imagem refeita; a tabela sem o `anon`, com a imagem refeita                                       | `check-image.sh` reprovou: `/etc/profile.d/prompt.sh differs from the overlay or is missing`; `anon password hash does not match bizasprotocol`; `user anon in /etc/passwd: 'missing'` e mais duas falhas                                                                                      |
| BusyBox arm64 que não roda                     | o `bin/busybox` do rootfs sem permissão de execução, num container                                                                                                                           | `check-image.sh` reprovou: `cannot run the arm64 BusyBox (missing …/bin/busybox); qemu-aarch64 has to be registered in the kernel (binfmt_misc)`                                                                                                                                               |
| Boas-vindas do console                         | um RA errado no gerador; a versão do `version.env` subida sem refazer a imagem; as cores tiradas do gerador; a arte sem dobrar os `\` e os `%`, rodada no `getty` do BusyBox arm64 da imagem | `check-image.sh` reprovou: `/etc/issue differs from the welcome banner` nos dois primeiros, e `/etc/issue does not greet with the current version` no segundo, e as três conferências de cor (magenta, amarelo e reset) nas cores tiradas; no `getty`, a arte sem dobrar perde o `%` e a barra |
| Painel do bloco                                | o painel mostrando o bloco anterior ao clicado                                                                                                                                               | o `browser.sh` reprovou: `block panel stamp: 1795473828559295285 != 1795473828705026659`                                                                                                                                                                                                       |
| Enquetes no JavaScript                         | o `poll.js` sem a regra de exclusividade; aceitando opção repetida; a página sem contar os votos                                                                                             | `bizas.test.js`: `vote_exclusive_second_option: js NONE, Go DUPLICATE_VOTE` e `poll_duplicate_option: js NONE, Go INVALID_POLL`; o `browser.sh` parou em `poll after two votes`, com as barras zeradas                                                                                         |

As seis sabotagens da linha do `validator verify` à do `integrity` foram executadas em 23/11/2026, com o repositório
restaurado em seguida: o `git status` ficou limpo e o `configure-buildroot.sh` voltou a `configuration OK`. A
sabotagem do `reset-chat`, as das enquetes, a do painel do bloco e as do `anon`, do prompt e das boas-vindas também foram executadas em 23/11/2026, e cada
arquivo sabotado foi restaurado da cópia.

## 8.10 Script de medição do boot

O `scripts/measure-boot.sh` (capítulo 5, seção 5.6) foi exercitado no PC, com o `scripts/dev-server.sh` em outra porta
fazendo o papel da placa: o servidor sobe um tempo depois de o script começar a contar, como a placa depois de
energizada. Isso confere o comportamento do script, não o tempo de boot.

| Situação                                 | Resultado do script                                                                                   |
|------------------------------------------|-------------------------------------------------------------------------------------------------------|
| o servidor sobe 1 s depois do Enter      | `First 200 at 1.93 s → pass`, linha `pass` no CSV                                                     |
| o servidor sobe 17 s depois do Enter     | `First 200 at 17.17 s → FAIL`, linha `FAIL` no CSV                                                    |
| nada responde                            | `no answer within 60 s` e código de saída 2, linha `no-response` (60,04 s) no CSV                     |
| a URL já responde quando o script começa | `WARNING: … already answers. Is the board still on?` e código de saída 1, sem linha no CSV            |
| o CSV fica numa pasta que não existe     | a pasta é criada, e a linha é gravada (antes, o script parava com "Arquivo ou diretório inexistente") |

As duas respostas, `pass` e `FAIL`, saíram do mesmo script com a mesma regra de 15,0 s.
