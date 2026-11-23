#!/usr/bin/env bash
# Copies one night's backup off the server. backup.sh calls it once /etc/hrms/offsite-backup.env exists (deploy/README.md,
# "Backups"):
#   OFFSITE_UPLOAD_URL  an Oracle Object Storage pre-authenticated request for the backup bucket (object reads and writes),
#                       ending in /o/. Anyone holding it can add files to the bucket, so it is kept like a password.
#   OFFSITE_RECIPIENT   the public half of the owner's age key (age1...). The private half is not on this server.
# The night's four files are packed into one archive and encrypted to that key, so neither the bucket nor this server can read
# the copy, then uploaded and read back to check its size. The bucket's lifecycle rule removes old copies.
#   bash backup-offsite.sh <stamp>    (the stamp backup.sh gave the night's files)
set -euo pipefail
STAMP="$1"
DEST=/var/backups/hrms
# shellcheck source=/dev/null
. /etc/hrms/offsite-backup.env
: "${OFFSITE_UPLOAD_URL:?missing in /etc/hrms/offsite-backup.env}" "${OFFSITE_RECIPIENT:?missing in /etc/hrms/offsite-backup.env}"

NAME="hrms-backup-${STAMP}.tar.age"
OBJECT_URL="${OFFSITE_UPLOAD_URL%/}/${NAME}"
cd "$DEST"
trap 'rm -f "${DEST}/${NAME}"' EXIT

tar -cf - "hrms-db-${STAMP}.dump" "keycloak-db-${STAMP}.dump" "hrms-files-${STAMP}.tgz" "hrms-etc-${STAMP}.tgz" \
  | age --encrypt --recipient "$OFFSITE_RECIPIENT" --output "$NAME"
SIZE="$(stat -c %s "$NAME")"

# The link holds a secret token: curl reports failures by status only, never the address.
curl --fail --silent --show-error --retry 3 --retry-delay 30 --max-time 900 --upload-file "$NAME" "$OBJECT_URL" > /dev/null
STORED="$(curl --fail --silent --show-error --retry 3 --retry-delay 10 --head "$OBJECT_URL" | tr -d '\r' | awk 'tolower($1) == "content-length:" {print $2}')"
if [ "$STORED" != "$SIZE" ]; then
  echo "offsite copy ${NAME}: uploaded ${SIZE} bytes but the bucket holds ${STORED:-nothing}" >&2
  exit 1
fi
echo "offsite copy ${NAME}: ${SIZE} bytes stored"
