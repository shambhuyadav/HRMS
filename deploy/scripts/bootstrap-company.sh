#!/usr/bin/env bash
# First company of a new installation: creates it in the HRMS with its first System Administrator and HR Administrator
# (db/bootstrap-production.ts: idempotent, each approves the other's role), and their sign-in accounts in Keycloak (email verified,
# a temporary password; at the first sign-in they choose their own password and set up an authenticator app). The temporary passwords
# are written to /root/hrms-initial-passwords.txt (root only), never printed.
#   sudo BOOTSTRAP_COMPANY_CODE=ACME BOOTSTRAP_COMPANY_NAME='Acme Ltd' \
#        BOOTSTRAP_ADMIN_EMAIL=it.admin@acme.example BOOTSTRAP_HR_EMAIL=hr.admin@acme.example bash bootstrap-company.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
: "${BOOTSTRAP_COMPANY_CODE:?}" "${BOOTSTRAP_COMPANY_NAME:?}" "${BOOTSTRAP_ADMIN_EMAIL:?}" "${BOOTSTRAP_HR_EMAIL:?}"
ADMIN_EMAIL="$(tr '[:upper:]' '[:lower:]' <<<"$BOOTSTRAP_ADMIN_EMAIL")"
HR_EMAIL="$(tr '[:upper:]' '[:lower:]' <<<"$BOOTSTRAP_HR_EMAIL")"

echo "== HRMS: company and first administrators"
systemd-run --quiet --wait --pipe --collect --uid=hrms --gid=hrms \
  -p EnvironmentFile=/etc/hrms/hrms.env -p PrivateTmp=true -E NODE_ENV=production \
  -E BOOTSTRAP_COMPANY_CODE="$BOOTSTRAP_COMPANY_CODE" -E BOOTSTRAP_COMPANY_NAME="$BOOTSTRAP_COMPANY_NAME" \
  -E BOOTSTRAP_ADMIN_EMAIL="$ADMIN_EMAIL" -E BOOTSTRAP_HR_EMAIL="$HR_EMAIL" \
  ${BOOTSTRAP_EFFECTIVE_FROM:+-E BOOTSTRAP_EFFECTIVE_FROM="$BOOTSTRAP_EFFECTIVE_FROM"} \
  --working-directory=/var/www/html/HRMS /var/www/html/HRMS/node_modules/.bin/tsx db/bootstrap-production.ts

echo "== Keycloak: their sign-in accounts"
# shellcheck source=../keycloak/kc-api.sh
. "$(dirname "${BASH_SOURCE[0]}")/../keycloak/kc-api.sh"
R=/realms/hrms
user_id() { kc_api GET "$R/users?email=$(jq -rn --arg e "$1" '$e | @uri')&exact=true" | jq -r '.[0].id // empty'; }
umask 077
for email in "$ADMIN_EMAIL" "$HR_EMAIL"; do
  if [ -n "$(user_id "$email")" ]; then
    echo "   $email already has a sign-in account (left as it is)"
    continue
  fi
  password="$(openssl rand -hex 10)"
  kc_api POST "$R/users" "$(jq -cn --arg e "$email" --arg p "$password" '{
    username: $e, email: $e, enabled: true, emailVerified: true, requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"],
    credentials: [{ type: "password", value: $p, temporary: true }] }')"
  printf '%s  %s  (temporary; created %s)\n' "$email" "$password" "$(date -u +%FT%TZ)" >> /root/hrms-initial-passwords.txt
  echo "   $email: sign-in account created"
done
# The System Administrator adds and disables people in the hrms realm's console (/kc/admin/hrms/console/): user management and a
# read-only view of the realm, not its settings (the sign-in flow, the authenticator requirement), which stay with the server.
RM="$(kc_api GET "$R/clients?clientId=realm-management" | jq -er '.[0].id')"
ROLES="$(kc_api GET "$R/clients/$RM/roles" | jq -c '[.[] | select(.name | IN("manage-users", "view-users", "query-users", "query-groups", "view-realm"))]')"
kc_api POST "$R/users/$(user_id "$ADMIN_EMAIL")/role-mappings/clients/$RM" "$ROLES"
echo "   $ADMIN_EMAIL: may manage people in the hrms realm console (/kc/admin/hrms/console/): $(jq -r 'map(.name) | join(", ")' <<<"$ROLES")"
echo "Temporary passwords: sudo cat /root/hrms-initial-passwords.txt (delete the file once both have signed in)."
