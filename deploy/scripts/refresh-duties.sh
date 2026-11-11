#!/usr/bin/env bash
# One-time refresh of default duties after a release (db/refresh-default-duties.ts; authorised by the owner on 11 Nov 2026). Existing
# approved grants get only their own role's new default duties: nothing confidential, nothing outside the role ceiling, nothing an
# administrator switched off. Each widened grant is marked bootstrapped and audited with the owner's reason. Without
# REFRESH_CONFIRM=add-default-duties it is a dry run that prints the plan and writes nothing.
#   sudo REFRESH_COMPANY=HRMS bash /var/www/html/HRMS/deploy/scripts/refresh-duties.sh                                   (dry run)
#   sudo REFRESH_COMPANY=HRMS REFRESH_CONFIRM=add-default-duties bash /var/www/html/HRMS/deploy/scripts/refresh-duties.sh (apply)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
: "${REFRESH_COMPANY:?}"
APP=/var/www/html/HRMS

echo "== HRMS: default duties of existing grants in ${REFRESH_COMPANY} (${REFRESH_CONFIRM:+apply}${REFRESH_CONFIRM:-dry run})"
systemd-run --quiet --wait --pipe --collect --uid=hrms --gid=hrms \
  -p EnvironmentFile=/etc/hrms/hrms.env -p PrivateTmp=true -E NODE_ENV=production \
  -E REFRESH_COMPANY="$REFRESH_COMPANY" -E REFRESH_CONFIRM="${REFRESH_CONFIRM:-}" \
  --working-directory="$APP" "$APP/node_modules/.bin/tsx" db/refresh-default-duties.ts
