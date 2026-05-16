#!/bin/bash
# Prod smoke for canonical-counts using curl (Node's fetch flakes on
# some networks; curl is rock-solid). Mints JWTs with prod AUTH_SECRET
# from .env.local, hits every migrated route for admin + each rep,
# verifies the cross-surface totals all agree.
#
# Run: ./scripts/_smoke-prod-canonical-counts.sh
set -e

SECRET=$(grep '^AUTH_SECRET' /Users/xingzewang/Desktop/mail/.env.local | head -1 | cut -d= -f2- | tr -d '"')
if [[ -z "$SECRET" ]]; then echo "no AUTH_SECRET"; exit 1; fi
# BASE defaults to the prod alias but can be overridden when the custom
# domain is unreachable from a developer network (use the immutable
# preview URL of the same deployment instead — same code, same DB).
BASE="${BASE:-https://calistamind.com}"
echo "Smoking $BASE"

mint() {  # mint <repId> <role> <name>
  node -e "
import('jose').then(async ({SignJWT}) => {
  const secret = new TextEncoder().encode('$SECRET');
  const t = await new SignJWT({ repId: $1, role: '$2', repName: '$3', email: 'smoke@e.com' }).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(secret);
  console.log(t);
});
" 2>&1 | tail -1
}

hit() {  # hit <token> <path> <dot.path>
  local tok="$1" path="$2" dotpath="$3"
  for attempt in 1 2 3; do
    body=$(curl -s --max-time 60 "$BASE$path" -H "cookie: qiji_session=$tok" 2>/dev/null)
    if [[ -n "$body" ]] && echo "$body" | jq -e . >/dev/null 2>&1; then
      echo "$body" | jq -r ".$dotpath // \"NULL\""
      return 0
    fi
    sleep 1
  done
  echo "FETCH_FAIL"
}

ADMIN=$(mint 5 admin Admin)
YUJIE=$(mint 2 sales Yujie)
LEO=$(mint 1 sales Leo)
ETHAN=$(mint 3 sales Ethan)
JINYANG=$(mint 10 sales Jinyang)
XINGZE=$(mint 5 sales Xingze)
XUWEN=$(mint 7 sales Xuwen)
ZEQUN=$(mint 11 sales Zequn)

echo
echo "=== [Admin scope] global ==="
A_PIPE_TOTAL=$(hit "$ADMIN" "/api/pipeline?limit=1000" total)
A_ANALYTICS_TOTAL=$(hit "$ADMIN" "/api/pipeline/analytics" channels.totalLeads)
A_METRICS_TOTAL=$(hit "$ADMIN" "/api/metrics" pipeline.total)
A_METRICS_READY=$(hit "$ADMIN" "/api/metrics" pipeline.ready)
A_READY_COUNT=$(hit "$ADMIN" "/api/pipeline/ready-count" count)
A_READY_NOW=$(hit "$ADMIN" "/api/pipeline/ready-count" readyNow)
A_READY_RIPENING=$(hit "$ADMIN" "/api/pipeline/ready-count" ripening)
A_UNREAD=$(hit "$ADMIN" "/api/inbox/unread-count" count)
echo "  pipeline.total: $A_PIPE_TOTAL"
echo "  analytics.totalLeads: $A_ANALYTICS_TOTAL"
echo "  metrics.pipeline.total: $A_METRICS_TOTAL"
echo "  metrics.pipeline.ready: $A_METRICS_READY"
echo "  ready-count.count: $A_READY_COUNT  (now=$A_READY_NOW + ripening=$A_READY_RIPENING)"
echo "  inbox unread (global): $A_UNREAD"

FAIL=0
chk() { if [[ "$2" != "$3" ]]; then echo "  ✗ $1: $2 != $3"; FAIL=$((FAIL+1)); else echo "  ✓ $1: $2 == $3"; fi }
chk "pipeline.total == analytics.totalLeads" "$A_PIPE_TOTAL" "$A_ANALYTICS_TOTAL"
chk "pipeline.total == metrics.pipeline.total" "$A_PIPE_TOTAL" "$A_METRICS_TOTAL"
chk "metrics.pipeline.ready == ready-count.count" "$A_METRICS_READY" "$A_READY_COUNT"
SUM=$((A_READY_NOW + A_READY_RIPENING))
chk "readyNow + ripening == count" "$SUM" "$A_READY_COUNT"

echo
echo "=== [Yujie scope] ==="
Y_PIPE=$(hit "$YUJIE" "/api/pipeline?limit=1000" total)
Y_ANALYTICS=$(hit "$YUJIE" "/api/pipeline/analytics" channels.totalLeads)
Y_ME_ASSIGNED=$(hit "$YUJIE" "/api/metrics/me" assigned)
Y_ME_READY=$(hit "$YUJIE" "/api/metrics/me" ready)
Y_READY=$(hit "$YUJIE" "/api/pipeline/ready-count" count)
Y_UNREAD=$(hit "$YUJIE" "/api/inbox/unread-count" count)
echo "  pipeline.total: $Y_PIPE | analytics: $Y_ANALYTICS | me.assigned: $Y_ME_ASSIGNED"
echo "  me.ready: $Y_ME_READY | ready-count: $Y_READY | unread: $Y_UNREAD"
chk "Yujie pipeline.total == analytics.totalLeads" "$Y_PIPE" "$Y_ANALYTICS"
chk "Yujie pipeline.total == me.assigned" "$Y_PIPE" "$Y_ME_ASSIGNED"
chk "Yujie me.ready == ready-count" "$Y_ME_READY" "$Y_READY"

echo
echo "=== [Per-rep .assigned must sum to ≤ global] ==="
SUM_ASSIGNED=0
for tok_name in "$LEO:Leo" "$YUJIE:Yujie" "$ETHAN:Ethan" "$JINYANG:Jinyang" "$XUWEN:Xuwen" "$ZEQUN:Zequn"; do
  TOK="${tok_name%:*}"; NAME="${tok_name##*:}"
  N=$(hit "$TOK" "/api/metrics/me" assigned)
  echo "  $NAME: $N"
  if [[ "$N" =~ ^[0-9]+$ ]]; then SUM_ASSIGNED=$((SUM_ASSIGNED + N)); fi
done
echo "  per-rep sum: $SUM_ASSIGNED | global: $A_PIPE_TOTAL"
if (( SUM_ASSIGNED <= A_PIPE_TOTAL )); then
  echo "  ✓ per-rep sum <= global (gap is unassigned pool: $((A_PIPE_TOTAL - SUM_ASSIGNED)))"
else
  echo "  ✗ per-rep sum > global — counts diverge"; FAIL=$((FAIL+1))
fi

echo
if [[ $FAIL -eq 0 ]]; then echo "✓ ALL CANONICAL SURFACES AGREE IN PROD"; exit 0;
else echo "✗ $FAIL prod disagreements — investigate"; exit 1; fi
