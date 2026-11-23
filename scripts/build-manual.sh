#!/usr/bin/env bash
# Gera o PDF do manual técnico a partir dos capítulos em Markdown de docs/manual/: junta tudo num HTML
# (scripts/lib/manual-html.py, com markdown-it-py) e o imprime em PDF com o Firefox headless pelo WebDriver BiDi
# (scripts/lib/print-pdf.ts). O Firefox é o mesmo do teste ponta a ponta
#
# Saída: output/manual/bizas-manual.pdf e o HTML intermediário, ignorados pelo Git como a imagem
#
# Requer: python3 com markdown-it-py e mdit-py-plugins, deno, firefox, curl, ss
# Uso: scripts/build-manual.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/output/manual"
HTML="$OUT/bizas-manual.html"
PDF="$OUT/bizas-manual.pdf"
PORT=9334

die() { echo "ERROR: $*" >&2; exit 1; }

python3 -I -c 'import markdown_it, mdit_py_plugins' \
  || die "python3 needs markdown-it-py and mdit-py-plugins (on Arch: python-markdown-it-py python-mdit_py_plugins)"
command -v deno >/dev/null || die "deno not found"
command -v firefox >/dev/null || die "firefox not found"
# Porta ocupada faria o script falar com outro Firefox
if ss -ltnH "sport = :$PORT" | grep -q .; then
  ss -ltnp "sport = :$PORT" >&2
  die "port $PORT already in use"
fi

mkdir -p "$OUT"
TMP="$(mktemp -d)"
FF_PID=""
cleanup() { [ -n "$FF_PID" ] && kill "$FF_PID" 2>/dev/null; wait 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "== HTML"
python3 -I "$ROOT/scripts/lib/manual-html.py" "$ROOT/docs/manual" "$HTML"

echo "== PDF (Firefox headless)"
mkdir "$TMP/profile"
firefox --headless --no-remote --profile "$TMP/profile" --remote-debugging-port="$PORT" about:blank \
  > "$TMP/firefox.log" 2>&1 &
FF_PID=$!
ready=""
for _ in $(seq 100); do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/"; then ready=1; break; fi
  sleep 0.2
done
[ -n "$ready" ] || { cat "$TMP/firefox.log" >&2; die "Firefox did not open port $PORT"; }

rm -f "$PDF"
timeout 120 deno run --allow-net="127.0.0.1:$PORT" --allow-write="$OUT" \
  "$ROOT/scripts/lib/print-pdf.ts" "$PORT" "file://$HTML" "$PDF"

# Um PDF de verdade começa com %PDF-; arquivo vazio ou truncado reprova aqui
[ "$(head -c 5 "$PDF")" = "%PDF-" ] || die "$PDF is not a PDF"
echo "== $(realpath --relative-to="$ROOT" "$PDF") ($(stat -c %s "$PDF") bytes)"
