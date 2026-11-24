"""Gera o /etc/issue (mensagem de boas-vindas do console): a arte, a saudação com a versão e a tabela de integrantes

Uso: make-issue.py ARTE VERSAO   (escreve o issue em stdout)

O getty do BusyBox trata a barra invertida e o % como escape no issue: \\n vira o nome da máquina e um escape que ele
não conhece perde a barra. Por isso os dois são dobrados aqui, e o que aparece no console é o texto original
"""
import sys

# Nome e RA de cada integrante, em ordem alfabética
MEMBERS = [
    ("Pedro H. Brito", "226146"),
    ("Pedro H. Cretella", "226013"),
    ("Rafael Lima", "226326"),
    ("Vinícius Regis", "230610"),
]
INDENT = "  "
# Cores ANSI: a arte em magenta (35) e o resto em amarelo claro (93), como o console as entende. O getty do BusyBox não
# traduz \e{cor}, então o ESC (0x1b) vai direto no arquivo; ele não é \ nem %, e o getty o repassa sem mexer
ESC = "\x1b"
MAGENTA, YELLOW, RESET = ESC + "[35m", ESC + "[93m", ESC + "[m"


def escape(text):
    return text.replace("\\", "\\\\").replace("%", "%%")


def render(art, version):
    rows = [("Nome", "RA")] + MEMBERS
    width = max(len(name) for name, _ in rows)
    lines = [escape(line) for line in art.rstrip("\n").split("\n")]
    lines[0] = MAGENTA + lines[0]
    lines += [YELLOW, INDENT + f"Bem-vindo! bizas v{version}", ""]
    lines += [INDENT + escape(f"{name:<{width}}  {ra}") for name, ra in rows]
    # O reset, numa linha só dele, evita que o "login:" herde o amarelo e deixa uma linha em branco antes dele
    return "\n".join(lines + [RESET]) + "\n"


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: make-issue.py ART VERSION")
    with open(sys.argv[1], encoding="utf-8") as f:
        art = f.read()
    sys.stdout.write(render(art, sys.argv[2]))
