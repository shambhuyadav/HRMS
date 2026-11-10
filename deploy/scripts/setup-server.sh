#!/usr/bin/env bash
# First-time (and repeatable) setup of an Ubuntu 22.04/24.04 server for HRMS: packages, the database, the sign-in provider (Keycloak),
# the malware scanner (ClamAV), a self-signed TLS certificate for the server's address, nginx, the service account and the systemd units.
# Idempotent: secrets and certificates that already exist are kept; run it again after changing this script.
#
#   sudo PUBLIC_HOST=92.4.83.167 bash deploy/scripts/setup-server.sh
#
# Run from an unpacked release (the deploy/ directory next to this script is read). It writes:
#   /etc/hrms/hrms.env            the API's and worker's environment (root:hrms 0640)
#   /etc/hrms/keycloak.env        Keycloak's environment, including its first administrator's password (root 0600)
#   /etc/hrms/tls/                the self-signed certificate (replace it with a CA-issued one once a domain name exists)
#   /var/lib/hrms/files           uploaded files (back these up with the database)
set -euo pipefail

PUBLIC_HOST="${PUBLIC_HOST:?Set PUBLIC_HOST to the address users will open, e.g. 92.4.83.167}"
PUBLIC_ORIGIN="https://${PUBLIC_HOST}"
KEYCLOAK_IMAGE="${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.8.2}"
NODE_MAJOR="${NODE_MAJOR:-24}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # deploy/

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
. /etc/os-release
case "${VERSION_ID}" in 22.04|24.04) ;; *) echo "Tested on Ubuntu 22.04 and 24.04; this is ${PRETTY_NAME}." >&2 ;; esac
log() { printf '\n== %s\n' "$*"; }
rand_hex() { openssl rand -hex "$1"; }
rand_b64() { openssl rand -base64 "$1" | tr -d '\n'; }

export DEBIAN_FRONTEND=noninteractive
MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
SMALL=no
[ "${MEM_MB}" -lt 3000 ] && SMALL=yes

if [ "${SMALL}" = yes ]; then
  # Under 3 GB of memory (e.g. a 1 GB trial server): the services fit only with swap. Slow, but it runs until the server is upgraded.
  log "Small server (${MEM_MB} MB): swap file"
  if ! swapon --show=NAME --noheadings | grep -q .; then
    fallocate -l "${SWAP_SIZE:-4G}" /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
  fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  swapon --show
fi

log "Packages"
apt-get update -q
apt-get install -y -q acl ca-certificates curl gnupg jq openssl nginx clamav-daemon clamav-freshclam docker.io postgresql-common unattended-upgrades

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "${NODE_MAJOR}" ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
node -v

if ! apt-cache show postgresql-16 >/dev/null 2>&1; then
  # Ubuntu 22.04 ships PostgreSQL 14; the HRMS is built and tested on 16+.
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
fi
apt-get install -y -q postgresql-16
if [ "${SMALL}" = yes ]; then
  cat > /etc/postgresql/16/main/conf.d/hrms-small-server.conf <<'EOF'
# Written by deploy/scripts/setup-server.sh for a server under 3 GB of memory; delete it after upgrading the server.
shared_buffers = 64MB
effective_cache_size = 256MB
work_mem = 4MB
maintenance_work_mem = 32MB
max_connections = 40
EOF
else
  rm -f /etc/postgresql/16/main/conf.d/hrms-small-server.conf
fi
systemctl enable postgresql
systemctl restart postgresql

