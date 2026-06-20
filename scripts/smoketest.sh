#!/usr/bin/env bash
# Hit every proxy endpoint with a realistic payload. Run while `make proxy` is up.
# Usage: bash scripts/smoketest.sh   (or:  make smoketest)
set -euo pipefail

PROXY="${PROXY:-http://localhost:8001}"
PASS=0
FAIL=0

green()  { printf "\033[32m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
dim()    { printf "\033[2m%s\033[0m\n" "$*"; }

check() {
  local name=$1 method=$2 path=$3 body=${4:-}
  printf "%-22s " "$name"
  local code
  if [[ -z "$body" ]]; then
    code=$(curl -sS -o /tmp/incogenome_resp.json -w '%{http_code}' "$PROXY$path")
  else
    code=$(curl -sS -o /tmp/incogenome_resp.json -w '%{http_code}' \
           -X "$method" "$PROXY$path" \
           -H 'Content-Type: application/json' -d "$body")
  fi
  if [[ "$code" == 2* ]]; then
    green "OK ($code)"
    PASS=$((PASS+1))
    dim "  $(head -c 180 /tmp/incogenome_resp.json)..."
  else
    red "FAIL ($code)"
    FAIL=$((FAIL+1))
    cat /tmp/incogenome_resp.json
    echo
  fi
}

echo "== Incogenome proxy smoke test =="

check "health"       GET  "/"
check "explain"      POST "/api/explain" \
  '{"gene":"CYP2C19","phenotype":"Poor metabolizer","drug":"clopidogrel"}'
check "questions"    POST "/api/questions" \
  '{"phenotypes":[{"gene":"CYP2C19","phenotype":"Poor metabolizer"},{"gene":"SLCO1B1","phenotype":"Decreased function"}],"medications":["clopidogrel","simvastatin"]}'
check "check-meds"   POST "/api/check-meds" \
  '{"phenotypes":[{"gene":"CYP2C19","phenotype":"Normal metabolizer"}],"medications":["clopidogrel","omeprazole"]}'

echo
if [[ "$FAIL" -eq 0 ]]; then
  green "All $PASS checks passed."
else
  red   "$FAIL failed, $PASS passed."
  exit 1
fi
