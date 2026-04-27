#!/bin/bash
# Drain ~700 remaining single-author rows by re-running backfill-authors.mjs
# until it reports "updated: 0" (or 5 consecutive runs that update nothing,
# meaning we hit the irretrievable rows).
cd /Users/xingzewang/Desktop/mail
zero_runs=0
total=0
for i in $(seq 1 20); do
  echo "=== drain pass $i ==="
  out=$(node scripts/backfill-authors.mjs 2>&1 | tail -8)
  echo "$out"
  updated=$(echo "$out" | grep -oE 'updated: [0-9]+' | grep -oE '[0-9]+' | head -1)
  total=$((total + updated))
  if [ "$updated" = "0" ]; then
    zero_runs=$((zero_runs + 1))
    if [ $zero_runs -ge 2 ]; then echo "two consecutive zero-update runs, stopping."; break; fi
  else
    zero_runs=0
  fi
  echo "  cumulative updated: $total"
done
echo "DRAIN COMPLETE: $total rows updated total"
