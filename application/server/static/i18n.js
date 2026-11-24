// Textos da página em inglês e português do Brasil. O inglês é o padrão e a reserva de qualquer chave que falte no
// português. A língua escolhida fica no localStorage (bizas.lang), só neste navegador

const DICT = {
  en: {
    "disclaimer": "DISCLAIMER: DO NOT SHARE YOUR PRIVATE KEY WITH ANYONE",
    "setup.intro": "Your identity is a private key. It stays in this browser and is never sent anywhere: messages are " +
      "signed here. Generate a new key or paste one you already have.",
    "setup.private": "Private key",
    "setup.placeholder": "64 hexadecimal characters",
    "setup.dice": "Generate a new key",
    "setup.invalid": "A private key is 64 hexadecimal characters (0-9, a-f)",
    "setup.public": "Public key",
    "setup.hint": "This is the identity you will use. Keep a copy of the private key somewhere safe: clearing this " +
      "site's data in the browser deletes it, and the identity with it.",
    "setup.use": "Use this key",
    "head.room": "room",
    "head.you": "you",
    "head.blocks": "blocks",
    "head.fingerprint": "fingerprint",
    "head.work": "zero bits",
    "status.connecting": "connecting…",
    "status.connected": "connected",
    "status.disconnected": "disconnected; retrying…",
    "status.badsig": "received a block with an invalid signature",
    "status.badwork": "received a block without the required proof of work",
    "status.rejected": "message rejected: {code}",
    "status.error": "error: {code}",
    "status.chain": "could not chain the message; please try again",
    "empty": "No messages yet.",
    "msg.placeholder": "Message (signed on this device)",
    "msg.send": "Send",
    "msg.workBits": "Zero bits",
    "msg.workHint": "You are starting the chain: every signature in this room will have to begin with this many zero bits " +
      "(0 to 20). Each extra bit doubles the time to send a message.",
    "msg.mining": "Proof of work: {n} attempts…",
    "msg.opaque": "(content of type {type}, {length} bytes)",
    "msg.ignored": "(a {type} block this browser ignored: {code})",
    "menu.more": "More",
    "menu.poll": "Poll",
    "poll.title": "New poll",
    "poll.question": "Question",
    "poll.questionPlaceholder": "Ask something",
    "poll.options": "Options",
    "poll.optionPlaceholder": "Option {n}",
    "poll.add": "Add option",
    "poll.remove": "Remove option",
    "poll.exclusive": "One choice per person (mutually exclusive options)",
    "poll.exclusiveHint": "To change their choice, a person withdraws the vote and votes again: two blocks, each with " +
      "its own proof of work. Nobody can vote twice for the same option in any poll.",
    "poll.create": "Create poll",
    "poll.genesis": "The first message of a room has to be a text message: it sets the proof of work.",
    "poll.errQuestion": "Write the question",
    "poll.errOption": "Fill in or remove the empty options",
    "poll.errDuplicate": "Two options are the same",
    "poll.errSize": "The poll has {n} bytes; the maximum is 320",
    "poll.label": "Poll · block {index}",
    "poll.modeOne": "one choice per person",
    "poll.modeMany": "several choices per person",
    "poll.total1": "1 vote",
    "poll.totalN": "{n} votes",
    "poll.vote": "Vote for “{option}”",
    "poll.unvote": "Withdraw your vote for “{option}”",
    "vote.cast": "voted for “{option}”",
    "vote.revoke": "withdrew their vote for “{option}”",
    "vote.where": "in the poll at block {index}",
    "foot.key": "Your private key never leaves this browser :)",
    "foot.chain": "Download the chain",
    "foot.json": "as JSON",
    "settings.title": "Settings",
    "settings.language": "Language",
    "settings.theme": "Theme",
    "theme.light": "Light",
    "theme.dark": "Dark",
    "setup.qr": "Private key as QR code",
    "setup.qrShow": "Show private key as QR code",
    "setup.qrHide": "Hide QR code",
    "settings.fraud": "Enable Fraud Test",
    "settings.fraudHint": "Shows every field of the block so you can edit it before sending and see how the protocol reacts.",
    "fraud.hint": "Edit any field, then send. Fields you have not touched follow the normal message. The data field is not " +
      "shown, since it is the message text field. On sending, the proof of work changes the nonce, unless you typed the " +
      "nonce or the sig.",
    "fraud.default": "default",
    "fraud.resign": "Sign automatically after my edits (uncheck to keep the original signature)",
    "fraud.resetAll": "Reset all fields",
    "fraud.roomHex": "Edit room as bytes (hexadecimal) instead of text",
    "fraud.syncStamp": "Update the stamp automatically (uncheck to freeze it)",
    "fraud.stampDate": "Edit the stamp as a UTC date (year, month, day… second) instead of nanoseconds",
    "fraud.sending": "Sending…",
    "fraud.accepted": "Accepted: the validator chained the block",
    "fraud.rejected": "Rejected: {code}",
    "fraud.error": "Error: {code}",
    "fraud.invalid": "Fix the fields in red before sending",
    "fraud.badHex": "{field}: expected {n} hexadecimal characters",
    "fraud.badInt": "{field}: expected a whole number from {min} to {max}",
    "fraud.badText": "{field}: expected text of up to {n} bytes (UTF-8)",
    "fraud.badDate": "{field}: expected a UTC date like 2030-01-02 03:04:05.123456789",
    "panel.title": "Public key",
    "panel.close": "Close",
    "panel.name": "Name",
    "panel.namePlaceholder": "Give this person a name",
    "panel.color": "Color",
    "panel.colorAria": "Color",
    "panel.default": "Default color",
    "panel.note": "Note (visible only to you)",
    "panel.notePlaceholder": "Write a note about this person",
    "panel.first": "First block",
    "panel.firstValue": "#{index} · {when} (stamp {stamp} ns)",
    "panel.sent": "Blocks sent",
    "panel.none": "none yet",
    "msg.view": "view",
    "block.title": "Block {index}",
    "block.bytes": "{n} bytes of data used",
    "block.zeroBits": "begins with {n} zero bits",
    "block.infoGenesis": "genesis: the proof of work (zero bits) of the chain",
    "block.prevGenesis": "genesis: zeroed, there is no previous block",
    "block.prevOf": "the sig of block {index}",
    "when.now": "just now",
    "when.min": "{n} min ago",
    "when.h": "{n} h ago",
    "when.d": "{n} d ago",
    "when.earlier": "earlier session",
  },
  pt: {
    "disclaimer": "AVISO: NÃO COMPARTILHE SUA CHAVE PRIVADA COM NINGUÉM",
    "setup.intro": "Sua identidade é uma chave privada. Ela fica neste navegador e nunca é enviada a lugar nenhum: as " +
      "mensagens são assinadas aqui. Gere uma chave nova ou cole uma que você já tenha.",
    "setup.private": "Chave privada",
    "setup.placeholder": "64 caracteres hexadecimais",
    "setup.dice": "Gerar uma chave nova",
    "setup.invalid": "Uma chave privada tem 64 caracteres hexadecimais (0-9, a-f)",
    "setup.public": "Chave pública",
    "setup.hint": "Esta é a identidade que você vai usar. Guarde uma cópia da chave privada em lugar seguro: limpar " +
      "os dados deste site no navegador apaga a chave, e a identidade com ela.",
    "setup.use": "Usar esta chave",
    "head.room": "sala",
    "head.you": "você",
    "head.blocks": "blocos",
    "head.fingerprint": "footprint",
    "head.work": "bits zero",
    "status.connecting": "conectando…",
    "status.connected": "conectado",
    "status.disconnected": "desconectado; tentando de novo…",
    "status.badsig": "recebido um bloco com assinatura inválida",
    "status.badwork": "recebido um bloco sem a prova de trabalho exigida",
    "status.rejected": "mensagem recusada: {code}",
    "status.error": "erro: {code}",
    "status.chain": "não foi possível encadear a mensagem; tente de novo",
    "empty": "Nenhuma mensagem ainda.",
    "msg.placeholder": "Mensagem (assinada neste aparelho)",
    "msg.send": "Enviar",
    "msg.workBits": "Bits zero",
    "msg.workHint": "Você está começando a cadeia: toda assinatura desta sala terá de começar com esta quantidade de bits " +
      "zero (0 a 20). Cada bit a mais dobra o tempo para enviar uma mensagem.",
    "msg.mining": "Prova de trabalho: {n} tentativas…",
    "msg.opaque": "(conteúdo do tipo {type}, {length} bytes)",
    "msg.ignored": "(bloco {type} ignorado por este navegador: {code})",
    "menu.more": "Mais",
    "menu.poll": "Enquete",
    "poll.title": "Nova enquete",
    "poll.question": "Pergunta",
    "poll.questionPlaceholder": "Pergunte algo",
    "poll.options": "Opções",
    "poll.optionPlaceholder": "Opção {n}",
    "poll.add": "Adicionar opção",
    "poll.remove": "Remover opção",
    "poll.exclusive": "Uma escolha por pessoa (opções mutuamente exclusivas)",
    "poll.exclusiveHint": "Para mudar de escolha, a pessoa retira o voto e vota de novo: dois blocos, cada um com a " +
      "própria prova de trabalho. Em nenhuma enquete alguém vota duas vezes na mesma opção.",
    "poll.create": "Criar enquete",
    "poll.genesis": "A primeira mensagem da sala tem de ser de texto: é ela que define a prova de trabalho.",
    "poll.errQuestion": "Escreva a pergunta",
    "poll.errOption": "Preencha ou remova as opções vazias",
    "poll.errDuplicate": "Há duas opções iguais",
    "poll.errSize": "A enquete tem {n} bytes; o máximo é 320",
    "poll.label": "Enquete · bloco {index}",
    "poll.modeOne": "uma escolha por pessoa",
    "poll.modeMany": "várias escolhas por pessoa",
    "poll.total1": "1 voto",
    "poll.totalN": "{n} votos",
    "poll.vote": "Votar em “{option}”",
    "poll.unvote": "Retirar seu voto em “{option}”",
    "vote.cast": "votou em “{option}”",
    "vote.revoke": "retirou o voto em “{option}”",
    "vote.where": "na enquete do bloco {index}",
    "foot.key": "Sua chave privada nunca sai deste navegador :)",
    "foot.chain": "Baixar a chain",
    "foot.json": "em JSON",
    "settings.title": "Configurações",
    "settings.language": "Idioma",
    "settings.theme": "Tema",
    "theme.light": "Claro",
    "theme.dark": "Escuro",
    "setup.qr": "Chave privada em QR code",
    "setup.qrShow": "Mostrar chave privada em QR code",
    "setup.qrHide": "Ocultar QR code",
    "settings.fraud": "Ativar teste de fraude",
    "settings.fraudHint": "Mostra todos os campos do bloco para você editá-los antes de enviar e ver como o protocolo reage.",
    "fraud.hint": "Edite qualquer campo e envie. Os campos que você não mexeu seguem a mensagem normal. O campo data não " +
      "aparece, pois é o campo do texto da mensagem. Ao enviar, a prova de trabalho muda o nonce, a não ser que você tenha " +
      "digitado o nonce ou a sig.",
    "fraud.default": "padrão",
    "fraud.resign": "Assinar automaticamente depois das minhas edições (desmarque para manter a assinatura original)",
    "fraud.resetAll": "Restaurar todos os campos",
    "fraud.roomHex": "Editar o room em bytes (hexadecimal) em vez de texto",
    "fraud.syncStamp": "Atualizar o stamp automaticamente (desmarque para congelá-lo)",
    "fraud.stampDate": "Editar o stamp como data UTC (ano, mês, dia… segundo) em vez de nanossegundos",
    "fraud.sending": "Enviando…",
    "fraud.accepted": "Aceito: o validator encadeou o bloco",
    "fraud.rejected": "Recusado: {code}",
    "fraud.error": "Erro: {code}",
    "fraud.invalid": "Corrija os campos em vermelho antes de enviar",
    "fraud.badHex": "{field}: esperados {n} caracteres hexadecimais",
    "fraud.badInt": "{field}: esperado um número inteiro de {min} a {max}",
    "fraud.badText": "{field}: esperado texto de até {n} bytes (UTF-8)",
    "fraud.badDate": "{field}: esperada uma data UTC como 2030-01-02 03:04:05.123456789",
    "panel.title": "Chave pública",
    "panel.close": "Fechar",
    "panel.name": "Nome",
    "panel.namePlaceholder": "Dê um nome a esta pessoa",
    "panel.color": "Cor",
    "panel.colorAria": "Cor",
    "panel.default": "Cor padrão",
    "panel.note": "Nota (visível só para você)",
    "panel.notePlaceholder": "Escreva uma nota sobre esta pessoa",
    "panel.first": "Primeiro bloco",
    "panel.firstValue": "#{index} · {when} (carimbo {stamp} ns)",
    "panel.sent": "Blocos enviados",
    "panel.none": "nenhum ainda",
    "msg.view": "ver",
    "block.title": "Bloco {index}",
    "block.bytes": "{n} bytes de data usados",
    "block.zeroBits": "começa com {n} bits zero",
    "block.infoGenesis": "gênese: a prova de trabalho (bits zero) da cadeia",
    "block.prevGenesis": "gênese: zerado, não há bloco anterior",
    "block.prevOf": "a sig do bloco {index}",
    "when.now": "agora mesmo",
    "when.min": "há {n} min",
    "when.h": "há {n} h",
    "when.d": "há {n} d",
    "when.earlier": "sessão anterior",
  },
};

