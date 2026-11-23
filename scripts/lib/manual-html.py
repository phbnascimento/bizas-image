"""Junta os capítulos do manual técnico (docs/manual/NN-*.md) num único HTML pronto para imprimir em PDF: capa, sumário
e os capítulos em ordem, com os links entre capítulos virando âncoras internas e os links para arquivos do repositório
virando links para o GitHub

Uso: python3 -I manual-html.py <docs/manual> <saída.html>
Requer markdown-it-py e mdit-py-plugins (os mesmos tipos de tabela e lista do GitHub, pela especificação CommonMark)
"""
import datetime
import html
import os
import re
import subprocess
import sys

from markdown_it import MarkdownIt
from mdit_py_plugins.anchors import anchors_plugin

REPO_URL = "https://github.com/phbnascimento/bizas-image"
CHAPTER = re.compile(r"^(\d\d)-[a-z0-9-]+\.md$")

CSS = """
@page { size: A4; margin: 18mm 16mm; }
:root { color-scheme: light; }
body { font: 10.5pt/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f2328; background: #fff;
  margin: 0; }
h1 { font-size: 20pt; margin: 0 0 12pt; break-before: page; }
h2 { font-size: 14pt; margin: 18pt 0 6pt; break-after: avoid; }
h3 { font-size: 11.5pt; margin: 14pt 0 4pt; break-after: avoid; }
p, ul, ol { margin: 0 0 7pt; }
li { margin: 2pt 0; }
a { color: #0969da; text-decoration: none; }
code { font: 9pt ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f6f8fa; padding: 0 2pt;
  border-radius: 3pt; overflow-wrap: anywhere; }
pre { background: #f6f8fa; padding: 7pt 9pt; border-radius: 5pt; white-space: pre-wrap; overflow-wrap: anywhere;
  break-inside: avoid; margin: 0 0 8pt; }
pre code { background: none; padding: 0; font-size: 8.5pt; }
table { border-collapse: collapse; width: 100%; margin: 0 0 9pt; font-size: 8.8pt; }
th, td { border: 0.6pt solid #d0d7de; padding: 3pt 5pt; vertical-align: top; text-align: left;
  overflow-wrap: break-word; }
th { background: #f6f8fa; }
tr { break-inside: avoid; }
td code, th code { font-size: 8pt; }
h1 code, h2 code, h3 code { font-size: 0.92em; }
/* Tabelas de duas colunas (campo e conteúdo): a primeira coluna não quebra palavra no meio */
table:has(th:nth-child(2):last-child) td:first-child { width: 24%; overflow-wrap: normal; }
/* Números alinhados à direita (tamanhos) ficam numa linha só */
td[style*="right"], th[style*="right"] { white-space: nowrap; overflow-wrap: normal; }
img { max-width: 100%; display: block; margin: 6pt auto 10pt; break-inside: avoid; }
.cover { height: 240mm; display: flex; flex-direction: column; justify-content: center; text-align: center; }
.cover img { width: 45mm; margin: 0 auto 12mm; }
.cover h1 { break-before: auto; font-size: 28pt; margin-bottom: 4pt; }
.cover p { color: #57606a; margin: 2pt 0; }
.toc { break-before: page; }
.toc h1 { break-before: auto; }
.toc ol { list-style: none; padding-left: 0; }
.toc ol ol { padding-left: 14pt; }
.toc li { margin: 3pt 0; }
"""


def slugify(text):
    s = re.sub(r"[^\w\s-]", "", text.lower(), flags=re.UNICODE).strip()
    return re.sub(r"[\s]+", "-", s)


