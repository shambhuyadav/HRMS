#!/usr/bin/env bash
# Test accounts and dummy data for testing (db/test-data.ts) in an existing company, plus the five test sign-ins in Keycloak (email
# verified, a temporary password; at the first sign-in each chooses a password and sets up an authenticator app). The temporary
# passwords go to /root/hrms-test-passwords.txt (root only), never to the screen. The records are permanent: they can be deactivated,
# not removed — the script refuses to run without TEST_DATA_CONFIRM=permanent-test-records.
#   sudo TEST_DATA_COMPANY=HRMS TEST_DATA_APPROVER=<System Administrator email> TEST_DATA_CONFIRM=permanent-test-records \
#        bash /var/www/html/HRMS/deploy/scripts/test-data.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
: "${TEST_DATA_COMPANY:?}" "${TEST_DATA_APPROVER:?}" "${TEST_DATA_CONFIRM:?}"
APP=/var/www/html/HRMS

echo "== HRMS: test accounts and dummy data in ${TEST_DATA_COMPANY}"
systemd-run --quiet --wait --pipe --collect --uid=hrms --gid=hrms \
  -p EnvironmentFile=/etc/hrms/hrms.env -p PrivateTmp=true -E NODE_ENV=production \
  -E TEST_DATA_COMPANY="$TEST_DATA_COMPANY" -E TEST_DATA_APPROVER="$TEST_DATA_APPROVER" -E TEST_DATA_CONFIRM="$TEST_DATA_CONFIRM" \
  --working-directory="$APP" "$APP/node_modules/.bin/tsx" db/test-data.ts

echo "== Keycloak: the test sign-ins"
# shellcheck source=../keycloak/kc-api.sh
. "$(dirname "${BASH_SOURCE[0]}")/../keycloak/kc-api.sh"
R=/realms/hrms
user_id() { kc_api GET "$R/users?email=$(jq -rn --arg e "$1" '$e | @uri')&exact=true" | jq -r '.[0].id // empty'; }
umask 077
while IFS='|' read -r email first last; do
  if [ -n "$(user_id "$email")" ]; then echo "   $email already has a sign-in (left as it is)"; continue; fi
  password="$(openssl rand -hex 10)"
  kc_api POST "$R/users" "$(jq -cn --arg e "$email" --arg f "$first" --arg l "$last" --arg p "$password" '{
    username: $e, email: $e, firstName: $f, lastName: $l, enabled: true, emailVerified: true,
    requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"], credentials: [{ type: "password", value: $p, temporary: true }] }')"
  printf '%s  %s  (test account, temporary; created %s)\n' "$email" "$password" "$(date -u +%FT%TZ)" >> /root/hrms-test-passwords.txt
  echo "   $email: sign-in created"
done <<'EOF'
demo.sysadmin@hrstop.test|Test|System Administrator
demo.hr@hrstop.test|Ananya|Iyer
demo.manager@hrstop.test|Rohan|Mehta
demo.employee@hrstop.test|Priya|Nair
demo.auditor@hrstop.test|Test|Auditor
EOF
# Like the real System Administrator: manages people in the hrms realm's console, not its settings.
RM="$(kc_api GET "$R/clients?clientId=realm-management" | jq -er '.[0].id')"
ROLES="$(kc_api GET "$R/clients/$RM/roles" | jq -c '[.[] | select(.name | IN("manage-users", "view-users", "query-users", "query-groups", "view-realm"))]')"
kc_api POST "$R/users/$(user_id demo.sysadmin@hrstop.test)/role-mappings/clients/$RM" "$ROLES"
echo "Temporary passwords: sudo cat /root/hrms-test-passwords.txt"