const HTML_LANG = { en: "en", pt: "pt-BR" };
let lang = "en";
const listeners = [];

export const getLang = () => lang;

export function t(key, vars = {}, l = lang) {
  const s = DICT[l]?.[key] ?? DICT.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

// Língua para toLocaleString: no inglês vale a do navegador; no português, pt-BR
export const localeOf = (l = lang) => (l === "pt" ? "pt-BR" : undefined);

export const onLangChange = (fn) => listeners.push(fn);

// Traduz tudo o que o HTML marca: data-i18n (texto, com data-i18n-vars em JSON para os {campos}),
// data-i18n-placeholder e data-i18n-aria
export function applyStatic() {
  document.documentElement.lang = HTML_LANG[lang];
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n, el.dataset.i18nVars ? JSON.parse(el.dataset.i18nVars) : {});
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) {
    const text = t(el.dataset.i18nAria);
    el.setAttribute("aria-label", text);
    if (el.dataset.i18nTitle !== undefined) el.title = text;
  }
  for (const el of document.querySelectorAll("[data-lang]")) el.setAttribute("aria-pressed", String(el.dataset.lang === lang));
}

export function setLang(l) {
  if (!DICT[l]) return;
  lang = l;
  try { localStorage.setItem("bizas.lang", l); } catch { /* sem localStorage: vale só nesta aba */ }
  applyStatic();
  for (const fn of listeners) fn();
}

// Língua guardada; sem ela, a do navegador (pt* vira português), e inglês no resto
export function initLang() {
  let l = null;
  try { l = localStorage.getItem("bizas.lang"); } catch { /* idem */ }
  if (!DICT[l ?? ""]) l = (globalThis.navigator?.language ?? "en").toLowerCase().startsWith("pt") ? "pt" : "en";
  lang = l;
  applyStatic();
}
