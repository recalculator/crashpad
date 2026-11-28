#!/bin/sh
# Check a running Crashpad service from the outside: health, webhook signature
# enforcement, and that the proxy exposes nothing else.
#   deploy/healthcheck.sh https://crashpad.example.com
set -eu
URL="${1:?usage: healthcheck.sh <service base url>}"
URL="${URL%/}"
fail=0
body=$(curl -fsS --max-time 10 "$URL/healthz") || { echo "✗ GET /healthz failed"; exit 1; }
case "$body" in
  *'"ok":true'*) echo "✓ GET /healthz: $body" ;;
  *) echo "✗ GET /healthz is not healthy: $body"; fail=1 ;;
esac
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'content-type: application/json' -H 'x-github-event: ping' -H 'x-hub-signature-256: sha256=0000' --data '{}' "$URL/github/webhook")
if [ "$code" = "401" ]; then echo "✓ unsigned webhook rejected (401)"; else echo "✗ unsigned webhook returned $code (expected 401)"; fail=1; fi
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL/api/companion/status")
case "$code" in
  401) echo "✓ companion API requires a companion token ($code)" ;;
  *) echo "✗ companion API without a token returned $code (expected 401)"; fail=1 ;;
esac
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL/not-a-crashpad-path")
if [ "$code" = "404" ]; then echo "✓ other paths are not served (404)"; else echo "! /not-a-crashpad-path returned $code"; fi
exit $fail
