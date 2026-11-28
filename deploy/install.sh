#!/bin/sh
# Install or upgrade the Crashpad GitHub App service on a Linux host with systemd.
# Run as root on the host:
#   sudo sh install.sh ./crashpad-<version>.tgz ./service.env ./app.private-key.pem
# Re-running it upgrades the package and keeps the existing state (/var/lib/crashpad).
set -eu
PKG="${1:?usage: install.sh <crashpad .tgz> <service.env> <app.private-key.pem>}"
ENVFILE="${2:?usage: install.sh <crashpad .tgz> <service.env> <app.private-key.pem>}"
KEY="${3:?usage: install.sh <crashpad .tgz> <service.env> <app.private-key.pem>}"
HERE=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo "install.sh: run as root (sudo)" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "install.sh: systemd is required" >&2; exit 1; }
command -v node >/dev/null || { echo "install.sh: Node.js 22.18 or later is required (https://nodejs.org)" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' || { echo "install.sh: Node.js $(node -v) is too old; 22.18 or later is required" >&2; exit 1; }
for f in "$PKG" "$ENVFILE" "$KEY"; do [ -f "$f" ] || { echo "install.sh: $f not found" >&2; exit 1; }; done

id crashpad >/dev/null 2>&1 || useradd --system --home-dir /var/lib/crashpad --shell /usr/sbin/nologin crashpad
npm install -g --no-audit --no-fund "$PKG"
command -v crashpad >/dev/null || { echo "install.sh: crashpad is not on PATH after npm install -g" >&2; exit 1; }

install -d -m 700 -o crashpad -g crashpad /etc/crashpad /var/lib/crashpad /var/lib/crashpad/backups
install -m 600 -o crashpad -g crashpad "$ENVFILE" /etc/crashpad/service.env
install -m 600 -o crashpad -g crashpad "$KEY" /etc/crashpad/app.private-key.pem
install -d -m 755 /usr/local/lib/crashpad
install -m 755 "$HERE/backup.sh" /usr/local/lib/crashpad/backup.sh
install -m 644 "$HERE/crashpad.service" "$HERE/crashpad-backup.service" "$HERE/crashpad-backup.timer" /etc/systemd/system/

# Validate exactly as the service will run.
if ! su -s /bin/sh crashpad -c 'set -a; . /etc/crashpad/service.env; set +a; crashpad service check'; then
  echo "install.sh: the configuration is invalid; fix /etc/crashpad/service.env and re-run" >&2
  exit 1
fi
systemctl daemon-reload
systemctl enable --now crashpad-backup.timer
systemctl enable crashpad.service
systemctl restart crashpad.service
sleep 2
systemctl --no-pager --lines=5 status crashpad.service || true
curl -fsS http://127.0.0.1:8787/healthz && echo
echo "Installed. Next: point DNS at this host, install Caddy with deploy/Caddyfile, then run deploy/healthcheck.sh https://<host>."
