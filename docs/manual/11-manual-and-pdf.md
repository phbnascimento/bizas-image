# 11. Este manual e o PDF

## 11.1 Estrutura

O manual fica em [`docs/manual/`](README.md), um arquivo Markdown por capítulo, numerados na ordem de
leitura:

| Arquivo                       | Capítulo                                                                              |
|-------------------------------|---------------------------------------------------------------------------------------|
| `00-overview.md`              | o problema, quem usa, o escopo, os requisitos e os critérios de sucesso               |
| `01-architecture.md`          | camadas, containers, fluxo de uma mensagem e acesso de manutenção                     |
| `02-build-environment.md`     | máquina de build, ferramentas, espaço em disco e a sequência até a imagem             |
| `03-buildroot.md`             | cada opção do Buildroot alterada pelo projeto                                         |
| `04-kernel-and-drivers.md`    | o kernel, o fragmento do Docker, módulos e o `check-config.sh`                        |
| `05-boot-and-init.md`         | sequência de boot, serviços, escolhas que mantêm o caminho curto e a medição do tempo |
| `06-docker.md`                | o Docker na imagem, os containers, a rede, o volume, os privilégios e a saúde         |
| `07-application.md`           | configuração, rotas, uso da página e operação                                         |
| `08-tests.md`                 | plano de testes, resultados e sabotagens                                              |
| `09-flashing-and-recovery.md` | gravação, primeiro boot, manutenção, recuperação e diagnóstico                        |
| `10-licenses-and-versions.md` | manifesto de licenças e versões fixadas                                               |
| `11-manual-and-pdf.md`        | este capítulo                                                                         |

O `README.md` da pasta é o índice. Os diagramas ficam em `docs/manual/img/`, em SVG, com cores para fundo
claro e escuro (`prefers-color-scheme`). O formato do bloco e as regras do protocolo não se repetem aqui:
estão em [`docs/protocol.md`](../protocol.md).

Os arquivos Markdown são a fonte editável. O PDF é gerado a partir deles e não entra no Git, como a imagem.

## 11.2 Gerar o PDF

```sh
scripts/build-manual.sh
```

O script:

1. confere que o `python3` tem `markdown-it-py` e `mdit-py-plugins`, e que `deno` e `firefox` existem;
2. junta os capítulos `NN-*.md`, em ordem, num único HTML com capa, sumário e os capítulos
   (`scripts/lib/manual-html.py`). O Markdown é lido pela especificação CommonMark com tabelas, a mesma base
   do GitHub. Os links entre capítulos viram âncoras internas, os links para arquivos do repositório viram
   links para o GitHub e os diagramas entram como imagens;
3. sobe um Firefox headless com um perfil temporário e imprime o HTML em PDF A4 pelo WebDriver BiDi
   (`browsingContext.print`, em `scripts/lib/print-pdf.ts`), depois de esperar as fontes e todas as imagens
   carregarem. Se alguma imagem não carregar, o script para com erro;
4. confere que o arquivo gerado começa com `%PDF-`.

Saída: `output/manual/bizas-manual.pdf`, mais o HTML intermediário `output/manual/bizas-manual.html`. A capa
traz a versão dos containers (de `docker/version.env`), a data de geração e a revisão do Git
(`git describe --always --dirty --tags`), para identificar de que código o PDF saiu.

## 11.3 Manter o manual em dia

Toda mudança em código, configuração, scripts ou containers atualiza, na mesma etapa, os capítulos que ela
afeta, como acontece com os hashes de `evidence/`. Depois, `scripts/build-manual.sh` regenera o PDF.

Os números deste manual saem de comandos que podem ser repetidos:

| Dado                                     | Comando                                                                                                     |
|------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| Tamanho por pacote no rootfs             | `make -C buildroot O="$PWD/output/buildroot" graph-size` → `output/buildroot/graphs/package-size-stats.csv` |
| Licenças e versões                       | `make -C buildroot O="$PWD/output/buildroot" legal-info` → `output/buildroot/legal-info/manifest.csv`       |
| Valor final das opções do kernel         | `output/buildroot/build/linux-custom/.config`                                                               |
| Resultado do `check-config.sh` do Docker | `scripts/check-image.sh` → `evidence/kernel-check-config.txt`                                               |
| Hashes e tamanhos da imagem              | `scripts/build-image.sh` → `evidence/hashes-image.txt`                                                      |
| Resultados dos testes                    | os comandos da seção 8.1                                                                                    |
