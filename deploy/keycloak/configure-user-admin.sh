#!/usr/bin/env bash
# Lets the HRMS administer the sign-ins of its users (owner request of 13 Nov 2026: the System Administrator creates, edits, deletes
# and resets the password of accounts from the User accounts screen; apps/api/src/auth/identity-admin.ts). Run on the server as
# root after a release that carries the screen; safe to run again (each run gives the login a new password).
#   1. a login "hrms-user-admin" in Keycloak's master realm (owner-approved, 14 Nov 2026) that holds only the hrms realm's
#      manage-users, view-users and query-users roles: it administers the HRMS realm's users and nothing else — not the master
#      realm, not the HRMS realm's clients, sign-in rules or settings. It signs in by password through admin-cli, as kc-api.sh does:
#      Keycloak 26.8 refuses service-account (client-credentials) tokens on its admin API, while it accepts a login's;
#   2. its password is random (40 characters), generated here and written only into the API's environment (/etc/hrms/hrms.env,
#      root:hrms 0640) — never printed or put on a command line — with Keycloak's local address; the API restarts to read it;
#   3. an earlier attempt's clients named hrms-user-admin (a service-account client, in either realm) are removed.
#   sudo bash /var/www/html/HRMS/deploy/keycloak/configure-user-admin.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=kc-api.sh
source "${HERE}/kc-api.sh"
M=/realms/master
LOGIN=hrms-user-admin
ENV_FILE=/etc/hrms/hrms.env
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE is missing: run setup-server.sh first." >&2; exit 1; }

echo "== Keycloak login ${LOGIN} (master realm)"
USER_ID="$(kc_api GET "$M/users?username=${LOGIN}&exact=true" | jq -r '.[0].id // empty')"
if [ -z "$USER_ID" ]; then
  kc_api POST "$M/users" "$(jq -cn --arg u "$LOGIN" '{username: $u, enabled: true, firstName: "HRMS", lastName: "user administration", requiredActions: []}')" >/dev/null
  USER_ID="$(kc_api GET "$M/users?username=${LOGIN}&exact=true" | jq -er '.[0].id')"
  echo "created"
else
  echo "already there"
fi
PASSWORD="$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
[ "${#PASSWORD}" -eq 40 ] || { echo "could not generate a password" >&2; exit 1; }
kc_api PUT "$M/users/${USER_ID}/reset-password" "$(jq -cn --rawfile p <(printf '%s' "$PASSWORD") '{type: "password", value: $p, temporary: false}')" >/dev/null
echo "new password set"

echo "== It may administer the hrms realm's users, and nothing else"
HR="$(kc_api GET "$M/clients?clientId=hrms-realm" | jq -er '.[0].id')"
ROLES="$(kc_api GET "$M/clients/${HR}/roles" | jq -c '[.[] | select(.name | IN("manage-users", "view-users", "query-users"))]')"
[ "$(jq length <<<"$ROLES")" -eq 3 ] || { echo "hrms-realm roles not found" >&2; exit 1; }
kc_api POST "$M/users/${USER_ID}/role-mappings/clients/${HR}" "$ROLES" >/dev/null

echo "== Earlier clients of the same name, if any"
for realm in /realms/master /realms/hrms; do
  CID="$(kc_api GET "${realm}/clients?clientId=${LOGIN}" | jq -r '.[0].id // empty')"
  if [ -n "$CID" ]; then kc_api DELETE "${realm}/clients/${CID}" >/dev/null && echo "removed the client in ${realm#/realms/}"; fi
done

echo "== The API's environment"
{
  grep -vE '^KEYCLOAK_(ADMIN_URL|REALM|ADMIN_TOKEN_REALM|ADMIN_CLIENT_ID|ADMIN_CLIENT_SECRET|ADMIN_USERNAME|ADMIN_PASSWORD)=' "$ENV_FILE" || true
  printf 'KEYCLOAK_ADMIN_URL=%s\nKEYCLOAK_REALM=hrms\nKEYCLOAK_ADMIN_TOKEN_REALM=master\nKEYCLOAK_ADMIN_CLIENT_ID=admin-cli\nKEYCLOAK_ADMIN_USERNAME=%s\nKEYCLOAK_ADMIN_PASSWORD=%s\n' \
    "${KC_URL}" "${LOGIN}" "${PASSWORD}"
} > "${ENV_FILE}.new"
unset PASSWORD
chown root:hrms "${ENV_FILE}.new"
# Keep any reader ACL the old file had (the admin login's read access, setup-server.sh); copying it also copies its mask, so the
# mode is set again after it and the group can only read.
getfacl -p "$ENV_FILE" 2>/dev/null | setfacl --set-file=- "${ENV_FILE}.new" 2>/dev/null || true
chmod 0640 "${ENV_FILE}.new"
mv "${ENV_FILE}.new" "$ENV_FILE"
echo "written (the password is not shown)"

echo "== Restarting the API"
systemctl restart hrms-api
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null http://127.0.0.1:3000/ready 2>/dev/null && { echo "API ready"; exit 0; }
  sleep 2
done
echo "The API did not answer /ready within 2 minutes: check journalctl -u hrms-api" >&2
exit 1
