#!/usr/bin/env bash
# Integration test runner: starts provider + consumer as separate processes
# and checks the consumer's exit code.

set -u
export PATH="$HOME/.npm-global/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

PROVIDER_LOG="$(mktemp -t clawmarket-provider.XXXXXX.log)"
CONSUMER_LOG="$(mktemp -t clawmarket-consumer.XXXXXX.log)"

cleanup() {
  if [[ -n "${PROVIDER_PID:-}" ]]; then
    # Kill the whole process group so npx/tsx children die too
    pkill -P "$PROVIDER_PID" 2>/dev/null || true
    kill "$PROVIDER_PID" 2>/dev/null || true
    sleep 0.3
    pkill -9 -P "$PROVIDER_PID" 2>/dev/null || true
    kill -9 "$PROVIDER_PID" 2>/dev/null || true
    wait "$PROVIDER_PID" 2>/dev/null || true
  fi
  # Belt and suspenders: clear anything still bound to our test ports
  for port in 4101 4102 4201 4202; do
    lsof -ti tcp:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

echo "=== Starting provider ==="
# Run tsx directly (no npx/pnpm shim) so PROVIDER_PID is the node process itself.
TSX_BIN="$PKG_DIR/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  TSX_BIN="$(command -v tsx || true)"
fi
(cd "$PKG_DIR" && exec "$TSX_BIN" "$SCRIPT_DIR/provider-process.ts") >"$PROVIDER_LOG" 2>&1 &
PROVIDER_PID=$!

# Wait for the provider to print its READY line (up to 20s)
MULTIADDR=""
for i in $(seq 1 40); do
  if ! kill -0 "$PROVIDER_PID" 2>/dev/null; then
    echo "!!! Provider died early"
    break
  fi
  if grep -q "\[PROVIDER\] READY" "$PROVIDER_LOG" 2>/dev/null; then
    MULTIADDR="$(grep -Eo '/ip4/127\.0\.0\.1/tcp/4101/p2p/[A-Za-z0-9]+' "$PROVIDER_LOG" | head -1)"
    break
  fi
  sleep 0.5
done

if [[ -z "$MULTIADDR" ]]; then
  echo "!!! Could not extract provider multiaddr"
  echo "--- provider log ---"
  cat "$PROVIDER_LOG"
  exit 1
fi

echo "Provider multiaddr: $MULTIADDR"

echo "=== Starting consumer ==="
(cd "$PKG_DIR" && npx tsx "$SCRIPT_DIR/consumer-process.ts" "$MULTIADDR") >"$CONSUMER_LOG" 2>&1
CONSUMER_EXIT=$?

echo
echo "=============== PROVIDER LOG ==============="
cat "$PROVIDER_LOG"
echo
echo "=============== CONSUMER LOG ==============="
cat "$CONSUMER_LOG"
echo
echo "============================================"

if [[ "$CONSUMER_EXIT" -eq 0 ]]; then
  echo ">>> PASS"
  exit 0
else
  echo ">>> FAIL (consumer exit=$CONSUMER_EXIT)"
  exit "$CONSUMER_EXIT"
fi
