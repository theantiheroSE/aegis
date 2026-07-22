---
layout: default
title: Aegis
description: Node.js backup tool for a single VPS — snapshots PM2, PostgreSQL, SQLite, nginx into .tar.zst, uploads via SSH/FTP, prunes old archives, notifies on success/failure.
theme: jekyll-theme-cayman
---

# Aegis

> Node.js backup tool for a single VPS — snapshots PM2 projects, PostgreSQL, SQLite, and nginx into one dated `.tar.zst` archive, uploads to your backup server over SSH or FTP, prunes old archives, and notifies you on success/failure.

[![Node](https://img.shields.io/badge/node-%E2%89%A518-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)
[![Platform](https://img.shields.io/badge/platform-linux--x64-lightgrey)](#requirements)

```
┌─ Aegis v1.2.0 — vps.theantihero.se ────────────────────────────────────────┐
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

- **All-in-one backup** — PM2 projects, PostgreSQL DBs, SQLite files, nginx config, and any extra paths you specify
- **Interactive TUI** — neo-blessed dashboard, one-shot setup wizard, no config editing required
- **One archive** — `.tar.zst` with a `.sha256` sidecar, `zstd -T0` (all cores)
- **SSH or FTP/FTPS** — SSH via ed25519 keypair (recommended), FTP for legacy destinations
- **Direct-SMTP notifications** — webhook, local-MTA, or SMTP credentials stored in the tool (no MTA needed)
- **Nightly cron** — single `install-cron.sh` line, retention by age
- **Restore from the TUI** — lists remote archives, downloads + verifies + restores in one go

## Installation

### 1. Requirements

A Linux VPS (Debian/Ubuntu assumed). You'll need:

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

On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y nodejs npm tar zstd postgresql-client sqlite3 openssh-client rsync curl util-linux
# PM2 is installed per-project, not system-wide; see below
```

### 2. Clone & install

```bash
git clone https://github.com/theantiheroSE/aegis.git
cd Aegis
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
✓ Setup complete. Launching TUI...
```

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
- [Notifications](#notifications)
- [Configuration reference](#configuration-reference)
- [CLI flags](#cli-flags-backupmjs)
- [Notes & gotchas](#notes--gotchas)
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
```

The restore script dispatches on `config.transfer` — SSH uses `rsync` over ssh, FTP uses `curl`.

The script always asks before overwriting anything. It restores:

- **PostgreSQL**: drops & recreates the DB, then `pg_restore` from the `.pgdump` file
- **SQLite**: copies the `.sqlitebak` back to its original path (from manifest)
- **PM2**: extracts the project tarball over its original `pm_cwd`
- **nginx**: copies back into `/etc/nginx/...`, then runs `nginx -t`

After a PM2 restore you'll need to `pm2 reload all` and possibly re-run `npm ci` for any apps whose `node_modules` were excluded.

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

## Configuration reference

See [`config.example.json`](./config.example.json). Notable fields:

| field | meaning |
|---|---|
| `transfer` | `"ssh"` or `"ftp"` |
| `ssh.host` / `ssh.user` / `ssh.port` | SSH backup destination |
| `ssh.identityFile` | path to SSH private key (wizard creates `/root/.ssh/aegis_ed25519`) |
| `ssh.remoteDir` | remote directory for archives |
| `ftp.host` / `ftp.port` / `ftp.user` / `ftp.password` | FTP credentials |
| `ftp.secure` | use FTPS (TLS) instead of plain FTP |
| `ftp.remoteDir` | remote directory for archives |
| `retentionDays` | prune remote archives older than N days (default 7) |
| `retentionKeepLast` | always keep this many newest, regardless of age |
| `postgres.enabled` | include all non-template DBs |
| `postgres.user` / `postgres.host` / `postgres.port` | how to connect |
| `postgres.runAs` | if set, `pg_dump`/`psql` are run via `runuser -u <runAs> --` — set this when your `pg_hba.conf` requires peer auth on the unix socket (which is the default on Debian/Ubuntu) |
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
| `notifications.email.to` | recipient address (passed to local `mailx`/`sendmail`) |
| `notifications.email.from` | sender address shown in the `From:` header |
| `notifications.smtp.host` | SMTP server hostname (direct SMTP channel via nodemailer) |
| `notifications.smtp.port` | SMTP port (default 587) |
| `notifications.smtp.secure` | `true` for TLS-on-connect (port 465), `false` for STARTTLS (default) |
| `notifications.smtp.user` / `pass` | SMTP credentials (config file is `chmod 600`) |
| `notifications.smtp.from` / `to` | sender / recipient addresses |
| `logging.dir` | where to write per-run logs (CLI mode) |

## CLI flags (`aegis.mjs` / `backup.mjs`)

```
-c, --config <path>     Config file (default: ./config.json)
-n, --dry-run           Build locally but skip remote upload and prune
    --skip-upload       Build locally, skip upload
    --skip-prune        Skip the remote prune step
    --only <stages>     Comma list: pm2,sqlite,postgres,nginx,extras
    --setup             Run first-time setup wizard
    --setup-force       Overwrite existing config
    --headless          (TUI internal) skip progress events
-h, --help
-V, --version
```

`node aegis.mjs` with **no** flags on a TTY launches the TUI. On a non-TTY or with any backup flag, it runs as a one-shot CLI.

## Notes & gotchas

- Backups include `.env` files inside PM2 project roots. They contain secrets. Treat remote backups accordingly (encryption at rest, restricted access).
- For huge projects, `pm2.excludeDirs` is your main lever — `node_modules`, `dist`, `.next` are already excluded.
- The tool uses `zstd -T0` (all cores). Falls back to `gzip` if zstd isn't installed.
- The whole archive is one file. Restoring a single component is `tar -xf archive.tar.zst --wildcards '*/postgres/*'` etc.
- CLI logs go to `logs/backup-<timestamp>.log` and include stdout/stderr of every spawned process. TUI logs are only shown in the live log panel during the run.
- `.env` files, SSH keys, and any `config.json` files **are not** excluded from your project tarballs. Don't commit secrets to git in the first place; backups will faithfully copy whatever you have.
- FTP password is stored in `config.json` in plaintext. That file is chmod 600 by the wizard. If you'd rather, move it to a `.netrc`-style file or an env var and edit `uploadBundle`/`pruneRemote` accordingly.
- The wizard generates an SSH key with no passphrase so cron can use it unattended. If you want a passphrase, generate the key yourself (`ssh-keygen -t ed25519 -f /root/.ssh/aegis_ed25519`) and update `config.json` to point at it; cron will need `ssh-agent` or a keychain helper then.

## Troubleshooting

- **`Peer authentication failed for user "postgres"`** — set `postgres.runAs: "postgres"` in `config.json`. The script will then run pg_dump via `runuser`.
- **`Permission denied` writing to staging dir** — make sure `localStagingDir` lives on a filesystem writable by both your user and the postgres runAs user.
- **`No space left on device` on the remote** — increase `retentionDays` or remove old archives manually.
- **`rsync: connection unexpectedly closed`** — the remote SSH key isn't accepted. Test with `ssh -i <key> user@host` first, or use "Test remote connection" in the TUI.
- **FTP `curl: (67) Access denied`** — wrong user/password, or the FTP server doesn't allow the user to write to `remoteDir`. Test with `curl -u user:pass ftp://host/` manually.
- **A specific SQLite file fails** — files matching `*.db` that aren't actually SQLite are auto-skipped with a warning. Check the manifest if you suspect a real DB is being missed.
- **TUI looks broken** — make sure your `TERM` is `xterm-256color` or similar. Try `unset TERM` then run again.
- **Setup wizard gets confused when piped** — readline needs real-time input. Run interactively in a terminal, not via `echo "..." | ...`. For automation, copy `config.example.json` to `config.json` and edit it directly.

## License

MIT
