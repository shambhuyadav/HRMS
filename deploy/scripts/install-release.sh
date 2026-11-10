#!/usr/bin/env bash
# Installs a release tarball (deploy/scripts/package-release.sh) on the server, into the one HRMS folder, /var/www/html/HRMS:
#   apps/ db/ deploy/ node_modules/ package.json …   the project itself (the API and the worker run from here)
#   public/                                         the web app's built files: the only part nginx serves
#   config, uploads, backups                        links to where settings, uploaded files and backups are kept (setup-server.sh)
# The new release is prepared beside it in .next/ (unpacked, dependencies installed as the unprivileged deploying user, migrations
# applied from it as the hrms service account); only then are the project folders swapped (the ones replaced go to .previous/, for a
# rollback) and the services restarted. If any step before the swap fails, the running version is untouched.
# The project belongs to the administrators' login (ubuntu) and the hrms group; others, including nginx's own account, cannot read it,
# so even a web server misconfigured to serve all of /var/www/html could not hand out the source.
#   sudo bash install-release.sh /tmp/hrms-release-<time>.tgz
set -euo pipefail
TARBALL="$(realpath "${1:?Give the release tarball}")"
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
BUILD_USER="${SUDO_USER:-ubuntu}"
[ "$BUILD_USER" != root ] || BUILD_USER=ubuntu
APP=/var/www/html/HRMS
NEXT="$APP/.next"
PREV="$APP/.previous"
log() { printf '\n== %s\n' "$*"; }

install -d -o root -g root -m 0755 /var/www/html "$APP"
log "Unpacking into $NEXT"
rm -rf "$NEXT"
install -d -o "$BUILD_USER" -m 0750 "$NEXT"
sudo -u "$BUILD_USER" tar -xzf "$TARBALL" -C "$NEXT"
cat "$NEXT/RELEASE"

if [ -f "$NEXT/apps/web/dist/index.html" ]; then
  log "Dependencies (as $BUILD_USER; the web app came built in the release)"
  sudo -u "$BUILD_USER" -H bash -c "cd '$NEXT' && npm ci --no-audit --no-fund --loglevel=error"
else
  log "Dependencies and the web app build (as $BUILD_USER)"
  sudo -u "$BUILD_USER" -H bash -c "cd '$NEXT' && npm ci --no-audit --no-fund --loglevel=error && npm run build -w apps/web"
fi
test -f "$NEXT/apps/web/dist/index.html"
chown -R "$BUILD_USER:hrms" "$NEXT"
chmod -R u=rwX,g=rX,o= "$NEXT"

log "Database migrations"
systemd-run --quiet --wait --pipe --collect --uid=hrms --gid=hrms \
  -p EnvironmentFile=/etc/hrms/hrms.env -p PrivateTmp=true -E NODE_ENV=production \
  --working-directory="$NEXT" "$NEXT/node_modules/.bin/tsx" db/migrate.ts

log "Switching and restarting"
# The web app's files, prepared beside public/.
rm -rf "$APP/public.new"
cp -a "$NEXT/apps/web/dist" "$APP/public.new"
chown -R root:root "$APP/public.new"
chmod -R u=rwX,go=rX "$APP/public.new"
# The project folders: each one replaced is kept in .previous/.
rm -rf "$PREV"
install -d -o "$BUILD_USER" -g hrms -m 0750 "$PREV"
for item in "$NEXT"/* "$NEXT"/.[!.]*; do
  [ -e "$item" ] || continue
  name="$(basename "$item")"
  if [ -e "$APP/$name" ]; then mv "$APP/$name" "$PREV/$name"; fi
  mv "$item" "$APP/$name"
done
rmdir "$NEXT"
if [ -d "$APP/public" ]; then mv "$APP/public" "$PREV/public"; fi
mv "$APP/public.new" "$APP/public"
# The services as this release describes them (where they run from); Keycloak's unit stays with setup-server.sh (a restart is slow).
for unit in hrms-api.service hrms-worker.service hrms-backup.service hrms-backup.timer; do
  install -m 0644 "$APP/deploy/systemd/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl restart hrms-api hrms-worker
for i in $(seq 1 60); do
  curl -fsS -o /dev/null http://127.0.0.1:3000/ready && break
  [ "$i" -eq 60 ] && { journalctl -u hrms-api -n 60 --no-pager; echo "The API did not become ready" >&2; exit 1; }
  sleep 3
done
mode="$(curl -fsS http://127.0.0.1:3000/sign-in/config | jq -r .mode)"
[ "$mode" = OIDC ] || { echo "The API offers sign-in mode '$mode', expected OIDC" >&2; exit 1; }
sleep 5
systemctl is-active --quiet hrms-worker || { journalctl -u hrms-worker -n 60 --no-pager; echo "The worker is not running" >&2; exit 1; }
systemctl reload nginx
curl -fsS --cacert /etc/hrms/tls/hrms.crt -o /dev/null https://127.0.0.1/ && curl -fsS --cacert /etc/hrms/tls/hrms.crt -o /dev/null https://127.0.0.1/ready
echo "Release $(sed -n 's/^packaged_at=//p' "$APP/RELEASE") is live in $APP."

# Earlier layouts, removed once this one is live: code in /opt/hrms; releases/ + current in this folder.
if [ -d /opt/hrms ]; then echo "removing the earlier /opt/hrms"; rm -rf /opt/hrms; fi
if [ -L "$APP/current" ]; then rm -f "$APP/current"; fi
if [ -d "$APP/releases" ]; then echo "removing the earlier $APP/releases"; rm -rf "$APP/releases"; fi
rm -rf "$APP/assets" "$APP/index.html"