log "Service account and directories"
id -u hrms >/dev/null 2>&1 || useradd --system --home-dir /var/lib/hrms --shell /usr/sbin/nologin hrms
# The administrators' login may read the code, settings and uploads (it can sudo anyway); nginx's own account may not.
ADMIN_LOGIN="${SUDO_USER:-ubuntu}"
if [ "${ADMIN_LOGIN}" != root ] && id -u "${ADMIN_LOGIN}" >/dev/null 2>&1; then usermod -aG hrms "${ADMIN_LOGIN}"; fi
# The one HRMS folder: the project (apps/, db/, deploy/, node_modules/ …; install-release.sh puts it there, owned by the
# administrators' login and the hrms group, not world-readable), public/ (the only part nginx serves), and links to where settings,
# uploads and backups are kept with their own permissions.
APP=/var/www/html/HRMS
install -d -o root -g root -m 0755 /var/www/html "${APP}" "${APP}/public"
install -d -o root -g hrms -m 0750 /etc/hrms
install -d -o root -g root -m 0700 /etc/hrms/tls
install -d -o root -g root -m 0755 /etc/hrms/keycloak-import
install -d -o hrms -g hrms -m 0750 /var/lib/hrms /var/lib/hrms/files
install -d -o root -g root -m 0700 /var/backups/hrms
ln -sfn /etc/hrms "${APP}/config"
ln -sfn /var/lib/hrms/files "${APP}/uploads"
ln -sfn /var/backups/hrms "${APP}/backups"
# The administrators' login opens these by its own name (an ACL), so it works in a session opened before it joined the hrms group;
# files keep their own limits (secrets.env, keycloak.env, the TLS key and the backup files stay root only).
grant_admin() {   # directory
  [ "${ADMIN_LOGIN}" != root ] && id -u "${ADMIN_LOGIN}" >/dev/null 2>&1 || return 0
  setfacl -m "u:${ADMIN_LOGIN}:rX" "$1"
  setfacl -d -m "u:${ADMIN_LOGIN}:rX" "$1"
}
grant_admin /etc/hrms
grant_admin /var/lib/hrms
grant_admin /var/lib/hrms/files
grant_admin /var/backups/hrms
if [ "${ADMIN_LOGIN}" != root ] && id -u "${ADMIN_LOGIN}" >/dev/null 2>&1; then
  find /var/lib/hrms/files -mindepth 1 -exec setfacl -m "u:${ADMIN_LOGIN}:rX" {} +
fi

log "Secrets (kept when they exist)"
if [ ! -f /etc/hrms/secrets.env ]; then
  umask 077
  cat > /etc/hrms/secrets.env <<EOF
HRMS_DB_PASSWORD=$(rand_hex 24)
KEYCLOAK_DB_PASSWORD=$(rand_hex 24)
KEYCLOAK_ADMIN_PASSWORD=$(rand_hex 20)
SESSION_TOKEN_SECRET=$(rand_b64 48)
HRMS_FIELD_KEYS=k1:$(rand_b64 32)
HRMS_CANDIDATE_IDENTITY_KEY=$(rand_b64 32)
EOF
  umask 022
fi
if [ "${ROTATE_DB_PASSWORDS:-no}" = yes ]; then
  # New database passwords (e.g. after one was exposed): generated and written here, never shown or put on a command line.
  umask 077
  new_hrms="$(rand_hex 24)"
  new_kc="$(rand_hex 24)"
  grep -vE '^(HRMS_DB_PASSWORD|KEYCLOAK_DB_PASSWORD)=' /etc/hrms/secrets.env > /etc/hrms/secrets.env.new
  printf 'HRMS_DB_PASSWORD=%s\nKEYCLOAK_DB_PASSWORD=%s\n' "$new_hrms" "$new_kc" >> /etc/hrms/secrets.env.new
  mv /etc/hrms/secrets.env.new /etc/hrms/secrets.env
  unset new_hrms new_kc
  umask 022
  echo "Database passwords replaced"
fi
chown root:root /etc/hrms/secrets.env
chmod 0600 /etc/hrms/secrets.env
# shellcheck disable=SC1091
. /etc/hrms/secrets.env

log "PostgreSQL roles and databases"
# Passwords go in on standard input, never on a command line (sudo would log it; ps would show it).
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q <<SQL
\\set hrms_pw '${HRMS_DB_PASSWORD}'
\\set kc_pw '${KEYCLOAK_DB_PASSWORD}'
select format('create role hrms login password %L', :'hrms_pw') where not exists (select from pg_roles where rolname = 'hrms') \\gexec
select format('alter role hrms login password %L', :'hrms_pw') \\gexec
select format('create role keycloak login password %L', :'kc_pw') where not exists (select from pg_roles where rolname = 'keycloak') \\gexec
select format('alter role keycloak login password %L', :'kc_pw') \\gexec
select 'create database hrms owner hrms' where not exists (select from pg_database where datname = 'hrms') \\gexec
select 'create database keycloak owner keycloak' where not exists (select from pg_database where datname = 'keycloak') \\gexec
SQL
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q -d hrms -c 'create extension if not exists btree_gist'
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q -d hrms -c 'revoke create on schema public from public'

