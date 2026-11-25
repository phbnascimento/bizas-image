# 9. Gravação, recuperação e diagnóstico

## 9.1 Gravar o cartão microSD

```sh
scripts/flash-sd.sh           # grava e confere lendo o cartão de volta
scripts/flash-sd.sh --fast    # grava sem a leitura de volta
```

O `dd` sobrescreve o disco escolhido, então o script se protege antes de gravar:

1. roda como usuário comum e pede `sudo` só para gravar e ler o cartão;
2. confere, com o `debugfs` do build, que a imagem contém a aplicação (`/opt/bizas`);
3. confere que o SHA-256 de `output/buildroot/images/sdcard.img` é o registrado em
   `evidence/hashes-image.txt`;
4. lista os discos (`lsblk`) e pede que o nome do dispositivo seja **digitado**, duas vezes; aceita só nomes
   `sdX` ou `mmcblkN`;
5. recusa o disco onde está o `/` do sistema e qualquer disco acima de 256 GB;
6. desmonta as partições do cartão e grava com `dd bs=16M conv=fsync`;
7. esvazia o cache do dispositivo, lê de volta do cartão exatamente o tamanho da imagem e compara o SHA-256
   com o da imagem. Com `--fast`, esse passo é pulado e o script avisa que nada prova que o cartão recebeu a
   imagem.

Para gravar a partir do arquivo entregue, `bizas-rpi4.img.xz`, em outra máquina: conferir o SHA-256 contra
`evidence/hashes-image.txt` e descomprimir direto para o cartão, por exemplo com
`xz -dc bizas-rpi4.img.xz | sudo dd of=/dev/sdX bs=16M conv=fsync`, trocando `sdX` pelo cartão.

## 9.2 Primeiro boot

No primeiro boot, o `S99bizas` provisiona os containers (capítulo 5, seção 5.4). Entre as linhas do console, intercaladas
com a saída do próprio `docker load`, estão estas:

```text
[bizas] first boot: provisioning the containers
[bizas] docker load may keep this screen still for a few minutes
[provision] docker load /opt/bizas/bizas-validator-0.5.tar (this may take a while)
[provision] docker load /opt/bizas/bizas-server-0.5.tar (this may take a while)
[provision] creating bizas-validator
[provision] creating bizas-server (port 80 -> 5000)
[provision] containers started: bizas-validator, bizas-server
[bizas] provisioning done
```

O `rcS` é uma ação `sysinit` do `/etc/inittab` sem terminal próprio, então a saída dele vai para
`/dev/console`, que é o `ttyAMA0` (seção 9.4): essas linhas aparecem no console serial. No HDMI, a tela fica
parada enquanto o `docker load` roda, e o prompt de login só aparece depois, porque o init do BusyBox só
inicia os `getty` quando todas as ações `sysinit` terminam. O provisionamento não pede nenhuma intervenção. Nos boots seguintes, o console mostra só
`[bizas] already provisioned; dockerd restarts the containers`.

Se o provisionamento falhar, o `S99bizas` mostra uma destas mensagens e não grava a marca, de modo que o boot
seguinte tenta de novo:

| Mensagem                                                                                                | Causa                                                                                              |
|---------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------|
| `[bizas] ERROR: dockerd did not answer within 60 s`                                                     | o `dockerd` não respondeu ao `docker info` em 300 tentativas de 0,2 s                              |
| `[bizas] ERROR: provisioning failed; it will be retried on the next boot`                               | o `provision.sh` saiu com erro; a mensagem `[provision] ERROR: …` logo acima diz qual passo falhou |
| `[bizas] ERROR: containers are not running; see: docker logs bizas-validator; docker logs bizas-server` | os containers foram criados, mas não estavam `running` depois de 25 tentativas de 0,2 s            |

## 9.3 Acesso de manutenção

- **Console HDMI:** monitor e teclado na placa; login em `tty1`.
- **Console serial:** `ttyAMA0` a 115200 baud, nos GPIOs 14 e 15 (seção 4.1).
- **Usuários:** `root` e `anon`, os dois com a senha `bizasprotocol`; o `anon` não tem privilégios. Não há SSH.

Comandos úteis no console:

```sh
docker ps -a                                     # estado e saúde dos dois containers
docker logs bizas-validator 2>&1 | tail -n 50    # log do validator (stderr incluído)
docker logs bizas-server 2>&1 | tail -n 50       # log do server
wget -qO- http://127.0.0.1/health                # "ok" quando a aplicação inteira responde
ip addr show eth0                                # endereço pelo cabo
ip addr show wlan0                               # 192.168.50.1, o endereço pelo Wi-Fi BizasChat
hostapd_cli all_sta                              # aparelhos conectados ao Wi-Fi
grep wifi-ap /var/log/messages                   # o que o S39wifi-ap fez neste boot
tail -n 50 /var/log/messages                     # syslog, inclusive a saída do dockerd
```

Os logs dos containers sempre com `2>&1`: os binários escrevem no stderr. O `/var/log` aponta para `/tmp`,
que é tmpfs, então o syslog não sobrevive a um reinício; os logs dos containers ficam com o `dockerd`, em
`/var/lib/docker`, no rootfs.

## 9.4 A ordem dos `console=`

O `cmdline.txt` tem `console=tty1 console=ttyAMA0,115200`, nesta ordem, e ela não deve ser invertida.
Segundo a documentação do kernel (`Documentation/admin-guide/serial-console.rst`), quando há vários
`console=`, o último é o dispositivo usado ao abrir `/dev/console`.

O `/etc/inittab` da imagem tem dois `getty`: um em `console`, que é o `/dev/console`, e um em `tty1`,
acrescentado pelo `post-build.sh` da Raspberry Pi para o HDMI. Com o `ttyAMA0` por último, cada `getty`
fica num terminal: um na serial e um no HDMI. Com a ordem invertida, `/dev/console` passa a ser o `tty1`, e
dois `getty` disputam o mesmo terminal: o teclado do HDMI parece "comer" caracteres no login.

## 9.5 Refazer o provisionamento

O provisionamento é refeito apagando a marca e rodando o `S99bizas`. As imagens e os containers podem ser
removidos antes; o **volume `bizas-data` não**, porque ele guarda a cadeia.

```sh
docker rm -f bizas-validator bizas-server        # remove os containers (a cadeia fica no volume)
docker rmi bizas-validator:0.5 bizas-server:0.5    # opcional: força um novo docker load dos tars
rm /var/lib/bizas/provisioned
/etc/init.d/S99bizas start                       # ou reiniciar a placa
```

O `provision.sh` é idempotente: carrega só as imagens que faltam, reaproveita a rede `bizas-net` e o volume
`bizas-data` se existirem, e recria só os containers que faltam ou que são de outra versão. Não execute
`docker volume rm bizas-data`: isso apaga a cadeia.

## 9.6 Recuperar a cadeia

**Cópia e verificação, de outro aparelho.** A cadeia inteira sai em `GET /chain`, nos mesmos blocos de 512
bytes do arquivo gravado. Qualquer pessoa confere a cópia sem confiar na placa:

```sh
curl -o chain.bin http://<IP da placa>/chain
cd application && go build -o /tmp/validator ./validator && cd ..
/tmp/validator verify chain.bin                  # valid: N blocks
/tmp/validator fingerprint chain.bin             # #N <16 hex>, igual ao que a página mostra
```

`GET /chain.json` traz a mesma cadeia em JSON formatado, só para leitura.

**O arquivo na placa.** A cadeia fica no volume `bizas-data`, em `/data/chain.bin` dentro do validator. No
host, com o diretório de dados padrão do Docker, o volume fica em
`/var/lib/docker/volumes/bizas-data/_data/`.

**Na partida, o validator confere o arquivo antes de escutar:**

- **pedaço final incompleto** (escrita interrompida): é descartado, e o log registra
  `dropped an incomplete block at the end of the chain` com o número de bytes;
- **bloco inteiro inválido no meio** (dano ou adulteração): os blocos válidos do começo ficam; o bloco
  inválido e todos os seguintes vão para `chain.bin.quarantine-<ns>`, ao lado de `chain.bin`, e o log
  registra `invalid block in the stored chain; kept the valid prefix and moved the rest aside`, com o
  código do erro, o índice do bloco e o nome do arquivo de quarentena. Nada é apagado;
- **arquivo que não abre:** o validator registra `could not open the chain` com o caminho e o erro, e sai
  com código 1; o `dockerd` o reinicia pela política `unless-stopped`.

