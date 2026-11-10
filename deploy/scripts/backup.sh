#!/usr/bin/env bash
# Nightly backup on the server (hrms-backup.timer): the HRMS and Keycloak databases, the uploaded files and the secrets needed to read
# them (HRMS_FIELD_KEYS seals private values: a database backup without its keys cannot be restored). Kept 14 days in
# /var/backups/hrms (root only). These copies are on the same server: copy them off it (see deploy/README.md, "Backups").
set -euo pipefail
DEST=/var/backups/hrms
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# Created once by setup-server.sh (which also lets the administrators' login list it): not re-permissioned here, as that would reset it.
[ -d "$DEST" ] || install -d -o root -g root -m 0700 "$DEST"
cd "$DEST"
runuser -u postgres -- pg_dump -Fc hrms > "hrms-db-$STAMP.dump.part" && mv "hrms-db-$STAMP.dump.part" "hrms-db-$STAMP.dump"
runuser -u postgres -- pg_dump -Fc keycloak > "keycloak-db-$STAMP.dump.part" && mv "keycloak-db-$STAMP.dump.part" "keycloak-db-$STAMP.dump"
tar -C /var/lib/hrms -czf "hrms-files-$STAMP.tgz.part" files && mv "hrms-files-$STAMP.tgz.part" "hrms-files-$STAMP.tgz"
tar -C /etc -czf "hrms-etc-$STAMP.tgz.part" hrms && mv "hrms-etc-$STAMP.tgz.part" "hrms-etc-$STAMP.tgz"
chmod 0600 ./*-"$STAMP".*
find "$DEST" -maxdepth 1 -type f -mtime +14 -delete
echo "backup $STAMP: $(du -ch ./*-"$STAMP".* | tail -1 | cut -f1)"
