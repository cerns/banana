#!/usr/bin/env bash
# Test jump host SSH connectivity scenarios
# Usage: ./scripts/test-jumphost.sh
#
# Requires: BANANA_TOKEN, server running, jump hosts configured in Settings

set -euo pipefail

PORT="${BANANA_PORT:-13131}"
TOKEN="${BANANA_TOKEN:-banana}"
BASE="http://localhost:$PORT"
AUTH="Authorization: Bearer $TOKEN"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

pass=0
fail=0
skip=0

log()  { echo -e "${CYAN}[test]${NC} $*"; }
ok()   { echo -e "${GREEN}  PASS${NC} $*"; pass=$((pass+1)); }
fail() { echo -e "${RED}  FAIL${NC} $*"; fail=$((fail+1)); }
warn() { echo -e "${YELLOW}  SKIP${NC} $*"; skip=$((skip+1)); }

api() {
  local method="$1" path="$2"
  shift 2
  curl -s -X "$method" -H "$AUTH" -H "Content-Type: application/json" "$BASE$path" "$@"
}

# ─── Pre-checks ───────────────────────────────────────────────

log "Checking server at $BASE..."
health=$(api GET /api/health 2>/dev/null || echo '{"error":"unreachable"}')
if echo "$health" | grep -q '"error"'; then
  echo -e "${RED}Server not reachable at $BASE${NC}"
  exit 1
fi
ok "Server is running"

# ─── 1. Get jump host config ─────────────────────────────────

log "1. Fetching jump host config..."
config=$(api GET /api/jumphosts)
enabled=$(echo "$config" | python3 -c "import sys,json; print(json.load(sys.stdin)['enabled'])" 2>/dev/null)
host_count=$(echo "$config" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['hosts']))" 2>/dev/null)

if [ "$host_count" = "0" ]; then
  echo -e "${RED}No jump hosts configured. Add them in Settings first.${NC}"
  exit 1
fi
ok "Config loaded: enabled=$enabled, hosts=$host_count"
echo "$config" | python3 -m json.tool 2>/dev/null

# ─── 2. Test chain connectivity ──────────────────────────────

log "2. Testing jump host chain connectivity..."
result=$(api POST /api/jumphosts/test)
test_ok=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)
test_output=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('output', ''))" 2>/dev/null)

if [ "$test_ok" = "True" ]; then
  ok "Chain test passed: $test_output"
else
  test_err=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error', 'unknown'))" 2>/dev/null)
  fail "Chain test failed: $test_err"
fi

# ─── 3. Toggle enabled on/off ────────────────────────────────

log "3. Testing enable/disable toggle..."

api PATCH /api/jumphosts/enabled -d '{"enabled":false}' > /dev/null
check=$(api GET /api/jumphosts | python3 -c "import sys,json; print(json.load(sys.stdin)['enabled'])" 2>/dev/null)
if [ "$check" = "False" ]; then
  ok "Disabled jump hosts"
else
  fail "Failed to disable"
fi

api PATCH /api/jumphosts/enabled -d '{"enabled":true}' > /dev/null
check=$(api GET /api/jumphosts | python3 -c "import sys,json; print(json.load(sys.stdin)['enabled'])" 2>/dev/null)
if [ "$check" = "True" ]; then
  ok "Re-enabled jump hosts"
else
  fail "Failed to re-enable"
fi

# ─── 4. Add/remove host CRUD ─────────────────────────────────

log "4. Testing host CRUD..."

# Add
add_result=$(api POST /api/jumphosts/hosts -d '{"host":"10.99.99.99","port":22,"username":"testuser","label":"test-hop"}')
new_id=$(echo "$add_result" | python3 -c "import sys,json; h=[h for h in json.load(sys.stdin)['hosts'] if h['label']=='test-hop']; print(h[0]['id'] if h else '')" 2>/dev/null)
if [ -n "$new_id" ]; then
  ok "Added test host (id=$new_id)"
else
  fail "Failed to add test host"
fi

# Update
if [ -n "$new_id" ]; then
  api PUT "/api/jumphosts/hosts/$new_id" -d '{"username":"updated-user"}' > /dev/null
  updated=$(api GET /api/jumphosts | python3 -c "import sys,json; h=[h for h in json.load(sys.stdin)['hosts'] if h['id']=='$new_id']; print(h[0]['username'] if h else '')" 2>/dev/null)
  if [ "$updated" = "updated-user" ]; then
    ok "Updated test host username"
  else
    fail "Failed to update test host"
  fi
fi

