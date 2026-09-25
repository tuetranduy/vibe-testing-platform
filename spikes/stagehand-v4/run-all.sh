#!/usr/bin/env bash
# Runs every spike script and stores its observed output in output/qN.txt
set -u
cd "$(dirname "$0")"
mkdir -p output
for q in q1 q2 q3 q4 q5 q6 q7 q7-telemetry q7-loopback q8; do
  echo "--- $q"
  NODE_NO_WARNINGS=1 timeout 120 npx tsx "$q.ts" > "output/$q.txt" 2>&1
  echo "exit=$?" | tee -a "output/$q.txt"
done
