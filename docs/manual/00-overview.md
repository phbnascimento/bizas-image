# 0. Visão geral

## 0.1 O problema e quem usa

O Bizas é um chat em que cada mensagem é assinada no aparelho de quem escreve e encadeada à anterior. O histórico
resultante pode ser conferido por qualquer pessoa, sem confiar no equipamento que o guarda. Ele roda numa
**Raspberry Pi 4** ligada a uma rede local, sem depender da internet, e só precisa que os participantes abram o
endereço da placa no navegador.

| Quem                      | O que faz                                                | Como                                                                                         |
|---------------------------|----------------------------------------------------------|----------------------------------------------------------------------------------------------|
| Participante              | escreve, vota em enquetes e lê o histórico               | abre o IP da placa no navegador de qualquer aparelho da rede; não instala nada               |
| Quem mantém a placa       | liga, grava o cartão, ajusta a hora, começa um chat novo | console da placa (HDMI ou serial) e os comandos do [capítulo 9](09-flashing-and-recovery.md) |
| Quem confere o histórico  | verifica a cadeia exportada, sem confiar na placa        | `validator verify chain.bin` em qualquer computador com Go                                   |
| Quem reconstrói o sistema | gera a imagem a partir do repositório                    | a sequência do [capítulo 2](02-build-environment.md)                                         |

## 0.2 Escopo

**Dentro do escopo:**
- uma imagem Linux própria, gerada com o Buildroot 2026.05.1, com só o necessário para iniciar o Docker;
- dois containers Go, `bizas-validator` e `bizas-server`, que sobem sozinhos, sem login nem comando manual;
- a rede Wi-Fi da própria placa, `BizasChat`, sem internet, para os aparelhos próximos abrirem a página;
- o protocolo do bloco: 512 bytes, assinatura Ed25519, encadeamento pela assinatura do bloco anterior e prova de
  trabalho com o nonce ([`docs/protocol.md`](../protocol.md));
- a página do chat, com enquetes, o painel de cada bloco, o teste de fraude, língua e tema;
- a persistência da cadeia, os comandos de manutenção (`set-date`, `set-auto-date` e `reset-chat`) e o build
  reproduzível da imagem.

**Fora do escopo, de propósito:**
- **não é uma blockchain descentralizada:** existe uma autoridade única, o validator da placa. O protocolo garante a
  validade da cadeia, não o consenso sobre qual cadeia vale ([`docs/protocol.md`](../protocol.md), seção 6);
- **sem cifra de transporte:** a página funciona por `http://` na rede local. As mensagens são assinadas, não cifradas;
- **sem contas e sem SSH:** a identidade é uma chave privada que fica no navegador, e a manutenção exige acesso físico
  à placa;
- **sem internet na rede da placa:** o Wi-Fi `BizasChat` só liga os aparelhos próximos à placa, sem saída para a
  internet;
- **sem aplicativo nativo:** a chave privada nunca sai do navegador.

## 0.3 Requisitos

| Requisito                                                                                                 | Onde é atendido                                 |
|-----------------------------------------------------------------------------------------------------------|-------------------------------------------------|
| A imagem é gerada a partir do código-fonte do Buildroot, sem distribuição pronta como base                | [capítulos 2 e 3](02-build-environment.md)      |
| A aplicação inicia sozinha depois do boot, sem login nem comando manual                                   | [capítulo 5](05-boot-and-init.md)               |
| A aplicação fica disponível em menos de 15 s depois que a alimentação é aplicada, vista de outro aparelho | [capítulo 5](05-boot-and-init.md)               |
| Docker Engine compilado na imagem, com as imagens dos containers já dentro dela (nada baixado no boot)    | [capítulos 3 e 6](06-docker.md)                 |
| O sistema é mínimo: só o que a aplicação precisa                                                          | [capítulo 3](03-buildroot.md)                   |
| A operação principal não depende da internet                                                              | [capítulo 1](01-architecture.md), seção 1.6     |
| As versões são fixas e o build é reproduzível a partir do repositório                                     | [capítulos 2 e 10](10-licenses-and-versions.md) |
| A imagem tem hash SHA-256 e o manual cobre configuração, build, gravação e recuperação                    | [capítulos 2, 9 e 11](11-manual-and-pdf.md)     |

## 0.4 Critérios de sucesso

1. A imagem é reconstruída seguindo só este manual, e o SHA-256 do artefato entregue confere.
2. Ao energizar a placa, sem ninguém tocar nela, a página abre de outro aparelho da rede em menos de 15,0 s, e o
   endpoint `GET /health` responde 200 só com o chat operacional. O procedimento de medição está no
   [capítulo 5](05-boot-and-init.md).
3. Sem internet, dois aparelhos trocam mensagens, e o histórico sobrevive a um reinício e a uma queda de energia.
4. Um byte alterado em qualquer mensagem faz a cadeia exportada ser recusada por `validator verify`.
5. Um container que cai é religado sozinho.

Os testes e os resultados estão no [capítulo 8](08-tests.md), que separa o que foi verificado no PC do que é
demonstrado na placa. A medição do tempo de boot (critério 2) tem o seu procedimento no
[capítulo 5](05-boot-and-init.md).

## 0.5 Como ler este manual

| Capítulo                                                              | Conteúdo                                                          |
|-----------------------------------------------------------------------|-------------------------------------------------------------------|
| [1. Arquitetura](01-architecture.md)                                  | camadas, containers, fluxo de uma mensagem, acesso de manutenção  |
| [2. Ambiente de build](02-build-environment.md)                       | máquina de build, ferramentas e a sequência até a imagem          |
| [3. Configuração do Buildroot](03-buildroot.md)                       | cada opção alterada, com motivo, dependências e impacto           |
| [4. Kernel e drivers](04-kernel-and-drivers.md)                       | o kernel, o fragmento do Docker e os módulos                      |
| [5. Boot e init](05-boot-and-init.md)                                 | sequência de boot, serviços, otimizações e medição do tempo       |
| [6. Docker](06-docker.md)                                             | o Docker na imagem, os containers, a rede, o volume e a segurança |
| [7. Aplicação](07-application.md)                                     | configuração, rotas, uso da página e operação                     |
| [8. Testes](08-tests.md)                                              | plano de testes, resultados e sabotagens                          |
| [9. Gravação, recuperação e diagnóstico](09-flashing-and-recovery.md) | gravar o cartão, primeiro boot, manutenção e recuperação          |
| [10. Licenças e versões](10-licenses-and-versions.md)                 | manifesto de componentes e versões fixadas                        |
| [11. Este manual e o PDF](11-manual-and-pdf.md)                       | como o manual é organizado e gerado                               |
