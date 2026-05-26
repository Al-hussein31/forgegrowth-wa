#!/bin/bash
# schedule_dm_sender.sh
# Reads today's campaign schedule and sends at each scheduled time.
# Uses persistent WhatsApp session (no QR needed after first auth).

WA_DIR="$HOME/Desktop/forgegrowth-wa"
LOG_FILE="$WA_DIR/schedule_dm_sender.log"

exec >> "$LOG_FILE" 2>&1
echo ""
echo "=== Schedule started at $(date) ==="

cd "$WA_DIR" || { echo "FATAL: Could not cd to $WA_DIR"; exit 1; }

# Read today's scheduled send times from the campaign
node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('dm_campaign.json','utf8'));
const today = new Date().toISOString().split('T')[0];
const times = [...new Set(c.schedule.filter(s => s.sendAt.startsWith(today)).map(s => s.sendAt))].sort();
times.forEach(t => console.log(new Date(t).getTime())); // epoch ms
" > /tmp/campaign_times.txt 2>&1

if [ ! -s /tmp/campaign_times.txt ]; then
    echo "No messages scheduled for today."
    exit 0
fi

SCHEDULE=()
while IFS= read -r line; do
    SCHEDULE+=("$line")
done < /tmp/campaign_times.txt

echo "Today's schedule (epoch ms): ${SCHEDULE[*]}"

for TARGET_EPOCH_MS in "${SCHEDULE[@]}"; do
    TARGET_SEC=$(( TARGET_EPOCH_MS / 1000 ))
    NOW_SEC=$(date +%s)
    SLEEP_DUR=$(( TARGET_SEC - NOW_SEC ))

    if [ "$SLEEP_DUR" -le 0 ]; then
        echo "Skipping $(date -j -f %s "$TARGET_SEC" '+%H:%M') — already passed"
        continue
    fi

    echo "Next send at $(date -j -f %s "$TARGET_SEC" '+%H:%M'), sleeping ${SLEEP_DUR}s..."
    sleep "$SLEEP_DUR"

    echo "=== Running dm_sender at $(date '+%H:%M:%S') ==="
    node dm_sender.js
    echo "=== dm_sender finished at $(date '+%H:%M:%S') ==="
done

echo "=== All scheduled sends completed at $(date) ==="
