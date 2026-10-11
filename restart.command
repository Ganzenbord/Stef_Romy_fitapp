#!/bin/bash
cd "$(dirname "$0")"

# 1. Stuur SIGTERM zodat de server de database netjes afsluit (WAL checkpoint)
echo "=== server stoppen (graceful) ==="
pkill -SIGTERM -f 'node.*server.js' 2>/dev/null
sleep 3   # wacht tot de server de db heeft afgesloten

# 2. Backup van de database vóór elke herstart (bewaar laatste 5)
DB="data/health.db"
if [ -f "$DB" ]; then
  BACKUP_DIR="data/backups"
  mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d_%H%M%S)
  cp "$DB" "$BACKUP_DIR/health_${STAMP}.db"
  echo "Backup: $BACKUP_DIR/health_${STAMP}.db"
  # Verwijder backups ouder dan de laatste 5
  ls -t "$BACKUP_DIR"/health_*.db 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null
fi

# 3. Dependencies installeren
echo "=== npm install ==="
npm install

# 4. Server starten
echo "=== server starten ==="
node server.js