# Delete
if [ -n "$new_id" ]; then
  api DELETE "/api/jumphosts/hosts/$new_id" > /dev/null
  remaining=$(api GET /api/jumphosts | python3 -c "import sys,json; print(any(h['id']=='$new_id' for h in json.load(sys.stdin)['hosts']))" 2>/dev/null)
  if [ "$remaining" = "False" ]; then
    ok "Deleted test host"
  else
    fail "Failed to delete test host"
  fi
fi

# ─── 5. Parallel connections through jump host ────────────────

log "5. Testing parallel connections (simulates hub dispatch)..."

# Get a machine to test with
machines=$(api GET /api/machines)
machine_id=$(echo "$machines" | python3 -c "import sys,json; m=json.load(sys.stdin); print(m[0]['id'] if m else '')" 2>/dev/null)

if [ -n "$machine_id" ]; then
  CONCURRENCY=6
  log "   Firing $CONCURRENCY parallel SSH tests to machine $machine_id..."

  pids=()
  tmpdir=$(mktemp -d)
  for i in $(seq 1 $CONCURRENCY); do
    (
      result=$(api POST "/api/machines/$machine_id/test" 2>&1)
      echo "$result" > "$tmpdir/result-$i.json"
    ) &
    pids+=($!)
  done

  # Wait for all
  all_ok=true
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  succeeded=0
  failed_count=0
  for i in $(seq 1 $CONCURRENCY); do
    r=$(cat "$tmpdir/result-$i.json" 2>/dev/null || echo '{}')
    is_ok=$(echo "$r" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "False")
    if [ "$is_ok" = "True" ]; then
      succeeded=$((succeeded+1))
    else
      failed_count=$((failed_count+1))
      err=$(echo "$r" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error', 'unknown'))" 2>/dev/null || echo "unknown")
      echo -e "     ${RED}Connection $i failed: $err${NC}"
    fi
  done

  rm -rf "$tmpdir"

  if [ "$failed_count" = "0" ]; then
    ok "All $CONCURRENCY parallel connections succeeded"
  else
    fail "$failed_count/$CONCURRENCY parallel connections failed"
  fi
else
  warn "No machines configured, skipping parallel test"
fi

# ─── 5b. Sequential connections (one at a time) ──────────────

log "5b. Testing sequential connections (one at a time)..."

if [ -n "$machine_id" ]; then
  seq_ok=0
  seq_fail=0
  for i in $(seq 1 6); do
    result=$(api POST "/api/machines/$machine_id/test" 2>&1)
    is_ok=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "False")
    if [ "$is_ok" = "True" ]; then
      seq_ok=$((seq_ok+1))
    else
      seq_fail=$((seq_fail+1))
      err=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error', 'unknown'))" 2>/dev/null || echo "unknown")
      echo -e "     ${RED}Connection $i failed: $err${NC}"
    fi
  done

  if [ "$seq_fail" = "0" ]; then
    ok "All 6 sequential connections succeeded"
  else
    fail "$seq_fail/6 sequential connections failed"
  fi
else
  warn "No machines configured, skipping"
fi

# ─── 6. Test with jump hosts disabled (direct connection) ────

log "6. Testing direct connection (jump hosts disabled)..."

if [ -n "$machine_id" ]; then
  api PATCH /api/jumphosts/enabled -d '{"enabled":false}' > /dev/null
  direct=$(api POST "/api/machines/$machine_id/test")
  direct_ok=$(echo "$direct" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)

  if [ "$direct_ok" = "True" ]; then
    ok "Direct connection works (bypass jump host)"
  else
    # Expected to fail if target is only reachable via jump host
    warn "Direct connection failed (expected if target requires jump host)"
  fi

  # Restore
  api PATCH /api/jumphosts/enabled -d '{"enabled":true}' > /dev/null
else
  warn "No machines configured, skipping"
fi

# ─── 7. Test chain after re-enable ──────────────────────────

log "7. Verifying chain still works after toggle cycle..."
result=$(api POST /api/jumphosts/test)
final_ok=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)
if [ "$final_ok" = "True" ]; then
  ok "Chain works after re-enable"
else
  fail "Chain broken after re-enable"
fi

# ─── Summary ─────────────────────────────────────────────────

echo ""
echo -e "═══════════════════════════════════════"
echo -e " ${GREEN}PASS: $pass${NC}  ${RED}FAIL: $fail${NC}  ${YELLOW}SKIP: $skip${NC}"
echo -e "═══════════════════════════════════════"

[ "$fail" = "0" ] && exit 0 || exit 1
