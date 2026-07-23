# Aegis

> Node.js backup tool for a single VPS — snapshots PM2 projects, PostgreSQL, MySQL/MariaDB, SQLite, and nginx into one dated `.tar.zst` archive (optionally age-encrypted), uploads to SSH/FTP/S3/B2/R2, prunes old archives, notifies on success/failure, and pings a dead-man's switch.

[![Node](https://img.shields.io/badge/node-%E2%89%A518-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)
[![Platform](https://img.shields.io/badge/platform-linux--x64-lightgrey)](#requirements)

```
┌─ Aegis v1.3.0 — vps.theantihero.se ────────────────────────────────────────┐
│ ┌─ Actions ─────────┐ ┌─ Status ───────────────────────────────────────────────┐ │
│ │ ▶ Backup now      │ │ Target:   root@backup.example.com:/backups/vps          │ │
│ │   Quick backup    │ │ Cron:     installed  0 2 * * *  (next: in 5h 21m)       │ │
│ │   List backups    │ │ Local:    20G free / 54G (37% used)                    │ │
│ │   Restore...      │ │ Remote:   3 backups, 4.2G used, 120G free              │ │
│ │   View logs       │ │                                                           │ │
│ │   Test remote     │ │ ── Recent log tail ────────────────────────────────────  │ │
│ │   Prune now       │ │ [22:38:35] OK   Done in 106.3s                          │ │
│ │   Refresh status  │ │ [22:38:34] OK   Upload complete                          │ │
│ │   Install cron    │ │ [22:38:20] OK   pm2 kunskapsdatabas                      │ │
│ │   Edit config     │ │                                                           │ │
│ │   Quit            │ │                                                           │ │
│ └───────────────────┘ └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **All-in-one backup** — PM2 projects, PostgreSQL/MySQL/MariaDB, Redis, MongoDB, SQLite files, nginx config, and any extra paths you specify
- **Interactive TUI** — neo-blessed dashboard, one-shot setup wizard, no config editing required
- **One archive** — `.tar.zst` (or `.tar.zst.age` if age-encrypted), with a `.sha256` sidecar, `zstd -T0` (all cores); per-phase compression tuning
- **SSH, FTP/FTPS, or S3-compatible storage** — SSH via ed25519 keypair (recommended), FTP for legacy, `rclone` for S3/B2/R2/etc.
- **Optional age encryption** — server only sees ciphertext, restore requires an identity file (or passphrase)
- **Direct-SMTP notifications** — webhook (with optional HMAC signing), local-MTA, SMTP credentials stored in the tool, or a dead-man's switch (healthchecks.io / Uptime Kuma)
- **Pre/post hooks** — run arbitrary shell commands before/after backup and upload (Redis BGSAVE, maintenance mode, etc.)
- **Aegis state bundle** — backs up its own config, ssh key, state, and cron, so a fresh VPS can be bootstrapped from one archive
- **Restore verification** — `--verify` extracts the archive and runs `pg_restore --list`, sqlite integrity checks, MySQL scratch-DB apply, `redis-cli ping`, `nginx -t`, and `tar -t` on every component; `--verify-latest` does it weekly on a cron
- **Restore plan** — `--plan` prints exactly what would happen during a restore, without touching anything
- **Run summary** — each run writes a Markdown and HTML summary next to the log file
- **Restore verification** — `--verify` extracts the archive and runs `pg_restore --list`, sqlite integrity checks, MySQL scratch-DB apply, `nginx -t`, and `tar -t` on every component
- **Nightly cron** — single `install-cron.sh` line, retention by age
- **Restore from the TUI** — lists remote archives, downloads + verifies + restores in one go

## Installation

### 1. Requirements

A Linux VPS (Debian/Ubuntu assumed). Core tools:

```bash
# Node.js 18+
node --version         # should print v18.x or newer

# System tools — install whatever your distro calls them:
tar zstd               # archiving + compression
pm2                    # if you use PM2 (https://pm2.keymetrics.io)
postgresql-client      # pg_dump, psql
sqlite3
openssh-client         # ssh (for SSH transfer and rsync)
rsync
curl                   # for FTP/FTPS transfer
bsdmainutils | util-linux   # for runuser
```

Optional tools (skip if you don't use the feature):

```bash
default-mysql-client mariadb-client-core   # only if you use MySQL/MariaDB
age                                          # only if you enable encryption
rclone                                       # only if transfer: "rclone" (S3, B2, R2, ...)
```

On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y nodejs npm tar zstd postgresql-client sqlite3 openssh-client rsync curl util-linux
# PM2 is installed per-project, not system-wide; see below

# OPTIONAL — pick what you need:
sudo apt install -y default-mysql-client        # for MySQL/MariaDB
sudo apt install -y age                         # for encryption (or: https://age-encryption.org)
curl https://rclone.org/install.sh | sudo bash  # for rclone (S3, B2, R2)
```

### 2. Clone & install

```bash
git clone https://github.com/theantiheroSE/aegis.git
cd aegis
npm install
```

`npm install` pulls one runtime dep (`neo-blessed` for the TUI). No build step.

### 3. First-time setup

Run with no config and the wizard starts automatically:

```bash
node aegis.mjs
```

```
┌─ Aegis first-time setup ────────────────────────────────────────────┐
│                                                                          │
│   1. SSH  (recommended)  — encrypted, uses an SSH keypair               │
│   2. FTP                  — plain FTP or FTPS, password auth             │
│   3. Cancel               — exit without changes                         │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

**SSH path** (recommended):

```
→ Generating ed25519 keypair at /root/.ssh/aegis_ed25519 ...
  ✓ Key generated.

┌── Add this PUBLIC key to your backup server ───────────────────────────┐
│                                                                          │
│  On the backup server, run:                                              │
│    mkdir -p ~/.ssh && chmod 700 ~/.ssh                                   │
│    echo 'ssh-ed25519 AAAA...aegis@vps.theantihero.se' >> ~/.ssh/authorized_keys │
│    chmod 600 ~/.ssh/authorized_keys                                      │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

Remote SSH host (e.g. backup.example.com): backup.example.com
Remote SSH user [backup]: backup
Remote SSH port [22]: 22
Remote backup directory [/backups/vps]: /backups/vps
Test the SSH connection now? [Y/n]: y
✓ Connection works.

→ System scan — discovering what's installed on this host…
┌── Found 7 item(s) in 0.4s ──────────────────────────────────────────────────┐
│  • PostgreSQL — PostgreSQL 18.4 — socket /var/run/postgresql                │
│  • SQLite — 11 file(s) in 11 dir(s): /var/www/baikal/Specific/db, ...      │
│  • nginx — /etc/nginx present (24 site configs)                            │
│  • PM2 — 7 app(s): spokbollsklubben, hockey-manager, logreader…              │
│  • Let's Encrypt certificates — /etc/letsencrypt (25 cert(s))              │
│  • Docker — 1 running container(s) — Aegis doesn't include container data  │
│  • Other configs — User crontabs, fail2ban jail config, SSH host config    │
└──────────────────────────────────────────────────────────────────────────────┘

Apply all 6 recommendation(s)? [Y/n]: y
✓ Applied 6 suggestion(s) to config.
✓ Setup complete. Launching TUI...
```

The scan probes for PostgreSQL, MySQL/MariaDB, SQLite, nginx, PM2, Let's Encrypt, Docker, and well-known config directories (Postfix, Dovecot, Redis, MongoDB, fail2ban, crontabs, SSH host config). Each detected item has a recommendation; you can accept all or pick individually with a numbered list.

**FTP path** (legacy):

```
→ FTP transfer — plain-text, password-based.
FTP host (e.g. ftp.example.com): ftp.example.com
FTP port [21]: 21
FTP user [backup]: backup
FTP password: ********
Remote backup directory [/backups/vps]: /backups/vps
Use FTPS (TLS)? [y/N]: n
Test the FTP connection now? [Y/n]: n
✓ Setup complete.
```

The wizard writes `config.json` (chmod 600) containing your secrets. **Never commit this file** — it's in `.gitignore` already.

If you'd rather skip the wizard:

```bash
cp config.example.json config.json
$EDITOR config.json       # set transfer, ssh OR ftp block, paths
chmod 600 config.json
```

### 4. First backup

Run a dry-run to validate everything:

```bash
node aegis.mjs --dry-run
```

Then a real one (interactive TUI):

```bash
node aegis.mjs              # TTY: launches the TUI
node aegis.mjs --skip-prune # non-TTY: one-shot CLI run
```

### 5. Install nightly cron

```bash
./install-cron.sh                       # default: 0 2 * * *  (02:00 daily)
./install-cron.sh "0 4 * * 0"           # weekly Sun 04:00
./install-cron.sh --show                # show current schedule
./install-cron.sh --uninstall           # remove
```

Or from the TUI: pick **Install / update cron** → choose a schedule (or **Custom** to type one).

Cron output is appended to `/var/log/aegis.cron.log`.

Re-run the wizard anytime with:

```bash
node aegis.mjs --setup          # only if missing/incomplete
node aegis.mjs --setup-force    # overwrite existing config
```

## Table of contents

- [TUI](#tui)
- [Layout](#layout)
- [What gets backed up](#what-gets-backed-up)
- [Destinations (SSH / FTP / S3)](#destinations-ssh--ftp--s3)
- [Encryption (age)](#encryption-age)
- [Notifications](#notifications)
- [Pre/post hooks](#prepost-hooks)
- [Restore verification](#restore-verification)
- [Configuration reference](#configuration-reference)
- [CLI flags](#cli-flags-backupmjs)
- [Notes & gotchas](#notes--gotchas)
- [Future work](#future-work)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## TUI

After setup, `node aegis.mjs` (no flags, on a TTY) launches the dashboard. During a backup, the right panel switches to a progress view with phase bars and live log:

```
┌─ Backup in progress — elapsed 0:42 ──────────────────────────────────────────┐
│ Phase            Progress                                       Status      Err│
│ postgres         ████████████████████████ 10/10 (100%)         ok          0  │
│ sqlite           ███████████████░░░░░░░░  7/11 (64%)           running     0  │
│ pm2              ████░░░░░░░░░░░░░░░░░░░░  3/7 (43%)            running     0  │
│ nginx            ░░░░░░░░░░░░░░░░░░░░░░░░░  —                  pending     0  │
│ extras           ░░░░░░░░░░░░░░░░░░░░░░░░░  —                  pending     0  │
│ archive          ░░░░░░░░░░░░░░░░░░░░░░░░░  —                  pending     0  │
│ upload           ░░░░░░░░░░░░░░░░░░░░░░░░░  —                  pending     0  │
│ prune            ░░░░░░░░░░░░░░░░░░░░░░░░░  —                  pending     0  │
│                                                                            │
│ ── Live log ──────────────────────────────────────────────────────────────  │
│ [22:43:18] ✓ pm2: musikbiblioteket (79.2 MiB)                               │
│ [22:43:18] ✓ pm2: efter (0.1 MiB)                                           │
│ ...
└──────────────────────────────────────────────────────────────────────────────┘
```

TUI keys: `↑/↓` or `j/k` to navigate, `Enter` to activate, `Esc` to cancel a modal, `r` to refresh status, `?` for help, `q` / `Ctrl-C` to quit.

When no config exists, the TUI shows a 3-item "First run" menu offering to run the setup wizard.

## Layout

```
Aegis/
├── aegis.mjs            # canonical entry point — auto-detects TTY, runs TUI or CLI
├── tui.mjs              # full-screen TUI (also handles non-TTY → CLI fallback)
├── backup.mjs           # one-shot CLI; also exports runBackup / uploadBundle / pruneRemote
├── restore.mjs          # interactive restore from a remote archive (SSH or FTP)
├── verify.mjs           # verify an archive's SHA256 and internal structure
├── install-cron.sh      # install / uninstall / show the nightly cron job
├── config.example.json  # template — normally created by the setup wizard
├── config.json          # your actual config (created by wizard, chmod 600)
├── lib/
│   ├── progress.mjs     # shared ProgressBus (events for TUI)
│   ├── setup.mjs        # first-time setup wizard
│   ├── notifications.mjs# webhook + email + SMTP channels
│   ├── retention.mjs    # prune-by-age logic
│   ├── state.mjs        # run history (state.json)
│   ├── colors.mjs       # ANSI helpers
│   └── logo.mjs         # TUI splash / completion art
├── logs/                # per-run logs (from CLI runs)
└── node_modules/        # neo-blessed, nodemailer
```

## Restore

The TUI menu has **Restore...** which lists remote backups and spawns `restore.mjs` for you.

From a shell:

```bash
node restore.mjs                              # list remote, prompt for which
node restore.mjs --list                       # only list
node restore.mjs --archive <name>             # download + verify + prompt restore
node restore.mjs --archive <name> --download-only   # just fetch+extract
node restore.mjs --archive <name> --yes       # skip confirmations (DANGEROUS)

# Date filtering (auto-pick newest backup ≤ --from if --archive omitted)
node restore.mjs --from 2026-07-15            # restore the most recent backup from before that date

# Cross-host restore (paths on the new host differ from the original)
node restore.mjs --archive <name> --map-root /var/www:/srv/www --map-root /etc:/opt/etc --yes

# Fresh-VPS recovery — installs services, restores data, starts everything
sudo node restore.mjs --archive <name> --bootstrap --map-root /var/www:/srv/www
```

The restore script dispatches on `config.transfer` — SSH uses `rsync` over ssh, FTP uses `curl`.

The script always asks before overwriting anything (unless `--yes` or `--bootstrap`). It restores:

- **PostgreSQL**: drops & recreates the DB, then `pg_restore` from the `.pgdump` file
- **SQLite**: copies the `.sqlitebak` back to its original path (from manifest)
- **PM2**: extracts the project tarball over its original `pm_cwd`
- **nginx**: copies back into `/etc/nginx/...`, then runs `nginx -t`

After a PM2 restore you'll need to `pm2 reload all` and possibly re-run `npm ci` for any apps whose `node_modules` were excluded.

### Fresh-VPS recovery (`--bootstrap`)

For a complete disaster-recovery scenario, `sudo node restore.mjs --archive <name> --bootstrap` will:

1. Install required system packages via apt (postgresql-server, nginx, sqlite3, etc. — only what's needed based on the manifest)
2. Install Node.js 20.x via NodeSource (if missing)
3. Install `pm2` globally via npm (if the manifest has PM2 items)
4. `systemctl enable --now` postgresql / nginx
5. Create the configured postgres role (so `pg_restore` works)
6. Run the normal restore
7. `npm ci` in each PM2 project's `cwd` (if `package.json` + lockfile present)
8. `pm2 start` each app with its original name + instance count, then `pm2 save`

Use `--map-root` together with `--bootstrap` if the destination host has a different filesystem layout (e.g., `/var/www` → `/srv/www`). The mapping is applied to `sqlite.source`, `pm2.cwd`, `pm2.script`, and `extras.path` before any file is written.

**Prerequisites**:
- The destination host has Node.js 18+ (or `--bootstrap` will install it via NodeSource)
- Your SSH private key (`config.ssh.identityFile`) is present on the new host at the path `config.json` says
- The `config.json` on the new host points to the same backup server (copy it from the original host)
- Run as root (required for apt + systemctl)

## Notifications

The TUI menu item **Configure notifications** lets you toggle three channels independently:

- **Webhook** — `POST` a JSON payload to a URL (Slack, Discord, ntfy, generic endpoint). Headers and method are configurable in `config.json`.
- **Email (local MTA)** — handed off to the local `mailx` / `sendmail` / `mail` binary. You only configure `to` and `from` here; the actual mail delivery uses whatever MTA is installed on the host.
- **SMTP (direct)** — sends via `nodemailer` straight from Node. The full host/port/user/pass/to/from are stored in `config.json`. No local MTA required. Toggle **Configure SMTP server...** in the TUI to set each field.

`onFailure` (default `true`) and `onSuccess` (default `false`) gate every channel.

### SMTP (direct) — recommended when there's no MTA

If your VPS has no working mail setup, use the built-in SMTP channel. Configure it from the TUI:

```
Configure notifications
  → Configure SMTP server...
      Server (host):   smtp.gmail.com
      Port:            587
      Username:        user@gmail.com
      Password:        ****
      Sender (from):   user@gmail.com
      Recipient (to):  ops@example.com
      Use TLS (465):   no (STARTTLS)
```

Or directly in `config.json`:

```json
"notifications": {
  "smtp": {
    "host": "smtp.gmail.com",
    "port": 587,
    "secure": false,
    "user": "user@gmail.com",
    "pass": "app-password",
    "from": "user@gmail.com",
    "to": "ops@example.com"
  }
}
```

- `secure: true` for port 465 (TLS-on-connect). `secure: false` for 587 (STARTTLS) — that's the default.
- For Gmail and most modern providers, you need an **app password**, not your account password.
- `config.json` is `chmod 600` — credentials are not world-readable.

### Email (local MTA) — when you already have a working MTA

If your VPS can send mail directly (postfix/exim/sendmail/msmtp already configured with a `smarthost` or direct MX), no extra setup is needed — just set `notifications.email.to` in the TUI. SMTP credentials stay in the MTA's own config:

| MTA | Where to put SMTP credentials |
|---|---|
| **postfix** | `relayhost = [smtp.gmail.com]:587` + `smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd` in `/etc/postfix/main.cf`, then `postmap /etc/postfix/sasl_passwd` and `systemctl reload postfix` |
| **exim4** | `dpkg-reconfigure exim4-config` → "mail sent by smarthost; received via SMTP or fetchmail" → enter the relay host + credentials when prompted |
| **msmtp** | `/etc/msmtprc` with `host`, `user`, `password`, `from` |
| **sendmail** | `/etc/mail/authinfo` + `makemap hash /etc/mail/authinfo < /etc/mail/authinfo` + a `mailertable`/`mailer` entry for the relay |

After configuring the MTA, test delivery from a shell:

```bash
echo "test" | mailx -s "Aegis test" you@example.com
```

If that works, the TUI's **Test notifications now** will work too.

### Dead-man's switch (healthchecks.io / Uptime Kuma)

Notifications fire when a run fails, but if cron never runs at all — server down, broken crontab, full disk — it's silent. Set `notifications.healthcheckUrl` and Aegis will ping it after every run:

- success → `GET <url>`
- failure → `POST <url>/fail`

Both [healthchecks.io](https://healthchecks.io) and [Uptime Kuma](https://github.com/louislam/uptime-kuma) use this protocol. Configure the URL via the TUI's notifications menu, or in `config.json`:

```json
"notifications": {
  "healthcheckUrl": "https://hc-ping.com/your-uuid-here"
}
```

The ping is **independent of `onSuccess` / `onFailure`** — a missing backup is the more dangerous failure mode and should alert even when other channels are muted. Use **Test healthcheck ping now** in the TUI to verify the URL works.

## What gets backed up

Aegis snapshots the following per run:

| source | how | output |
|---|---|---|
| **PostgreSQL** | `pg_dump -Fc -Z 9` per database | `postgres/<db>.pgdump` |
| **MySQL / MariaDB** | `mysqldump --single-transaction --routines --triggers --events` per database | `mysql/<db>.sql` |
| **SQLite** | `sqlite3 .backup` + `PRAGMA integrity_check` per file | `sqlite/<safe-name>.sqlitebak` |
| **PM2 projects** | `tar.zst` per project (with `node_modules`, `dist`, etc. excluded) | `pm2/<name>.tar.zst` |
| **nginx** | flat copy of `sites-available`, `sites-enabled`, `conf.d`, `nginx.conf` | `nginx/...` |
| **extra paths** | any file/directory you list in `extraPaths` | `extras/...` |

Each item is listed in `manifest.json` at the root of the archive, so restore.mjs knows where everything goes. Skip any component by setting its `enabled: false` (or leaving the block empty).

The whole tree is bundled into a single `aegis-<timestamp>.tar.zst`. Optional age encryption adds `.age` (see below).

## Destinations (SSH / FTP / S3)

`config.transfer` chooses how archives leave the box:

- **`"ssh"`** (default) — `rsync` over SSH. Aegis generates a dedicated ed25519 keypair during setup.
- **`"ftp"`** — plain FTP or FTPS via `curl`. Password is stored in `config.json` (chmod 600).
- **`"rclone"`** — any [rclone-supported backend](https://rclone.org/#providers): S3, Backblaze B2, Cloudflare R2, Google Cloud Storage, Azure Blob, Wasabi, SFTP, etc.

### S3 / B2 / R2 via rclone

```json
"transfer": "rclone",
"rclone": {
  "remote": "mys3",
  "path": "backups/aegis"
}
```

Before running, configure the remote once:

```bash
rclone config             # interactively create a remote named mys3
# or non-interactively:
rclone config create mys3 s3 provider=Cloudflare access_key_id=... secret_access_key=... region=auto
```

The TUI's **Test remote connection** entry works for rclone too (it runs `rclone lsf`).

## Encryption (age)

Aegis can encrypt the archive with [age](https://age-encryption.org) before upload. The backup server only sees ciphertext — no `.env`, no `config.json`, no database dumps, no SQL files.

```json
"encryption": {
  "recipients": ["age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"],
  "identityFiles": ["/root/aegis-backup.key"]
}
```

- `recipients` is an array — you can encrypt to multiple keys (e.g. a Yubikey key and a paper-backup key), so any one of them can decrypt.
- `identityFiles` is an array of paths to age identity files (used during restore). Generate a keypair with `age-keygen -o /root/aegis-backup.key` and copy the printed public key into `recipients`.

Encrypted archives end in `.tar.zst.age` (and a `.sha256` sidecar of the ciphertext). `restore.mjs` detects the `age-encryption.org/v1` magic header and prompts for decryption.

> Generate the keypair offline if you can — the private key is the only thing that can decrypt. Store the `.key` file somewhere outside the server (a password manager, a USB drive, your laptop).

## Pre/post hooks

Run arbitrary shell commands before/after backup and upload. Useful for things Aegis doesn't natively support (Redis BGSAVE, putting an app in maintenance mode, calling a third-party webhook, etc.).

```json
"hooks": {
  "preBackup":  ["docker stop myapp", "redis-cli bgsave"],
  "postBackup": ["docker start myapp"],
  "preUpload":  ["/usr/local/bin/aegis-pre-upload"],
  "postUpload": ["/usr/local/bin/aegis-post-upload"]
}
```

Commands run with `/bin/sh -c` so pipes and `&&` work. Environment:

| var | value |
|---|---|
| `AEGIS_PHASE` | `preBackup` \| `postBackup` \| `preUpload` \| `postUpload` |
| `AEGIS_TIMESTAMP` | ISO timestamp of the run start |
| `AEGIS_ARCHIVE_PATH` | absolute path to the just-built archive (postBackup+) |
| `AEGIS_CONFIG_PATH` | absolute path to `config.json` |

**Failure semantics:**
- `preBackup` / `preUpload` failure → aborts the run (exit 1)
- `postBackup` / `postUpload` failure → logged, run still counts as OK

Skip hooks for one run with `--skip-hooks`.

## Restore verification

A SHA256 sidecar proves the file transferred intact, not that its contents can be restored. The `--verify` flag extracts the archive and runs sanity checks on every component:

```bash
node restore.mjs --archive aegis-2026-07-22_10-30-00.tar.zst --verify
```

| component | check |
|---|---|
| `postgres/<db>.pgdump` | `pg_restore --list` (parses the TOC) |
| `sqlite/<file>.sqlitebak` | `PRAGMA integrity_check` |
| `mysql/<db>.sql` | applies to a scratch database, then drops it |
| `pm2/<name>.tar.zst` | `tar -t` lists file count |
| `extras/<name>.tar.zst` | `tar -t` lists file count |
| `nginx/nginx.conf` | `nginx -t -c <path>` |

Exits non-zero if any check fails. Missing binaries (e.g. `mysql` not installed on a postgres-only host) downgrade to "skipped", not "failed".

In the TUI, **Verify backup integrity** now offers three modes:

1. **Transport check** — sha256 only (the original `verify.mjs`)
2. **Content check** — extract + per-component verify (slow)
3. **Both** — transport first, then content if transport passes

The TUI's **Content check** mode runs `restore.mjs --verify --download-only` — no actual restore happens, just verification.

### Scheduled verification (`--verify-latest`)

For the "is my backup still actually restorable?" question, schedule a weekly cron that downloads just the latest archive and verifies it:

```bash
./install-cron.sh --verify           # adds Sun 06:00 by default
./install-cron.sh --verify "30 6 * * 0"   # or your own schedule
```

The cron entry calls `restore.mjs --verify-latest --yes`, which finds the newest archive, downloads it, runs the same per-component checks as `--verify`, then deletes the staging dir. Exits non-zero on any failure.

## Restore planning (`--plan`)

Before pulling the trigger on a real restore — especially across hosts or after a long time — preview what would happen:

```bash
node restore.mjs --archive aegis-2026-07-22_10-30-00.tar.zst --plan
```

Prints every component, where it would go, and what prompts would fire. Exits 0 without touching anything. Available in the TUI as **Browse → Show backup contents (preview)**.

## Configuration reference

See [`config.example.json`](./config.example.json). Notable fields:

| field | meaning |
|---|---|
| `transfer` | `"ssh"` (default), `"ftp"`, or `"rclone"` |
| `ssh.host` / `ssh.user` / `ssh.port` | SSH backup destination |
| `ssh.identityFile` | path to SSH private key (wizard creates `/root/.ssh/aegis_ed25519`) |
| `ssh.remoteDir` | remote directory for archives |
| `ftp.host` / `ftp.port` / `ftp.user` / `ftp.password` | FTP credentials |
| `ftp.secure` | use FTPS (TLS) instead of plain FTP |
| `ftp.remoteDir` | remote directory for archives |
| `rclone.remote` | name of an existing rclone remote (`rclone config`) |
| `rclone.path` | path inside the remote (e.g. `backups/aegis`) |
| `rclone.chunkSize` | optional chunk size for S3 multipart uploads (e.g. `"100M"`) |
| `retentionDays` | prune remote archives older than N days (default 7) |
| `retentionKeepLast` | always keep this many newest, regardless of age |
| `retention.daily` / `weekly` / `monthly` | GFS retention counts (alternative to age-based) |
| `encryption.recipients` | array of age public keys (`age1...`) to encrypt to |
| `encryption.identityFiles` | array of paths to age identity files (for restore) |
| `hooks.preBackup` / `postBackup` / `preUpload` / `postUpload` | shell commands to run around each phase |
| `postgres.enabled` | include all non-template DBs |
| `postgres.user` / `postgres.host` / `postgres.port` | how to connect |
| `postgres.runAs` | if set, `pg_dump`/`psql` are run via `runuser -u <runAs> --` — set this when your `pg_hba.conf` requires peer auth on the unix socket (which is the default on Debian/Ubuntu) |
| `mysql.enabled` | include all non-system MySQL/MariaDB databases |
| `mysql.host` / `mysql.port` / `mysql.user` / `mysql.password` | how to connect |
| `mysql.bin` / `mysql.dumpBin` | client binaries (default `mysql` and `mysqldump`) |
| `mysql.excludeDatabases` | DBs to skip (default: `information_schema`, `mysql`, `performance_schema`, `sys`) |
| `sqlite.searchPaths` | directories to recursively scan for `*.db`/`*.sqlite` |
| `sqlite.excludePaths` | path substrings to skip (e.g. caches) |
| `sqlite.patterns` | filename globs to consider SQLite |
| `pm2.excludeDirs` | relative paths excluded from each PM2 project tarball |
| `nginx.*` | what to copy from the nginx config tree |
| `extraPaths` | additional files / directories to include |
| `notifications.onFailure` | send notification when a backup fails (default `true`) |
| `notifications.onSuccess` | send notification on successful backup (default `false`) |
| `notifications.webhook.url` | webhook endpoint to `POST` JSON to |
| `notifications.webhook.method` | HTTP method (default `POST`) |
| `notifications.webhook.headers` | extra headers, e.g. auth tokens |
| `notifications.webhook.secret` | HMAC-SHA256 signing secret — adds `X-Aegis-Signature: sha256=<hex>` header so the receiver can verify the call is authentic |
| `notifications.email.to` | recipient address (passed to local `mailx`/`sendmail`) |
| `notifications.email.from` | sender address shown in the `From:` header |
| `notifications.smtp.host` | SMTP server hostname (direct SMTP channel via nodemailer) |
| `notifications.smtp.port` | SMTP port (default 587) |
| `notifications.smtp.secure` | `true` for TLS-on-connect (port 465), `false` for STARTTLS (default) |
| `notifications.smtp.user` / `pass` | SMTP credentials (config file is `chmod 600`) |
| `notifications.smtp.from` / `to` | sender / recipient addresses |
| `notifications.healthcheckUrl` | dead-man's switch endpoint (healthchecks.io / Uptime Kuma). Pings independently of `onSuccess`/`onFailure`. |
| `redis.enabled` | include a Redis snapshot (dumps `dump.rdb`) |
| `redis.host` / `redis.port` | where redis lives (default localhost:6379) |
| `redis.password` | optional AUTH password |
| `redis.path` | where to read `dump.rdb` from (default `/var/lib/redis/dump.rdb`) |
| `mongodb.enabled` | include MongoDB databases (uses `mongodump --gzip`) |
| `mongodb.host` / `mongodb.port` / `mongodb.user` / `mongodb.password` / `mongodb.authSource` | how to connect |
| `mongodb.db` | optional — if set, only this database is dumped; otherwise all non-system DBs |
| `aegis.enabled` | include the Aegis state bundle (config.json, ssh key, state.json, cron) in the archive, so it can be restored to bootstrap a fresh host |
| `archive.compressionLevel` | default zstd level for the outer archive (1-19, default 3) |
| `archive.compressionByPhase` | per-phase zstd level overrides, e.g. `{ "pm2": 19, "postgres": 3, "sqlite": 3, "extras": 9 }`. Postgres/sqlite are already compressed — high levels waste CPU. |
| `logging.dir` | where to write per-run logs (CLI mode) |

## CLI flags (`aegis.mjs` / `backup.mjs`)

```
-c, --config <path>     Config file (default: ./config.json)
-n, --dry-run           Build locally but skip remote upload and prune
    --skip-upload       Build locally, skip upload
    --skip-prune        Skip the remote prune step
    --skip-hooks        Skip configured pre/post hooks
    --only <stages>     Comma list: pm2,sqlite,postgres,mysql,redis,mongodb,nginx,extras,aegis
    --setup             Run first-time setup wizard
    --setup-force       Overwrite existing config
    --headless          (TUI internal) skip progress events
-h, --help
-V, --version
```

`node aegis.mjs` with **no** flags on a TTY launches the TUI. On a non-TTY or with any backup flag, it runs as a one-shot CLI.

`node restore.mjs` adds:

```
    --archive <name>     Restore this specific archive
    --from <ISO date>    Pick newest archive whose timestamp ≤ this date
    --to <ISO date>      Lower bound: only archives after this date
    --map-root OLD:NEW   Rewrite manifest paths (repeatable; cross-host)
    --bootstrap          Fresh-VPS recovery: install packages + start services
    --verify             After extract, run per-component content checks
    --download-only      Just download + extract (skip actual restore)
-y, --yes               Skip confirmations (dangerous)
```

## Notes & gotchas

- Backups include `.env` files inside PM2 project roots. They contain secrets. Use `encryption.recipients` so the backup server only sees ciphertext, or restrict access to the destination.
- For huge projects, `pm2.excludeDirs` is your main lever — `node_modules`, `dist`, `.next` are already excluded.
- The tool uses `zstd -T0` (all cores). Falls back to `gzip` if zstd isn't installed.
- The whole archive is one file. Restoring a single component is `tar -xf archive.tar.zst --wildcards '*/postgres/*'` etc. With encryption, decrypt first: `age -d -i key.txt -o archive.tar.zst archive.tar.zst.age`.
- CLI logs go to `logs/backup-<timestamp>.log` and include stdout/stderr of every spawned process. TUI logs are only shown in the live log panel during the run.
- Each run also writes a human-readable `logs/backup-<timestamp>-summary.md` and `-summary.html` next to the log. Both summarize status, components, sizes, errors, and the archive's SHA256 — useful for a quick eyeball check of "did last night succeed?" without opening the full log.
- `.env` files, SSH keys, and any `config.json` files **are not** excluded from your project tarballs. Don't commit secrets to git in the first place; backups will faithfully copy whatever you have.
- FTP password is stored in `config.json` in plaintext. That file is chmod 600 by the wizard. If you'd rather, move it to a `.netrc`-style file or an env var and edit `uploadBundle`/`pruneRemote` accordingly.
- The wizard generates an SSH key with no passphrase so cron can use it unattended. If you want a passphrase, generate the key yourself (`ssh-keygen -t ed25519 -f /root/.ssh/aegis_ed25519`) and update `config.json` to point at it; cron will need `ssh-agent` or a keychain helper then.
- Age keypair generation: `age-keygen -o /root/aegis-backup.key` prints the public key. Store the `.key` file somewhere outside the server (password manager, USB drive). Anyone with that file can decrypt every archive ever sent to that recipient.

## Future work

Some features were considered and deliberately deferred:

- **Incremental / dedup backups.** Aegis ships one full snapshot per run. A 2 GiB archive × 7 days = 14 GiB retention, which is fine for most VPSes, but a multi-TiB music library or photo archive makes full snapshots uneconomical. Borg / restic serve this niche well with content-defined chunking, in-place deduplication, and mountable snapshots — but adopting their archive format means abandoning `tar.zst`, the simple staging dir, the manifest, and most of the current restore flow. Rather than build a worse version of both, Aegis stays as a "full snapshot every run" tool. Use Borg/restic alongside if you need dedup.
- **Cross-host dedup at the block level.** Same reasoning — would change the archive format.
- **WebDAV / S3 direct (no rclone dep).** rclone already supports every S3-compatible backend Aegis would want to add (Cloudflare R2, Backblaze B2, Wasabi, MinIO, etc.). Wrapping the AWS SDK directly would add ~600 KB of deps for marginal gain.

## Troubleshooting

- **`Peer authentication failed for user "postgres"`** — set `postgres.runAs: "postgres"` in `config.json`. The script will then run pg_dump via `runuser`.
- **`Permission denied` writing to staging dir** — make sure `localStagingDir` lives on a filesystem writable by both your user and the postgres runAs user.
- **`No space left on device` on the remote** — increase `retentionDays` or remove old archives manually.
- **`rsync: connection unexpectedly closed`** — the remote SSH key isn't accepted. Test with `ssh -i <key> user@host` first, or use "Test remote connection" in the TUI.
- **FTP `curl: (67) Access denied`** — wrong user/password, or the FTP server doesn't allow the user to write to `remoteDir`. Test with `curl -u user:pass ftp://host/` manually.
- **MySQL backups silently skipped** — the binary `mysqldump` (or `mysql`) isn't on `$PATH`. Install `default-mysql-client` on Debian/Ubuntu, or set `mysql.bin` / `mysql.dumpBin` to absolute paths.
- **`age: command not found`** — install `age` from your package manager or from https://age-encryption.org. Encrypted archives can't be restored without it.
- **Restore says `archive is age-encrypted but config has no encryption.identityFiles`** — restore.mjs needs the matching identity file. Add `encryption.identityFiles: ["/path/to/aegis.key"]` to `config.json`.
- **`rclone: command not found`** — install rclone (`curl https://rclone.org/install.sh | sudo bash` or `apt install rclone`). The configured remote must exist; run `rclone config` first.
- **A specific SQLite file fails** — files matching `*.db` that aren't actually SQLite are auto-skipped with a warning. Check the manifest if you suspect a real DB is being missed.
- **TUI looks broken** — make sure your `TERM` is `xterm-256color` or similar. Try `unset TERM` then run again.
- **Setup wizard gets confused when piped** — readline needs real-time input. Run interactively in a terminal, not via `echo "..." | ...`. For automation, copy `config.example.json` to `config.json` and edit it directly.
- **`--verify` reports a failing component** — the archive contents don't pass the sanity check for that item. Investigate before assuming the backup is good: re-run with `--verify --download-only`, then check the extracted `manifest.json` and the failing item's file.

## See also

- [Migrating from Borg / restic / rsnapshot / duplicity](docs/migrating-from.md) — when to migrate, when to keep both, and the mechanical steps for each.

## License

MIT