log "Malware scanner (ClamAV)"
systemctl enable --now clamav-freshclam
for i in $(seq 1 240); do
  [ -e /var/lib/clamav/main.cvd ] || [ -e /var/lib/clamav/main.cld ] && { [ -e /var/lib/clamav/daily.cvd ] || [ -e /var/lib/clamav/daily.cld ]; } && break
  [ "$i" -eq 1 ] && echo "Waiting for the first signature download…"
  sleep 5
done
if [ "${SMALL}" = yes ]; then
  # Reloading the signatures beside the loaded ones needs twice the memory; on a small server scans pause during a reload instead.
  if grep -q '^ConcurrentDatabaseReload' /etc/clamav/clamd.conf; then
    sed -i 's/^ConcurrentDatabaseReload.*/ConcurrentDatabaseReload no/' /etc/clamav/clamd.conf
  else
    echo 'ConcurrentDatabaseReload no' >> /etc/clamav/clamd.conf
  fi
fi
systemctl enable clamav-daemon
systemctl restart clamav-daemon
CLAMD_SOCKET="$(awk '$1 == "LocalSocket" {print $2}' /etc/clamav/clamd.conf)"
CLAMD_SOCKET="${CLAMD_SOCKET:-/var/run/clamav/clamd.ctl}"

log "TLS certificate for ${PUBLIC_HOST} (self-signed)"
if [ ! -f /etc/hrms/tls/hrms.crt ] || ! openssl x509 -in /etc/hrms/tls/hrms.crt -noout -ext subjectAltName 2>/dev/null | grep -q "${PUBLIC_HOST}"; then
  if [[ "${PUBLIC_HOST}" =~ ^[0-9.]+$ ]]; then SAN="IP:${PUBLIC_HOST}"; else SAN="DNS:${PUBLIC_HOST}"; fi
  cat > /etc/hrms/tls/openssl.cnf <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = ${PUBLIC_HOST}
O = HRMS
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = ${SAN}, IP:127.0.0.1
subjectKeyIdentifier = hash
EOF
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
    -config /etc/hrms/tls/openssl.cnf -keyout /etc/hrms/tls/hrms.key -out /etc/hrms/tls/hrms.crt
  chmod 0600 /etc/hrms/tls/hrms.key
  chmod 0644 /etc/hrms/tls/hrms.crt
fi
openssl x509 -in /etc/hrms/tls/hrms.crt -noout -fingerprint -sha256

