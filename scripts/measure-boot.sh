#!/usr/bin/env bash
# Cronometra o boot da placa visto de OUTRO equipamento: do Enter (apertado no instante em que a fonte é ligada) até o
# 1º HTTP 200
#
# Uso: measure-boot.sh <ip-ou-url-base> [arquivo.csv] [caminho]   (caminho padrão: /health)
# Cada tentativa é anexada ao CSV, inclusive as reprovadas
set -euo pipefail

TARGET="${1:?usage: $0 <ip-or-base-url> [file.csv] [path]}"
CSV="${2:-boot-measurements.csv}"
URL_PATH="${3:-/health}"
case "$TARGET" in http*) BASE="$TARGET" ;; *) BASE="http://$TARGET" ;; esac
URL="$BASE$URL_PATH"
LIMIT=60

now() { date +%s.%N; }
elapsed() { awk -v a="$1" -v b="$(now)" 'BEGIN{printf "%.2f", b-a}'; }

mkdir -p "$(dirname "$CSV")"
[ -f "$CSV" ] || echo "datetime,url,seconds,result" > "$CSV"

if curl -s -o /dev/null --max-time 1 "$URL"; then
  echo "WARNING: $URL already answers. Is the board still on? Cut the power and run again." >&2
  exit 1
fi

echo "Target: $URL"
read -r -p "Press Enter AT THE MOMENT you switch the power on... " _
T0="$(now)"
START="$(date '+%Y-%m-%d %H:%M:%S')"

while :; do
  T="$(elapsed "$T0")"
  printf '\r  t = %6s s ' "$T"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 0.5 "$URL" || true)"
  if [ "$CODE" = "200" ]; then
    T="$(elapsed "$T0")"
    break
  fi
  if awk -v t="$T" -v l="$LIMIT" 'BEGIN{exit !(t>l)}'; then
    echo; echo "no answer within ${LIMIT} s"
    echo "$START,$URL,$T,no-response" >> "$CSV"
    exit 2
  fi
  sleep 0.1
done

RESULT=$(awk -v t="$T" 'BEGIN{print (t<15.0) ? "pass" : "FAIL"}')
echo; echo "First 200 at $T s → $RESULT (limit 15.0 s)"
echo "$START,$URL,$T,$RESULT" >> "$CSV"
echo "Recorded in $CSV"
