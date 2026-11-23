# 6. Testes

Este capítulo lista os testes automáticos do projeto: o que cada um confere, como rodá-lo e o resultado
obtido. As saídas citadas são
da execução de 23/11/2026 na máquina de referência do capítulo 2, com o código da versão 0.2.

Uma conferência só merece confiança depois de ser **sabotada**, ou seja, depois de se ver que ela reprova
quando o que ela confere está errado. A seção 6.9 lista as sabotagens feitas.

## 6.1 Como rodar

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

## 6.2 Funcional

| Caso                      | O que conferir                                                                                                                                                                                                                        | Como                                                                                                                                                         | Resultado             |
|---------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------|
| Formato do bloco          | 512 bytes little-endian; os mesmos bytes e a mesma assinatura no Go e no JavaScript                                                                                                                                                   | `TestVector`, `TestBlockSize`, `TestVerifiesVectorBlocks` (Go) e os testes de vetor do `bizas.test.js` (Deno), sobre `application/bizas/testdata/vector.txt` | passou                |
| Regras de validação       | recusas `FRAUD`, `INVALID_LENGTH`, `INVALID_ROOM`, `NO_HASH_CONTINUITY`, `NO_TIMESTAMP_CONTINUITY`, `TIMESTAMP_IN_FUTURE`                                                                                                             | `TestRejections`, `TestSabotage`, `TestSabotageChain`, `TestGenesisMustHaveZeroPrev`, `TestFutureTimestampRejected`                                          | passou                |
| Verificação por terceiros | `validator verify` aceita a cadeia exportada e aponta o bloco adulterado                                                                                                                                                              | `TestVerifyChain`, `TestFingerprint` e o fim do `browser.sh`                                                                                                 | passou                |
| Chat ponta a ponta        | dois aparelhos isolados no Firefox, com relógios de −3 h e +2 h, abrem a página pelo IP da rede local, fora de contexto seguro, trocam mensagens, inclusive duas ao mesmo tempo, e veem o mesmo histórico e a mesma impressão digital | `scripts/e2e/browser.sh`                                                                                                                                     | passou (saída abaixo) |
| Teste de fraude da página | cada campo editado à mão produz a recusa esperada do validator real                                                                                                                                                                   | `scripts/e2e/browser.sh`                                                                                                                                     | passou                |
| Página                    | tela da chave, QR (lido de volta com `zbarimg`), painel, idioma, tema, mensagem em branco bloqueada                                                                                                                                   | `scripts/e2e/browser.sh`, `TestPageFiles`, `TestVendoredHashes`, `TestLogoIsTheAsset`, `TestLogoColor`                                                       | passou                |
| Hora                      | `set-date` e `set-auto-date` mudam a hora mostrada; os carimbos assinados não mudam                                                                                                                                                   | `TestParseSetDate`, `TestParseSetDateArgs`, `TestSetDateCalibration`, `TestQuerySNTP`, `TestAutoDateNoNetworkMessage`, `browser.sh` e `containers-test.sh`   | passou                |

Resumo das execuções:

```text
ok   github.com/phbnascimento/bizas-image/application/bizas   0.538s
ok   github.com/phbnascimento/bizas-image/application/server  0.366s
(42 testes Go)

ok | 10 passed | 0 failed (282ms)                              # Deno
```

Trecho da saída do `scripts/e2e/browser.sh`:

```text
== page at http://192.168.15.12:15000
device clocks: A -3 h, B +2 h
isSecureContext=false on both devices
A: [ "Hello from A", "<b>hi</b> from B", "race A", "race B" ]
B: [ "Hello from A", "<b>hi</b> from B", "race A", "race B" ]
fingerprint A: 60faea6477871a6e B: 60faea6477871a6e
fraud: stamp before the previous block -> Rejected: NO_TIMESTAMP_CONTINUITY
fraud: another room (text) -> Rejected: INVALID_ROOM
fraud: wrong prev -> Rejected: NO_HASH_CONTINUITY
fraud: length above the limit -> Rejected: INVALID_LENGTH
fraud: negative length -> Rejected: INVALID_LENGTH
fraud: edit without signing again -> Rejected: FRAUD
fraud: typed signature -> Rejected: FRAUD
fraud: impersonating another author -> Rejected: FRAUD
fraud: another room (bytes) -> Rejected: INVALID_ROOM
fraud: stamp typed as a UTC date -> Rejected: NO_TIMESTAMP_CONTINUITY
== validator verify (exported chain, 3072 bytes)
valid: 6 blocks
fingerprint: #6 d8b4629951e3d96a
== fingerprint: page '#6 d8b4629951e3d96a', exported chain '#6 d8b4629951e3d96a'
== validator verify (byte 1224 sabotaged)
INVALID: FRAUD at block 2 (of 6)
E2E PASSED
```

O texto `<b>hi</b>` aparece literal nos dois aparelhos: a página insere o conteúdo das mensagens como texto,
nunca como HTML.

## 6.3 Imagem e configuração

| Caso                      | O que conferir                                                                                                                                                                                                                                                  | Como                                                          | Resultado                                                               |
|---------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------|-------------------------------------------------------------------------|
| Configuração do Buildroot | cada opção do fragmento e as selecionadas pelo `docker-engine` estão no `.config`; o defconfig gravado reproduz o mesmo `.config` do zero                                                                                                                       | `scripts/configure-buildroot.sh`                              | `configuration OK: 41 lines in bizas_rpi4_defconfig; nothing was built` |
| Rootfs                    | hostname, hash SHA-256 crypt e senha do root, `S99bizas` e comandos de `/usr/bin` iguais ao overlay e com modo 755, `S60dockerd` presente, só o `S99bizas` nas posições `S9x`, `/opt/bizas` com exatamente os 4 arquivos e os tars com o SHA-256 de `evidence/` | `scripts/check-image.sh`, lendo o `rootfs.ext4` com `debugfs` | passou                                                                  |
| Scripts de init           | `S99bizas`, `set-date`, `set-auto-date` e `provision.sh` passam pelo `sh -n` do BusyBox arm64 da própria imagem                                                                                                                                                 | `scripts/check-image.sh`, via binfmt `qemu-aarch64`           | passou                                                                  |
| Partição de boot          | `config.txt` e `cmdline.txt` iguais aos do repositório; `Image`, `bcm2711-rpi-4-b.dtb`, `start4.elf` e `fixup4.dat` presentes                                                                                                                                   | `scripts/check-image.sh`, lendo o `boot.vfat` com `mtools`    | passou                                                                  |
| Kernel                    | cada opção do `docker.fragment` está `=y` ou `=m`; nenhum item obrigatório do `check-config.sh` do Docker falta                                                                                                                                                 | `scripts/check-image.sh`                                      | passou                                                                  |

Resultado do `check-image.sh`: 69 conferências `ok`, nenhuma `FAIL`, `IMAGE CHECK PASSED`.

## 6.4 Containers

| Caso            | O que conferir                                                                                                                                                                 | Como                                                                                    | Resultado         |
|-----------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|-------------------|
| Provisionamento | `provision.sh` carrega as imagens dos tars (as imagens locais são apagadas antes), cria rede, volume e containers                                                              | `scripts/containers-test.sh`                                                            | passou            |
| Idempotência    | rodar o `provision.sh` de novo não recria os containers (mesmo ID)                                                                                                             | `scripts/containers-test.sh`                                                            | passou            |
| Saúde           | os dois ficam `healthy` em até 60 s                                                                                                                                            | `scripts/containers-test.sh`                                                            | passou            |
| Arquitetura     | a imagem carregada é da arquitetura pedida                                                                                                                                     | `docker inspect` no `containers-test.sh`; `check-image-tar.py` no `containers-build.sh` | `arm64` e `amd64` |
| Privilégios     | usuário `65532:65532`, rootfs somente leitura, `--cap-drop ALL` sem capability acrescentada, `no-new-privileges`, não privilegiado, `restart unless-stopped`, rede `bizas-net` | `docker inspect` no `containers-test.sh`                                                | passou nos dois   |
| Volume          | só o validator monta volume (`bizas-data` em `/data`); o dono de `/data` no volume novo é `65532:65532`                                                                        | `scripts/containers-test.sh`                                                            | passou            |