log "Environment files"
if [ "${SMALL}" = yes ]; then KC_HEAP="-Xms96m -Xmx384m"; elif [ "${MEM_MB}" -lt 6000 ]; then KC_HEAP="-Xms256m -Xmx512m"; else KC_HEAP="-Xms512m -Xmx1024m"; fi
KEYCLOAK_LOCAL_IMAGE="hrms/keycloak:${KEYCLOAK_IMAGE##*:}"
umask 077
cat > /etc/hrms/keycloak.env <<EOF
KEYCLOAK_IMAGE=${KEYCLOAK_IMAGE}
KEYCLOAK_LOCAL_IMAGE=${KEYCLOAK_LOCAL_IMAGE}
KC_DB=postgres
KC_DB_URL=jdbc:postgresql://127.0.0.1:5432/keycloak
KC_DB_USERNAME=keycloak
KC_DB_PASSWORD=${KEYCLOAK_DB_PASSWORD}
KC_DB_POOL_INITIAL_SIZE=2
KC_DB_POOL_MIN_SIZE=2
KC_DB_POOL_MAX_SIZE=10
KC_CACHE=local
KC_HOSTNAME=${PUBLIC_ORIGIN}/kc
KC_HTTP_RELATIVE_PATH=/kc
KC_HTTP_ENABLED=true
KC_HTTP_HOST=127.0.0.1
KC_HTTP_PORT=8080
KC_HTTP_MANAGEMENT_PORT=9000
KC_PROXY_HEADERS=xforwarded
KC_HEALTH_ENABLED=true
KC_BOOTSTRAP_ADMIN_USERNAME=hrms-kc-admin
KC_BOOTSTRAP_ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASSWORD}
JAVA_OPTS_KC_HEAP=${KC_HEAP}
EOF
cat > /etc/hrms/hrms.env.new <<EOF
# HRMS API and worker (systemd EnvironmentFile; written by deploy/scripts/setup-server.sh, secrets from /etc/hrms/secrets.env).
DATABASE_URL=postgres://hrms:${HRMS_DB_PASSWORD}@127.0.0.1:5432/hrms
SESSION_TOKEN_SECRET=${SESSION_TOKEN_SECRET}
SESSION_TOKEN_ISSUER=hrms
OIDC_ISSUER=${PUBLIC_ORIGIN}/kc/realms/hrms
OIDC_CLIENT_ID=hrms-web
OIDC_DISCOVERY_URL=http://127.0.0.1:8080/kc/realms/hrms/.well-known/openid-configuration
OIDC_JWKS_URI=http://127.0.0.1:8080/kc/realms/hrms/protocol/openid-connect/certs
OIDC_REQUIRE_MFA=${OIDC_REQUIRE_MFA:-true}
OIDC_MFA_AMR=otp
HRMS_FIELD_KEYS=${HRMS_FIELD_KEYS}
HRMS_CANDIDATE_IDENTITY_KEY=${HRMS_CANDIDATE_IDENTITY_KEY}
FILE_STORE_DIR=/var/lib/hrms/files
CLAMD_SOCKET=${CLAMD_SOCKET}
HOST=127.0.0.1
PORT=3000
EOF
umask 022
# Settings changed by hand after setup (e.g. OIDC_REQUIRE_MFA) are kept unless this run sets them.
if [ -f /etc/hrms/hrms.env ] && [ -z "${OIDC_REQUIRE_MFA:-}" ]; then
  kept="$(awk -F= '$1 == "OIDC_REQUIRE_MFA" {print $2}' /etc/hrms/hrms.env)"
  [ -n "${kept}" ] && sed -i "s/^OIDC_REQUIRE_MFA=.*/OIDC_REQUIRE_MFA=${kept}/" /etc/hrms/hrms.env.new
fi
# Email notifications (FR-085): off unless SMTP_HOST is given to this script (then SMTP_FROM is required, and SMTP_USER with a password
# file SMTP_PASSWORD_SOURCE, which is copied to /etc/hrms/smtp-password, root:hrms 0640 — the password never goes into this file or a
# command line). A later run without SMTP_HOST keeps the email settings already there. Emails still go out only for events whose email
# rule two administrators have proposed and published.
if [ -n "${SMTP_HOST:-}" ]; then
  : "${SMTP_FROM:?SMTP_FROM (the sender address) is required with SMTP_HOST}"
  if [ -n "${SMTP_USER:-}" ]; then
    if [ -n "${SMTP_PASSWORD_SOURCE:-}" ]; then
      install -o root -g hrms -m 0640 "${SMTP_PASSWORD_SOURCE}" /etc/hrms/smtp-password
    fi
    [ -s /etc/hrms/smtp-password ] || { echo "SMTP_USER needs its password in a file: give SMTP_PASSWORD_SOURCE=<path>" >&2; exit 1; }
  fi
  {
    echo "SMTP_HOST=${SMTP_HOST}"
    echo "SMTP_PORT=${SMTP_PORT:-587}"
    echo "SMTP_SECURITY=${SMTP_SECURITY:-starttls}"
    if [ -n "${SMTP_USER:-}" ]; then echo "SMTP_USER=${SMTP_USER}"; echo "SMTP_PASSWORD_FILE=/etc/hrms/smtp-password"; fi
    echo "SMTP_FROM=${SMTP_FROM}"
    echo "APP_PUBLIC_URL=${PUBLIC_ORIGIN}"
    if [ -n "${EMAIL_TEST_RECIPIENTS:-}" ]; then echo "EMAIL_TEST_RECIPIENTS=${EMAIL_TEST_RECIPIENTS}"; fi
  } >> /etc/hrms/hrms.env.new