Os blocos em quarentena não voltam para a cadeia: o primeiro deles é o inválido, e os seguintes
encadeiam nele. O arquivo existe para análise. Na revalidação de partida vale só a validade da cadeia, nunca
a regra do relógio: com a placa acordando com o relógio atrasado, o histórico gravado continua válido.

## 9.7 Começar um chat novo

O `reset-chat`, como root no console, começa um chat com a cadeia vazia:

```sh
reset-chat          # pede para digitar "reset"
reset-chat --yes    # sem pergunta, para scripts
```

O comando para o `bizas-validator` e roda `validator reset` num container descartável da mesma imagem, sem
rede e com o volume montado. O `validator reset` renomeia `/data/chain.bin` para `chain.bin.reset-<ns>`, ao
lado, onde `<ns>` é o instante em nanossegundos. Depois o comando religa o validator, que cria um `chain.bin`
vazio, reinicia o `bizas-server`, o que fecha os WebSockets abertos, e espera o server ficar `healthy`. As páginas
abertas reconectam, recebem o histórico vazio e mostram o campo de bits zero para o gênese novo.

- **Nada é apagado:** a cadeia anterior fica no volume, em
  `/var/lib/docker/volumes/bizas-data/_data/chain.bin.reset-<ns>`, e passa no `validator verify` como qualquer
  cadeia exportada.
- **Cadeia já vazia:** o `validator reset` responde `reset: no messages to archive; the chain is already empty` e
  não cria arquivo.
- **Falha ao arquivar:** o comando religa o validator com a cadeia atual e sai com código 1.
- **Hora real:** o validator religado tem outro `run_start`, então a hora informada por `set-date` ou
  `set-auto-date` deixa de valer e precisa ser informada de novo.

## 9.8 Diagnóstico

| Sintoma                                                      | Causa conhecida                                                                    | O que fazer                                                                                                                                                                                                                                       |
|--------------------------------------------------------------|------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Container em `Restarting (255)`, log com `exec format error` | a imagem do container é de outra arquitetura (por exemplo, `amd64` na placa)       | gerar com `scripts/containers-build.sh arm64`; o script confere a arquitetura dentro do tar, e o `post-build.sh` recusa embarcar um tar que não seja `linux/arm64`. Para conferir um tar: `python3 -I scripts/lib/check-image-tar.py <tar> arm64` |
| O celular não abre a página, mas o notebook abre             | com dados móveis ligados, o celular prefere o 4G numa rede Wi-Fi sem internet      | desligar os dados móveis do celular                                                                                                                                                                                                               |
| Login no HDMI "come" caracteres                              | ordem dos `console=` invertida no `cmdline.txt`                                    | manter `console=tty1 console=ttyAMA0,115200` (seção 9.4)                                                                                                                                                                                          |
| `GET /health` responde 503 `validator unavailable`           | o server está de pé, mas o validator não responde                                  | `docker logs bizas-validator 2>&1 \| tail`; o validator pode estar recarregando ou recusando o arquivo da cadeia (seção 9.6)                                                                                                                      |
| A página não abre de nenhum aparelho                         | a placa não pegou endereço na `eth0`, ou o aparelho está em outra rede             | `ip addr show eth0` no console; o aparelho precisa estar na mesma rede local                                                                                                                                                                      |
| A rede `BizasChat` não aparece                               | o `brcmfmac` não carregou, o firmware falta, ou o `hostapd` recusou a configuração | `grep wifi-ap /var/log/messages` mostra o passo que falhou e o que olhar; `dmesg \| grep -i brcmf` mostra o driver                                                                                                                                |
| O aparelho conecta ao `BizasChat`, mas não recebe endereço   | o `dnsmasq` não subiu                                                              | `grep -E 'wifi-ap\|dnsmasq' /var/log/messages`; `dnsmasq --test -C /etc/dnsmasq.conf` confere o arquivo                                                                                                                                           |
| `set-auto-date` falha                                        | a placa não alcança nenhum servidor SNTP                                           | usar `set-date AAAA-MM-DD-hh-mm-ss [--tz FUSO]`; a mensagem de erro sugere isso                                                                                                                                                                   |
| O 1º boot ficou com a tela parada                            | o `docker load` dos dois tars está rodando                                         | esperar a mensagem `[bizas] provisioning done` (seção 9.2)                                                                                                                                                                                        |
