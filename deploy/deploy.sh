#!/usr/bin/env bash
# Fit: installatie en updates op een Debian/Ubuntu-VPS (apt + systemd).
#
#   sudo bash deploy.sh install fit.jouwdomein.nl jouw@email.nl
#   sudo bash deploy.sh update
#
# Voorwaarde voor 'install': het domein (A-record) wijst al naar het IP van deze VPS.
# Lees dit script eerst, het draait als root.
set -euo pipefail

REPO_URL="https://github.com/Ganzenbord/Stef_Romy_fitapp.git"
APP_DIR="/opt/fit"
DATA_DIR="/var/lib/fit"
BACKUP_DIR="/var/backups/fit"
ENV_FILE="/etc/fit.env"
SERVICE_USER="fit"
PORT="3000"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'FOUT: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Draai dit met sudo."
command -v apt-get >/dev/null 2>&1 || die "Alleen Debian/Ubuntu (apt) wordt ondersteund."

install_packages() {
  say "Basispakketten installeren"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl git ca-certificates gnupg openssl iproute2 >/dev/null
}

install_node() {
  local major=0
  if command -v node >/dev/null 2>&1; then major="$(node -p 'process.versions.node.split(".")[0]')"; fi
  if [ "$major" -ge 20 ]; then
    say "Node $(node -v) is al aanwezig"
    return
  fi
  say "Node 22 installeren (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  say "Node $(node -v) geïnstalleerd"
}

create_user_and_dirs() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    say "Systeemgebruiker '$SERVICE_USER' aanmaken"
    useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  mkdir -p "$DATA_DIR" "$BACKUP_DIR"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
  chmod 700 "$DATA_DIR" "$BACKUP_DIR"
}

fetch_code() {
  if [ -d "$APP_DIR/.git" ]; then
    say "Code bijwerken"
    git -C "$APP_DIR" pull --ff-only --quiet
  else
    say "Code ophalen"
    git clone --quiet "$REPO_URL" "$APP_DIR"
  fi
}

npm_install() {
  say "Afhankelijkheden installeren"
  # De code is eigendom van root en alleen leesbaar voor de service-gebruiker.
  if ! (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1); then
    say "Installatie mislukte, bouwgereedschap toevoegen en opnieuw proberen"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential python3 >/dev/null
    (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
  fi
}

write_env() {
  local email="$1"
  if [ -f "$ENV_FILE" ]; then
    say "$ENV_FILE bestaat al, ongewijzigd gelaten"
    return
  fi
  say "$ENV_FILE aanmaken"
  (
    umask 077
    cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=$DATA_DIR
OFF_CONTACT_EMAIL=$email
SETUP_KEY=$(openssl rand -hex 12)
EOF
  )
  chmod 600 "$ENV_FILE"
}

write_service() {
  say "systemd-service aanmaken"
  cat > /etc/systemd/system/fit.service <<EOF
[Unit]
Description=Fit
After=network.target

[Service]
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable fit >/dev/null 2>&1
}

write_backup() {
  say "Dagelijkse back-up instellen (03:15, 14 dagen bewaard)"
  cat > /usr/local/bin/fit-backup <<'EOF'
#!/usr/bin/env bash
# Het env-bestand wordt bewust niet "gesourcet": alleen DATA_DIR wordt eruit gelezen.
set -euo pipefail
DATA_DIR="$(grep '^DATA_DIR=' /etc/fit.env | cut -d= -f2-)"
DEST=/var/backups/fit
STAMP="$(date +%F)"
mkdir -p "$DEST"
# Veilige online-kopie van de database (werkt terwijl de app draait), via de bibliotheek van de app zelf.
node -e "const D=require('/opt/fit/node_modules/better-sqlite3');const db=new D(process.argv[1]);db.backup(process.argv[2]).then(()=>db.close()).catch(e=>{console.error(e);process.exit(1)})" "$DATA_DIR/health.db" "$DEST/health-$STAMP.db"
tar -czf "$DEST/photos-$STAMP.tgz" -C "$DATA_DIR" photos
find "$DEST" -type f -mtime +14 -delete
EOF
  chmod 700 /usr/local/bin/fit-backup
  echo '15 3 * * * root /usr/local/bin/fit-backup' > /etc/cron.d/fit-backup
  chmod 644 /etc/cron.d/fit-backup
}

port_in_use() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }

setup_proxy() {
  local domain="$1"
  if port_in_use 80 || port_in_use 443; then
    say "Poort 80/443 is al in gebruik door een andere webserver. Die raak ik niet aan."
    echo "Voeg zelf een reverse proxy naar 127.0.0.1:$PORT toe. Voorbeeld voor nginx:"
    sed "s/DOMAIN/$domain/" <<'EOF'

    server {
        server_name DOMAIN;
        client_max_body_size 10m;
        location / {
            proxy_pass http://127.0.0.1:3000;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }

Daarna: certbot --nginx -d DOMAIN
EOF
    PROXY_DONE="handmatig"
    return
  fi
  if ! command -v caddy >/dev/null 2>&1; then
    say "Caddy installeren"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null
  fi
  say "Caddy instellen voor $domain (HTTPS automatisch)"
  cat > /etc/caddy/Caddyfile <<EOF
$domain {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  systemctl enable caddy >/dev/null 2>&1
  systemctl restart caddy
  PROXY_DONE="caddy"
}

health_check() {
  say "Controleren of de app draait"
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
      echo "App draait op 127.0.0.1:$PORT"
      return
    fi
    sleep 0.5
  done
  journalctl -u fit -n 30 --no-pager || true
  die "De app start niet. Zie de log hierboven."
}

case "${1:-}" in
  install)
    [ "$#" -eq 3 ] || die "Gebruik: sudo bash deploy.sh install <domein> <e-mailadres>"
    DOMAIN="$2"; EMAIL="$3"
    [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "Ongeldig domein: $DOMAIN"
    [[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "Ongeldig e-mailadres: $EMAIL"
    PROXY_DONE=""
    install_packages
    install_node
    create_user_and_dirs
    fetch_code
    npm_install
    write_env "$EMAIL"
    write_service
    write_backup
    systemctl restart fit
    health_check
    setup_proxy "$DOMAIN"
    SETUP_KEY="$(grep '^SETUP_KEY=' "$ENV_FILE" | cut -d= -f2)"
    say "Klaar"
    echo "Adres:          https://$DOMAIN  (proxy: $PROXY_DONE)"
    echo "Setup-sleutel:  $SETUP_KEY  (alleen nodig voor de allereerste registratie)"
    echo "Back-ups:       $BACKUP_DIR (dagelijks). Kopieer ze ook naar een andere plek buiten deze VPS."
    echo "Logs:           journalctl -u fit -f"
    echo "Bijwerken:      sudo bash $APP_DIR/deploy/deploy.sh update"
    ;;
  update)
    [ -d "$APP_DIR/.git" ] || die "Niet geïnstalleerd. Draai eerst 'install'."
    fetch_code
    npm_install
    systemctl restart fit
    health_check
    say "Bijgewerkt"
    ;;
  *)
    die "Gebruik: sudo bash deploy.sh install <domein> <e-mailadres>   of   sudo bash deploy.sh update"
    ;;
esac