elif [ -f /etc/hrms/hrms.env ]; then
  grep -E '^(SMTP_[A-Z_]+|APP_PUBLIC_URL|EMAIL_TEST_RECIPIENTS)=' /etc/hrms/hrms.env >> /etc/hrms/hrms.env.new || true
fi
mv /etc/hrms/hrms.env.new /etc/hrms/hrms.env
chown root:hrms /etc/hrms/hrms.env
chmod 0640 /etc/hrms/hrms.env
if [ "${ADMIN_LOGIN}" != root ] && id -u "${ADMIN_LOGIN}" >/dev/null 2>&1; then setfacl -m "u:${ADMIN_LOGIN}:r" /etc/hrms/hrms.env; fi
chown root:root /etc/hrms/keycloak.env
chmod 0600 /etc/hrms/keycloak.env

log "Sign-in provider (Keycloak ${KEYCLOAK_IMAGE})"
sed "s#__PUBLIC_ORIGIN__#${PUBLIC_ORIGIN}#g" "${HERE}/keycloak/hrms-realm.json.template" > /etc/hrms/keycloak-import/hrms-realm.json
chmod 0644 /etc/hrms/keycloak-import/hrms-realm.json
systemctl enable --now docker
docker pull -q "${KEYCLOAK_IMAGE}"
docker build -q --build-arg KEYCLOAK_IMAGE="${KEYCLOAK_IMAGE}" -t "${KEYCLOAK_LOCAL_IMAGE}" "${HERE}/keycloak"
install -m 0644 "${HERE}/systemd/hrms-keycloak.service" /etc/systemd/system/hrms-keycloak.service
systemctl daemon-reload
systemctl enable hrms-keycloak
# A restart takes minutes on a small server: only when the image, settings, realm file or unit changed, or it is not running.
KC_STATE="$(cat /etc/hrms/keycloak.env /etc/hrms/keycloak-import/hrms-realm.json /etc/systemd/system/hrms-keycloak.service \
  <(docker image inspect -f '{{.Id}}' "${KEYCLOAK_LOCAL_IMAGE}") | sha256sum | cut -d' ' -f1)"
if ! systemctl is-active --quiet hrms-keycloak || [ "$(cat /etc/hrms/.keycloak-state 2>/dev/null)" != "${KC_STATE}" ]; then
  systemctl restart hrms-keycloak
  echo "${KC_STATE}" > /etc/hrms/.keycloak-state
else
  echo "Keycloak unchanged and running: not restarted"
fi
echo "Waiting for Keycloak (minutes on a small server)…"
for i in $(seq 1 180); do
  curl -fsS -o /dev/null http://127.0.0.1:8080/kc/realms/hrms/.well-known/openid-configuration && break
  [ "$i" -eq 180 ] && { journalctl -u hrms-keycloak -n 80 --no-pager; echo "Keycloak did not start" >&2; exit 1; }
  sleep 5
done
PUBLIC_ORIGIN="${PUBLIC_ORIGIN}" bash "${HERE}/keycloak/configure-realm.sh"

log "nginx"
for snippet in hrms-proxy.conf hrms-app-headers.conf hrms-tls.conf hrms-site.conf; do
  install -m 0644 "${HERE}/nginx/${snippet}" "/etc/nginx/snippets/${snippet}"
done
install -d -m 0755 /var/www/letsencrypt
LE_DIR="/etc/letsencrypt/live/${PUBLIC_HOST}"
render_site() {   # the site with Let's Encrypt's certificate once there is one, else the self-signed one
  local cert=/etc/hrms/tls/hrms.crt key=/etc/hrms/tls/hrms.key
  if [ -f "${LE_DIR}/fullchain.pem" ]; then cert="${LE_DIR}/fullchain.pem"; key="${LE_DIR}/privkey.pem"; fi
  sed -e "s#__PUBLIC_HOST__#${PUBLIC_HOST}#g" -e "s#__CERT__#${cert}#g" -e "s#__KEY__#${key}#g" \
    "${HERE}/nginx/hrms.conf.template" > /etc/nginx/sites-available/hrms
}
render_site
ln -sfn /etc/nginx/sites-available/hrms /etc/nginx/sites-enabled/hrms
# nginx's default site is removed (a copy is kept in /root); its files in /var/www/html are left as they are.
rm -f /etc/nginx/sites-enabled/default
if [ -f /etc/nginx/sites-available/default ]; then
  [ -e /root/nginx-sites-available-default.bak ] || cp /etc/nginx/sites-available/default /root/nginx-sites-available-default.bak
  rm -f /etc/nginx/sites-available/default