Os dois `containers-test.sh` (amd64 e arm64) terminaram com 47 conferências `ok` cada e
`CONTAINERS PASSED`. Cada um roda também o `browser.sh` inteiro contra os containers.

## 6.5 Rede

| Caso                     | O que conferir                                                                                                      | Como                                                   | Resultado           |
|--------------------------|---------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------|---------------------|
| Porta publicada          | só o server publica porta (5000 do container numa porta do host); o validator não publica nenhuma                   | `docker inspect` no `containers-test.sh`               | passou              |
| Validator fora do host   | nada responde em `127.0.0.1:8081` no host                                                                           | `curl` no `containers-test.sh`                         | passou              |
| Acesso pela rede local   | a página funciona aberta pelo IP da rede local, fora de contexto seguro (`isSecureContext=false`), como num celular | `scripts/e2e/browser.sh`                               | passou              |
| Origem                   | WebSocket com `Origin` diferente do `Host` é recusado com 403                                                       | `TestForeignOriginRefused`                             | passou              |
| Entrada inválida         | frame acima do limite fecha a conexão (`StatusMessageTooBig`); frame de tamanho errado recebe `INVALID_SIZE`        | `TestOversizedFrameClosesConnection`, `TestWrongFrame` | passou              |
| Porta de manutenção      | o server se recusa a iniciar se `ADMIN_ADDR` não for loopback                                                       | `requireLoopback` em `application/server/main.go`      | conferido no código |
| `set-auto-date` sem rede | sai com código 1 e uma mensagem em inglês que sugere o `set-date`                                                   | `TestAutoDateNoNetworkMessage` e `containers-test.sh`  | passou              |

## 6.6 Reinício de containers

| Caso                       | O que conferir                                                           | Como                                                                | Resultado |
|----------------------------|--------------------------------------------------------------------------|---------------------------------------------------------------------|-----------|
| Validator cai              | com o validator parado, o `/health` do server responde 503               | `docker stop` no `containers-test.sh`; `TestHealthFollowsValidator` | passou    |
| Validator volta            | depois de `docker start`, o `/health` volta a 200 sem reiniciar o server | `containers-test.sh`                                                | passou    |
| Envio com o validator fora | o navegador recebe `VALIDATOR_UNAVAILABLE`                               | `TestValidatorDownOnSubmit`                                         | passou    |
| Política de reinício       | os dois containers têm `restart unless-stopped`                          | `docker inspect` no `containers-test.sh`                            | passou    |

## 6.7 Persistência

| Caso                                | O que conferir                                                                                                                        | Como                                                                  | Resultado |
|-------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------|-----------|
| Reabrir a cadeia                    | o arquivo é a própria cadeia exportável e, reaberto, continua aceitando blocos                                                        | `TestPersistAndReopen`                                                | passou    |
| Reiniciar o validator               | a cadeia exportada antes e depois do `docker restart` tem o mesmo SHA-256 (3072 bytes, 6 blocos)                                      | `containers-test.sh`                                                  | passou    |
| Relógio atrasado depois do reinício | com o relógio da placa atrás do último carimbo, o validator aceita o histórico e as mensagens seguintes continuam depois das gravadas | `TestRebootWithClockBehind`, `TestRunStartAfterRebootWithClockBehind` | passou    |

## 6.8 Perda de energia

