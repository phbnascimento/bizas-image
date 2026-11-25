# 7. Aplicação

A aplicação é o chat Bizas: dois binários Go e uma página. Este capítulo diz como ela chega à placa, o que se
configura, quais rotas ela expõe, como se usa a página e como se opera o sistema. O formato do bloco, as regras de
validade e as mensagens do WebSocket estão em [`docs/protocol.md`](../protocol.md).

## 7.1 Instalação

- **Na placa:** não há instalação separada. As imagens dos dois containers vão dentro do rootfs (`/opt/bizas`) e são
  carregadas e criadas pelo `S99bizas` no 1º boot (capítulos 5 e 6). A versão é a de `docker/version.env`.
- **No PC, sem Docker:** `scripts/dev-server.sh` compila e sobe o validator e o server como processos locais, para
  abrir a página no navegador (`--port N` muda a porta, e `--fresh` começa com a cadeia vazia). Não existem fora da
  placa os containers, o init e os comandos de manutenção em `/usr/bin`.
- **No PC, com Docker:** `scripts/containers-build.sh <arm64|amd64>` e `scripts/containers-test.sh <arm64|amd64>`
  (capítulo 8).

## 7.2 Configuração

A aplicação se configura por variáveis de ambiente; os padrões servem sem nenhuma delas.

| Onde                 | Variável                          | Padrão                  | Efeito                                                                           |
|----------------------|-----------------------------------|-------------------------|----------------------------------------------------------------------------------|
| validator            | `ADDR`                            | `:8081`                 | endereço da API interna                                                          |
| validator            | `DATA_DIR`                        | `/data`                 | pasta do `chain.bin`, que é o volume `bizas-data` na placa                       |
| server               | `ADDR`                            | `:5000`                 | endereço da página, do `/health`, do `/chain` e do WebSocket                     |
| server               | `ADMIN_ADDR`                      | `127.0.0.1:5001`        | porta de manutenção; só aceita endereço de loopback, senão o server não inicia   |
| server               | `VALIDATOR_URL`                   | `http://validator:8081` | onde está o validator; o nome resolve pela rede `bizas-net` (capítulo 6)         |
| `provision.sh`       | `HOST_PORT`                       | `80`                    | porta do host que a página usa                                                   |
| `docker/version.env` | `VERSION`, `NETWORK`, `VOLUME`, … | ver o arquivo           | versão das imagens, nomes da rede e do volume, imagem `golang` fixada por digest |

## 7.3 Rotas

O server expõe, na porta 80 do host (5000 no container):

| Rota              | Resposta                                                                                         |
|-------------------|--------------------------------------------------------------------------------------------------|
| `GET /`           | a página, embutida no binário; nada vem de CDN                                                   |
| `GET /health`     | `200 ok` só se o validator também responde; senão `503`. É o endpoint de saúde e o de prontidão  |
| `GET /chain`      | a cadeia inteira, em blocos de 512 bytes (`application/octet-stream`), para exportar e verificar |
| `GET /chain.json` | a mesma cadeia, formatada para leitura; quem verifica usa o `/chain` binário                     |
| `GET /ws`         | o WebSocket do chat                                                                              |

O validator tem uma API interna, sem porta no host (`GET /health`, `GET /chain` e `POST /blocks`), e o server tem a
porta de manutenção `POST /clock` só dentro do container. As duas estão descritas em
[`docs/protocol.md`](../protocol.md), seções 2 e 4.

## 7.4 Acesso

- **Web:** pela rede Wi-Fi da placa (`BizasChat`, senha `embarcados2026`), `http://192.168.50.1/`; pelo cabo, no IP
  que a `eth0` recebeu (`ip addr show eth0` no console). A página funciona por `http://`, sem HTTPS e sem internet.
- **Local:** no console da placa (HDMI ou serial), como `root` ou `anon` (capítulo 9). `wget -qO- http://127.0.0.1/health`
  devolve `ok` quando a aplicação inteira responde.

