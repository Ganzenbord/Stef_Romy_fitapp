#!/bin/bash
# Zet HTTPS aan via Tailscale-certificaten.
# Eenmalig uitvoeren; daarna werkt de app via https://
cd "$(dirname "$0")"

HOSTNAME=$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Self']['DNSName'].rstrip('.'))" 2>/dev/null)
if [ -z "$HOSTNAME" ]; then
  echo "❌ Tailscale niet actief of hostname niet gevonden."
  echo "   Zorg dat Tailscale aan staat en probeer opnieuw."
  read -p "Druk Enter om te sluiten..."
  exit 1
fi

echo "Hostname: $HOSTNAME"
echo "Certificaat aanvragen bij Tailscale..."
tailscale cert "$HOSTNAME"

CERT="${HOSTNAME}.crt"
KEY="${HOSTNAME}.key"

if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "❌ Certificaat-bestanden niet gevonden. Controleer of Tailscale toestemming heeft."
  read -p "Druk Enter om te sluiten..."
  exit 1
fi

# Schrijf paden naar .env (voeg toe of vervang bestaande regels)
ENV_FILE=".env"
touch "$ENV_FILE"
grep -v "^HTTPS_CERT=\|^HTTPS_KEY=\|^HOST=" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
echo "HTTPS_CERT=$(pwd)/$CERT" >> "$ENV_FILE"
echo "HTTPS_KEY=$(pwd)/$KEY"   >> "$ENV_FILE"
echo "HOST=0.0.0.0"            >> "$ENV_FILE"

echo ""
echo "✅ HTTPS ingesteld voor $HOSTNAME"
echo "   Herstart de server via restart.command."
echo "   Open daarna: https://$HOSTNAME:3000"
echo ""
read -p "Druk Enter om te sluiten..."