O validator só responde 200 a um bloco depois de gravá-lo e fazer `fsync` (`Append` em
`application/bizas/chain.go`). Na partida, ele confere o arquivo antes de escutar. Os testes reproduzem o
estado em que uma queda de energia deixaria o arquivo:

| Caso                     | Estado simulado                        | Comportamento esperado                                                                                                                                    | Como                                                                                                                       | Resultado                                          |
|--------------------------|----------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------|
| Escrita interrompida     | 300 bytes soltos no fim de `chain.bin` | o pedaço incompleto é descartado, o arquivo volta a um múltiplo de 512 bytes e o validator registra `dropped an incomplete block at the end of the chain` | `TestIncompleteTailDropped`; no `containers-test.sh`, os bytes são acrescentados ao volume real e o validator é reiniciado | passou: 3372 → 3072 bytes, mesmo SHA-256 da cadeia |
| Bloco inteiro danificado | um byte trocado dentro do bloco 1 de 3 | o prefixo válido (bloco 0) fica; o resto vai, byte a byte, para `chain.bin.quarantine-<ns>`; nada é apagado                                               | `TestCorruptBlockQuarantined`                                                                                              | passou                                             |
| Falha de escrita         | arquivo aberto só para leitura         | o bloco é recusado com 500 `STORAGE_ERROR`, e nem a memória nem o arquivo mudam                                                                           | `TestStorageErrorLeavesChainUnchanged`                                                                                     | passou                                             |

No provisionamento, a marca `/var/lib/bizas/provisioned` só é gravada depois que os dois containers estão
rodando, seguida de `sync`. Uma queda no meio do `docker load` deixa a marca ausente, e o boot seguinte
provisiona de novo; o `provision.sh` é idempotente (seção 6.4).

## 6.9 Sabotagens

| Conferência                                    | Sabotagem                                                                                                                 | Resultado                                                                                             |
|------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| Assinatura do bloco                            | um byte do `data`, um byte depois do `length`, o `nonce`, um byte do `author`                                             | `FRAUD` no bloco certo (`TestSabotage`)                                                               |
| Limites do `length`                            | `length` acima do máximo e negativo                                                                                       | `INVALID_LENGTH` (`TestSabotage`)                                                                     |
| Encadeamento                                   | bloco reassinado com `prev` trocado, sala trocada, carimbo voltando no tempo                                              | `NO_HASH_CONTINUITY`, `INVALID_ROOM`, `NO_TIMESTAMP_CONTINUITY` (`TestSabotageChain`)                 |
| Assinatura no JavaScript                       | um byte trocado no bloco                                                                                                  | a verificação falha (`bizas.test.js`)                                                                 |
| `validator verify`                             | byte 1224 (bloco 2) da cadeia exportada trocado                                                                           | `INVALID: FRAUD at block 2 (of 6)` (`browser.sh`, toda execução)                                      |
| Hashes dos tars na imagem                      | primeiro dígito do SHA-256 do validator trocado em `evidence/hashes-containers.txt`                                       | `FAIL  bizas-validator tar sha256 b38cf143…, evidence 038cf143…` e `IMAGE CHECK FAILED: 1 failure(s)` |
| Opções do Buildroot                            | três opções acrescentadas ao fragmento: dois símbolos inexistentes e `BR2_PACKAGE_SYSTEMD=y`, que depende do init systemd | `missing in .config` para as três e `ERROR: options above were dropped by kconfig`                    |
| `integrity` do tweetnacl e do qrcode-generator | um byte acrescentado ao pacote baixado (`SABOTAGE_TGZ=1`)                                                                 | `ERROR: integrity mismatch`, nos dois scripts, sem tocar no arquivo embutido                          |

As quatro últimas sabotagens foram executadas em 23/11/2026, com o repositório restaurado em seguida: o
`git status` ficou limpo e o `configure-buildroot.sh` voltou a `configuration OK`.