## 7.5 Uso da página

1. **Primeira vez: a chave.** A página mostra só o campo da chave privada: a pessoa gera uma nova (botão de dado) ou
   cola uma que já tem (64 caracteres hexadecimais). A página mostra a chave pública, e a pessoa confirma. Só então a
   chave é gravada no `localStorage` do navegador e a página conecta. A chave privada nunca sai do navegador; limpar os
   dados do site a apaga, e a identidade junto. O QR code da chave privada aparece enquanto ela é válida no campo.
2. **Escrever.** O texto vai de até 320 bytes. A página assina com a hora da placa, faz a prova de trabalho (varia o
   `nonce` até a assinatura ter os bits zero exigidos pela cadeia) e envia. Quem escreve a primeira mensagem de uma
   sala escolhe os bits zero, de 0 a 20 (padrão 10), e esse valor vale para toda a cadeia.
3. **Ver a hora.** Cada mensagem mostra a idade ("5 min ago"), medida no relógio da placa. Os comandos `set-date` e
   `set-auto-date` informam a hora real, e a página passa a mostrar a data.
4. **Enquetes.** O botão "+", à esquerda da barra de mensagem, abre o menu "Create New Poll" ("Criar Nova Enquete" em
   português), que abre o painel de criação: pergunta, de 2 a 10 opções e a caixa de opções mutuamente exclusivas. Clicar
   numa opção vota, e clicar de novo retira o voto. Numa enquete exclusiva, trocar de opção envia dois blocos.
5. **"view" ("ver" em português).** Na linha do ID de cada mensagem, alinhado à direita, abre o painel com os campos
   do bloco, com o valor bruto e uma leitura.
6. **Painel de uma chave.** Clicar no ID de uma pessoa abre a chave pública completa, o QR code, o primeiro bloco e
   quantos ela enviou, e deixa dar a ela um nome, uma cor e uma nota, guardados só neste navegador.
7. **Configurações (a engrenagem).** Língua (inglês, o padrão, ou português), tema (claro ou escuro) e "Enable Fraud
   Test" ("Ativar teste de fraude"), que mostra os campos do bloco para editar antes de enviar e mostra o código de
   recusa do validator.
8. **Rodapé.** "Download the chain" ("Baixar a chain") baixa o `/chain`, e "as JSON" ("em JSON") abre o
   `/chain.json`.

A impressão digital da cadeia (cabeçalho) e o número de blocos permitem a duas pessoas conferir que veem o mesmo
histórico.

## 7.6 Operação

Os comandos de manutenção rodam como `root` no console da placa; o capítulo 1 (seção 1.5) os descreve:

| Comando                                    | O que faz                                                                                       |
|--------------------------------------------|-------------------------------------------------------------------------------------------------|
| `set-date AAAA-MM-DD-hh-mm-ss [--tz FUSO]` | informa a hora real à página (fuso padrão UTC); não mexe no relógio da placa                    |
| `set-auto-date`                            | consulta a hora por SNTP e a informa; sem rede, sai com erro e sugere o `set-date`              |
| `reset-chat [--yes]`                       | começa um chat novo; a cadeia atual fica no volume como `chain.bin.reset-<ns>`, sem ser apagada |

**Verificar a cadeia fora da placa.** Quem baixa o `/chain` confere a validade com o próprio binário do validator:

```sh
cd application && go build -o /tmp/validator ./validator && cd ..
/tmp/validator verify chain.bin       # "valid: N blocks" ou "INVALID: <erro> at block <i> (of N)"
/tmp/validator fingerprint chain.bin  # a impressão digital da cabeça, para comparar com a página
```

**Persistência.** A cadeia é o arquivo `/data/chain.bin` do volume `bizas-data`, com `fsync` a cada bloco. Ela
sobrevive a reinício e à recriação dos containers. Recuperar, restaurar e diagnosticar estão no capítulo 9.