def git_describe(root):
    try:
        out = subprocess.run(["git", "-C", root, "describe", "--always", "--dirty", "--tags"],
                             capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def read_version(root):
    with open(os.path.join(root, "docker", "version.env"), encoding="utf-8") as f:
        for line in f:
            if line.startswith("VERSION="):
                return line.split("=", 1)[1].strip()
    return "unknown"


def chapter_id(name):
    return "f-" + name[:-3]


def rewrite_links(tokens, manual_dir, root, chapters):
    # Links e imagens relativos: capítulo → âncora interna; arquivo do repositório → GitHub; imagem → caminho absoluto
    for tok in tokens:
        for child in tok.children or []:
            if child.type == "link_open":
                href = child.attrGet("href") or ""
                if re.match(r"^[a-z]+:", href) or href.startswith("#"):
                    continue
                path, _, frag = href.partition("#")
                target = os.path.normpath(os.path.join(manual_dir, path))
                base = os.path.basename(target)
                if os.path.dirname(target) == manual_dir and base in chapters:
                    child.attrSet("href", "#" + (chapter_id(base) + "-" + frag if frag else chapter_id(base)))
                else:
                    rel = os.path.relpath(target, root)
                    kind = "tree" if os.path.isdir(target) else "blob"
                    child.attrSet("href", f"{REPO_URL}/{kind}/main/{rel}" + (f"#{frag}" if frag else ""))
            elif child.type == "image":
                src = child.attrGet("src") or ""
                if not re.match(r"^[a-z]+:", src):
                    child.attrSet("src", "file://" + os.path.abspath(os.path.join(manual_dir, src)))


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    manual_dir = os.path.abspath(sys.argv[1])
    out = sys.argv[2]
    root = os.path.abspath(os.path.join(manual_dir, "..", ".."))
    chapters = sorted(n for n in os.listdir(manual_dir) if CHAPTER.match(n))
    if not chapters:
        print(f"ERROR: no NN-*.md chapter in {manual_dir}", file=sys.stderr)
        return 1

    toc, bodies = [], []
    for name in chapters:
        prefix = chapter_id(name)
        md = MarkdownIt("commonmark", {"html": False}).enable("table")
        md.use(anchors_plugin, min_level=1, max_level=3,
               slug_func=lambda t, p=prefix: p if t is None else f"{p}-{slugify(t)}")
        with open(os.path.join(manual_dir, name), encoding="utf-8") as f:
            text = f.read()
        tokens = md.parse(text)
        rewrite_links(tokens, manual_dir, root, chapters)
        # O título do capítulo (h1) leva o id do arquivo, para os links entre capítulos
        entries = []
        for i, tok in enumerate(tokens):
            if tok.type == "heading_open" and tok.tag in ("h1", "h2"):
                # Título já em HTML (código inline vira <code>), para o sumário
                title = md.renderer.renderInline(tokens[i + 1].children, md.options, {})
                if tok.tag == "h1":
                    tok.attrSet("id", prefix)
                entries.append((tok.tag, title, tok.attrGet("id")))
        toc.append(entries)
        bodies.append(f'<section id="sec-{prefix}">' + md.renderer.render(tokens, md.options, {}) + "</section>")

    toc_html = ["<ol>"]
    for entries in toc:
        subs = [e for e in entries if e[0] == "h2"]
        head = next((e for e in entries if e[0] == "h1"), None)
        if head is None:
            continue
        toc_html.append(f'<li><a href="#{head[2]}">{head[1]}</a>')
        if subs:
            toc_html.append("<ol>" + "".join(f'<li><a href="#{s[2]}">{s[1]}</a></li>' for s in subs)
                            + "</ol>")
        toc_html.append("</li>")
    toc_html.append("</ol>")

    logo = "file://" + os.path.join(root, "assets", "bizas.png")
    version, rev = read_version(root), git_describe(root)
    today = datetime.date.today().isoformat()
    doc = f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="color-scheme" content="light">
<title>Bizas: manual técnico</title><style>{CSS}</style></head><body>
<div class="cover"><img src="{html.escape(logo)}" alt="">
<h1>Bizas</h1><p>Manual técnico</p><p>Imagem Linux para Raspberry Pi 4 · containers {html.escape(version)}</p>
<p>Gerado em {today} a partir de <code>{html.escape(rev)}</code></p></div>
<nav class="toc"><h1>Sumário</h1>{''.join(toc_html)}</nav>
{''.join(bodies)}
</body></html>
"""
    with open(out, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"{len(chapters)} chapters -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
