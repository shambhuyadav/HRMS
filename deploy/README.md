# HRMS deployment (single Ubuntu server)

What runs where, on one server (Ubuntu 22.04 or 24.04, 4 GB RAM or more):

| Piece | How | Listens |
|---|---|---|
| nginx | system package; Let's Encrypt certificate for the domain (self-signed with an IP address only) | 80 → 443 (public) |
| Web app | built files of the release, in `/var/www/html/HRMS/public` (site: `/etc/nginx/sites-available/hrms`, enabled in `sites-enabled`) | via nginx `/` |
| HRMS API | `hrms-api.service` → `apps/api/src/main.ts` (NODE_ENV=production) | 127.0.0.1:3000, via nginx `/v1/`, `/sign-in/`, `/health`, `/ready` |
| Worker | `hrms-worker.service` → `apps/api/src/worker-main.ts` (scheduler, malware scans) | — |
| Sign-in provider | Keycloak in Docker, `hrms-keycloak.service`, realm `hrms`, client `hrms-web` | 127.0.0.1:8080, via nginx `/kc/` |
| PostgreSQL 16 | system package; databases `hrms` and `keycloak` | 127.0.0.1:5432 |
| ClamAV | `clamav-daemon` (+ `clamav-freshclam`) | local socket |
| Backups | `hrms-backup.timer`, nightly at 01:30 | — |

Everything is in one folder, `/var/www/html/HRMS`:

```
/var/www/html/HRMS/
├── apps/
│   ├── api/src/                 the API (Node.js, TypeScript): main.ts starts it
│   │   ├── modules/<area>/      one folder per HR area (payroll, leave, attendance, employee, hiring, …):
│   │   │                          routes.ts = its API endpoints (the "controllers"), the other files = its logic and queries
│   │   ├── auth/ security/      sign-in, sessions, permissions, encryption of private fields
│   │   ├── db/ http/ storage/   database connection, request handling, uploaded files
│   │   └── worker/              the scheduler (worker-main.ts starts it)
│   └── web/src/                 the web app (React): pages/ = the screens, api.ts = calls to the API
├── db/migrations/               the database structure (the "models"): tables, rules, in order
├── deploy/                      these scripts, the nginx/systemd/Keycloak files, this README
├── node_modules/                libraries
├── package.json, RELEASE        the project; which build this is
├── public/                      the web app's built files — the ONLY part nginx serves
├── config  -> /etc/hrms          settings, keys, certificate (secrets.env and keycloak.env root only)
├── uploads -> /var/lib/hrms/files   uploaded documents
└── backups -> /var/backups/hrms     nightly backups (the files themselves root only)
```

The project folders belong to the `ubuntu` login and the `hrms` group (the services' account); nobody else can read them, including
nginx's own account, so the source cannot be served even if the default nginx site (which serves all of `/var/www/html`) were ever
enabled again. Each release replaces the project folders and `public/` (the ones it replaces are kept in `.previous/`): change code in
the repository and release it, not on the server.

Sign-in (ADR-06): the browser signs in at Keycloak (authorization code + PKCE, password **and** an authenticator app, which every
user must set up at the first sign-in), and the API verifies Keycloak's ID token (issuer, audience, signature, nonce, verified email,
`amr` contains `otp`) and links the Keycloak identity to the HRMS account whose account key is that email. **A person needs both**: a
Keycloak user (email verified) and an HRMS account with a role (granted in the HRMS by its administrators).

## Files

```
deploy/
  scripts/package-release.sh   (developer machine) the release tarball
  scripts/setup-server.sh      (server, root) packages, database, Keycloak, ClamAV, TLS, nginx, units — repeatable
  scripts/install-release.sh   (server, root) unpack, npm ci, web build, migrations, switch, restart, checks
  scripts/bootstrap-company.sh (server, root) the first company and its first two administrators (HRMS + Keycloak)
  scripts/verify-sign-in.mjs   (server, root) the sign-in end to end with a temporary synthetic user
  scripts/backup.sh            (server, timer) nightly backup
  keycloak/hrms-realm.json.template, keycloak/configure-realm.sh
  nginx/*.conf*, systemd/*.service|timer
```

Secrets are generated on the server by `setup-server.sh` into `/etc/hrms/secrets.env` (root only) and never leave it. Nothing in this
directory holds one.

## First deployment

On the developer machine (Git Bash):