fi
install -d -m 0755 "${APP}/public"
nginx -t
systemctl enable nginx
systemctl reload nginx || systemctl restart nginx

if [[ ! "${PUBLIC_HOST}" =~ ^[0-9.]+$ ]]; then
  log "Let's Encrypt certificate for ${PUBLIC_HOST}"
  # Proof of the domain over port 80 (nginx serves /var/www/letsencrypt there); renewed by certbot.timer, nginx reloaded after each.
  # No email address is registered (none is sent to Let's Encrypt); renewal is automatic.
  apt-get install -y -q certbot
  if [ ! -f "${LE_DIR}/fullchain.pem" ]; then
    certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
      --webroot -w /var/www/letsencrypt -d "${PUBLIC_HOST}"
  fi
  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/bin/sh\n# Written by deploy/scripts/setup-server.sh: serve each renewed certificate.\nsystemctl reload nginx\n' \
    > /etc/letsencrypt/renewal-hooks/deploy/hrms-reload-nginx
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/hrms-reload-nginx
  systemctl enable --now certbot.timer
  render_site
  nginx -t
  systemctl reload nginx
  certbot certificates --cert-name "${PUBLIC_HOST}" 2>/dev/null | grep -E "Domains|Expiry" || true
fi

log "Firewall: HTTP and HTTPS in"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp
  ufw allow 443/tcp
fi
# Oracle Cloud's Ubuntu images reject everything but SSH in iptables (persisted in /etc/iptables/rules.v4).
if [ -f /etc/iptables/rules.v4 ] && iptables -S INPUT | grep -q -- '-j REJECT'; then
  for port in 80 443; do
    iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport "${port}" -j ACCEPT 2>/dev/null \
      || iptables -I INPUT 5 -p tcp -m state --state NEW -m tcp --dport "${port}" -j ACCEPT
  done
  iptables-save > /etc/iptables/rules.v4
fi

log "Hardening: SSH and unused network services"
# Keys only (the cloud image already says so), no root sign-in, no X11; checked before reloading so a mistake cannot lock anyone out.
cat > /etc/ssh/sshd_config.d/10-hrms-hardening.conf <<'EOF'
# Written by deploy/scripts/setup-server.sh. Read before 60-cloudimg-settings.conf, so these win.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
if sshd -t; then systemctl reload ssh; else rm -f /etc/ssh/sshd_config.d/10-hrms-hardening.conf; echo "sshd settings refused; left as they were" >&2; fi
# rpcbind (NFS) listens on all addresses and nothing here uses it.
if ! grep -qE '\snfs4?\s' /proc/mounts; then
  systemctl disable --now rpcbind.socket rpcbind.service 2>/dev/null || true
fi

log "HRMS services"
install -m 0644 "${HERE}/systemd/hrms-api.service" /etc/systemd/system/hrms-api.service
install -m 0644 "${HERE}/systemd/hrms-worker.service" /etc/systemd/system/hrms-worker.service
install -m 0644 "${HERE}/systemd/hrms-backup.service" /etc/systemd/system/hrms-backup.service
install -m 0644 "${HERE}/systemd/hrms-backup.timer" /etc/systemd/system/hrms-backup.timer
systemctl daemon-reload
systemctl enable hrms-api hrms-worker
systemctl enable --now hrms-backup.timer
# Running already (a repeated setup): pick up changed settings such as new database passwords (once a release is installed there).
if [ -e "${APP}/node_modules/.bin/tsx" ]; then systemctl try-restart hrms-api hrms-worker; fi
echo
echo "Setup done. Next: deploy/scripts/install-release.sh (code, migrations, services), then deploy/scripts/bootstrap-company.sh."
echo "People are managed at ${PUBLIC_ORIGIN}/kc/admin/hrms/console/ (by the System Administrator). Keycloak's own administration is"
echo "closed to the internet; on the server it is hrms-kc-admin (password in /etc/hrms/secrets.env, KEYCLOAK_ADMIN_PASSWORD)."