```bash
bash deploy/scripts/package-release.sh --with-web-build /tmp/hrms-release.tgz   # builds the web app here; the server only installs
scp -i ~/.ssh/<key> /tmp/hrms-release.tgz ubuntu@<server>:/tmp/
```

**Small server (under 3 GB of memory, e.g. a 1 GB trial instance):** `setup-server.sh` adds a 4 GB swap file, a small-memory
PostgreSQL configuration (`/etc/postgresql/16/main/conf.d/hrms-small-server.conf`), a smaller Keycloak heap, and ClamAV reloads
without a second copy of its signatures. Package with `--with-web-build` (the web build does not fit there). It runs, slowly: sign-in
pages and file scans in particular. After upgrading the server, run `setup-server.sh` again (it removes the small-memory database
settings and sizes Keycloak for the new memory; the swap file can stay or be removed with `swapoff /swapfile`).

On the server:

```bash
mkdir -p /tmp/hrms-setup && tar -xzf /tmp/hrms-release.tgz -C /tmp/hrms-setup deploy
sudo PUBLIC_HOST=<server address> bash /tmp/hrms-setup/deploy/scripts/setup-server.sh
sudo bash /tmp/hrms-setup/deploy/scripts/install-release.sh /tmp/hrms-release.tgz
sudo BOOTSTRAP_COMPANY_CODE=ACME BOOTSTRAP_COMPANY_NAME='Acme Ltd' \
     BOOTSTRAP_ADMIN_EMAIL=it.admin@acme.example BOOTSTRAP_HR_EMAIL=hr.admin@acme.example \
     bash /var/www/html/HRMS/deploy/scripts/bootstrap-company.sh
sudo NODE_EXTRA_CA_CERTS=/etc/hrms/tls/hrms.crt node /var/www/html/HRMS/deploy/scripts/verify-sign-in.mjs
```

The cloud provider's firewall (e.g. an Oracle Cloud security list, an AWS security group) must allow TCP 80 and 443 in; the server's
own firewall is opened by `setup-server.sh`.

The two administrators' temporary passwords are in `/root/hrms-initial-passwords.txt` (`sudo cat` it; delete it once both have signed
in). At the first sign-in each chooses a password and scans the QR code with an authenticator app.

Certificates: with a domain name as `PUBLIC_HOST` (this server: `hrstop.duckdns.org`), `setup-server.sh` gets a Let's Encrypt
certificate (proved over port 80, which must stay open; renewed automatically by `certbot.timer`, nginx reloaded after each renewal;
`sudo certbot certificates` shows the expiry) and sends browsers to HTTPS only (HSTS). Other addresses, such as the bare IP, are
redirected to the name. With only an IP address, the certificate is self-signed: check its SHA-256 fingerprint (printed by
`setup-server.sh`) before accepting the browser's warning. The self-signed certificate in `/etc/hrms/tls` is always kept for the
server's own checks on `https://127.0.0.1`. Changing `PUBLIC_HOST` later: run `setup-server.sh` with the new one — it also updates
Keycloak's address and the web app's sign-in return address. The domain must point at this server: a DuckDNS name is updated at
duckdns.org if the server's public IP ever changes.

## Updating

```bash
bash deploy/scripts/package-release.sh /tmp/hrms-release.tgz && scp … /tmp/      # developer machine
sudo bash /var/www/html/HRMS/deploy/scripts/install-release.sh /tmp/hrms-release.tgz # server
```

If anything before the switch fails (dependencies, build, migration), the running release keeps running. Migrations are applied in
order, each in its own transaction, and an applied migration that has changed is refused. When `deploy/` itself changed (units,
nginx, Keycloak settings), run `setup-server.sh` again afterwards (it keeps the secrets, the certificate and settings changed by hand).

Rolling back to the version before the last release — only if that release added no migration (migrations are never undone):

```bash
cd /var/www/html/HRMS
for f in .previous/* ; do n=$(basename "$f"); sudo rm -rf "$n" && sudo mv "$f" "$n"; done
sudo systemctl restart hrms-api hrms-worker
```

Or install the older release tarball again with `install-release.sh`.

A release that adds a duty to a role's defaults does not change grants approved before it: an approved grant's permissions are fixed,
and the normal way to widen one is a new grant approved by a third person. While the deployment has only its two first administrators
(no independent approver), the owner authorised (11 Nov 2026) a one-time refresh after each such release: existing grants get only
their own role's new default duties (nothing confidential, nothing an administrator switched off), each widened grant is marked
bootstrapped and audited. Look at the plan first, then apply it:

```bash
sudo REFRESH_COMPANY=HRMS bash /var/www/html/HRMS/deploy/scripts/refresh-duties.sh                                    # dry run
sudo REFRESH_COMPANY=HRMS REFRESH_CONFIRM=add-default-duties bash /var/www/html/HRMS/deploy/scripts/refresh-duties.sh  # apply
```

Once a third administrator exists, widen grants the normal way instead.

If a database password was ever exposed: `sudo ROTATE_DB_PASSWORDS=yes PUBLIC_HOST=<address> bash …/setup-server.sh` replaces both
without showing them.

## Adding people

1. In the HRMS, an administrator creates or invites the person and grants a role (access administration; a second person approves).
2. The System Administrator, in Keycloak's console for the HRMS (`https://<server>/kc/admin/hrms/console/`, the same sign-in with the
   authenticator app) → Users → Add user: email = the HRMS account's email, **Email verified on**, required actions *Update Password*
   and *Configure OTP*; Credentials → set a temporary password and give it to the person directly (not by email).

Removing someone: deactivate them in the HRMS (their sessions end) and disable the Keycloak user.

## Operations

```bash
systemctl status hrms-api hrms-worker hrms-keycloak nginx postgresql clamav-daemon
journalctl -u hrms-api -f          # API log (JSON, one line per request)
journalctl -u hrms-worker -f       # scheduler and scans
curl -s http://127.0.0.1:3000/ready
```

Keycloak's own administration (the master realm) is closed to the internet by nginx; only the hrms realm's console is reachable.
Keycloak's super-administrator is `hrms-kc-admin` (password `KEYCLOAK_ADMIN_PASSWORD` in `/etc/hrms/secrets.env`), used on the server
only, by the scripts here through Keycloak's admin CLI (`docker exec hrms-keycloak /opt/keycloak/bin/kcadm.sh …`). Realm settings
(the sign-in flow, password policy, the client) change only there, or by `configure-realm.sh`.

Hardening in place: only ports 22 (key-only SSH), 80 (redirect) and 443 are open; the API, Keycloak and PostgreSQL listen on
127.0.0.1; the services run as an unprivileged account in a systemd sandbox and cannot change their own code; secrets are root-only;
password + authenticator app for everyone, checked by Keycloak and again by the API; Keycloak locks out password guessing; sign-in
and API requests are rate-limited; the web app is served with a strict Content-Security-Policy and no framing; security updates
install automatically (unattended-upgrades); a Let's Encrypt certificate and HSTS on the domain. Not yet: off-server backups.

`OIDC_REQUIRE_MFA=true` in `/etc/hrms/hrms.env` makes the API refuse any ID token whose `amr` lacks `otp`. Keycloak's browser flow
(`hrms-browser`, set by `configure-realm.sh`) asks every user for the code; `verify-sign-in.mjs` checks both.

## Email notifications

Off until configured, and then only for events whose email rule one administrator proposed and another published (FR-085, DF12;
in-app notices are unaffected). To switch the channel on, put the SMTP password in a file on the server, then run setup with the
account details — the password is copied to `/etc/hrms/smtp-password` (root:hrms, 0640) and never written into `hrms.env` or shown:

```bash
sudo PUBLIC_HOST=hrstop.duckdns.org SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_SECURITY=starttls \
     SMTP_USER=hrms@example.com SMTP_PASSWORD_SOURCE=/root/smtp-password.txt SMTP_FROM=hrms@example.com \
     EMAIL_TEST_RECIPIENTS=@example.com bash /var/www/html/HRMS/deploy/scripts/setup-server.sh
sudo rm /root/smtp-password.txt
```

`EMAIL_TEST_RECIPIENTS` (optional) limits sending to those addresses or `@domains` for a first safe test; run setup again without it
to open sending to everyone. Emails carry state only (never pay, amounts or reasons) and a link to the app; the delivery log shows
each attempt. Later setup runs keep these settings unless new ones are given.

## Backups

`hrms-backup.timer` writes nightly to `/var/backups/hrms` (14 days): both databases (`pg_dump -Fc`), the uploaded files and
`/etc/hrms` (the keys: **a database backup cannot be restored without `HRMS_FIELD_KEYS`**). These copies are on the same disk: copy
them off the server regularly (e.g. `rsync` to another machine, or object storage), encrypted, and test a restore:

```bash
sudo -u postgres createdb -O hrms hrms_restore_test && sudo -u postgres pg_restore -d hrms_restore_test /var/backups/hrms/hrms-db-<time>.dump
```
