# Migrating to Aegis from another backup tool

Aegis is opinionated: it's a *full-snapshot-every-run* tool built around a
plain `.tar.zst` archive and a `manifest.json` that names every component
inside. If you're coming from one of the tools below, this page covers:

1. What stays the same (and why moving is mostly painless).
2. What you lose (mostly dedup / incremental storage).
3. The actual mechanical steps to cut over.

## Honest comparison

| Tool          | Dedup | Incremental | Restore granularity | Aegis equivalent |
|---------------|-------|-------------|---------------------|------------------|
| **Borg**      | Yes (CD chunks) | Yes (per-archive) | File-level in any archive | Keep using Borg |
| **restic**    | Yes (CD chunks) | Yes (per-snapshot) | File-level in any snapshot | Keep using restic |
| **rsnapshot** | No (hardlinks) | Daily/weekly/hourly levels | Whole rsync tree | Use Aegis if you have < 50 GB total |
| **duplicity** | Yes (incremental tar) | Yes (per-chain) | Single file at a time | Aegis if you don't need dup-backend chains |

**Short version:** if your top reason for your current tool is *storage
efficiency on a slow-changing dataset*, Aegis isn't the upgrade you're
looking for. Run Aegis *alongside* your existing dedup tool — use Borg
for the big tree of static files, use Aegis for the application state
that needs to be restorable piece by piece (databases, configs, sites).

If your top reason is *I just want a complete, restorable snapshot I can
grab with one command*, Aegis is the upgrade.

## Why Aegis exists in spite of Borg/restic

- **Plain tar.zst archives.** You can `zstd -dc aegis.tar.zst | tar -xf -`
  with no special tool. A borg/restic repo is opaque without the daemon.
- **Manifest-driven restore.** `restore.mjs --archive <name> --verify`
  knows what each component is and how to put it back. Borg/restic
  restore everything as files and leave you to figure out where
  `postgresql.conf` goes.
- **Single config file, single CLI.** No repo keys, no append-only
  semantics, no chunk store, no separate server.
- **TUI.** No equivalent in Borg/restic — both are CLI-only.
- **Small surface area.** Aegis is ~3,000 lines of Node, ~600 lines of
  bash. Borg is 50k+ lines of C, restic is 30k+ lines of Go. Easier to
  audit; easier to fix.

## From Borg

### Keep the repo
Aegis and Borg solve different problems. You can have both on the same
host: Borg for `/var/www`, Aegis for `postgres` + `nginx` + `pm2`.

If you *do* want to fully migrate, the migration is just *stop running
borg*. Aegis doesn't read or write the borg repo. There's no data to
convert — borg's chunked storage has no equivalent on the Aegis side.

### Config translation

`borg` config:
```ini
[repository]
location = ssh://backup@nas.local/./repo

[archive]
name = {hostname}-{now}

[retention]
keep_daily = 7
keep_weekly = 4
keep_monthly = 6
```

Aegis `config.json`:
```json
{
  "transfer": "ssh",
  "ssh": {
    "host": "nas.local",
    "user": "backup",
    "identityFile": "/root/.ssh/aegis_ed25519",
    "remoteDir": "/backups/aegis"
  },
  "retention": {
    "maxDaily": 7,
    "maxWeekly": 4,
    "maxMonthly": 6
  }
}
```

### Restore: a borg archive → an Aegis run

`borg extract` gives you a tree of files. `restore.mjs` from an Aegis
archive calls `pg_restore`, `sqlite3`, `mongorestore`, `pm2 start`, etc.
— the restore *understands* the components. If you've been running
`borg extract ... && systemctl restart postgresql && su -c "psql ... < dump"`
by hand, Aegis collapses that into one command.

## From restic

Same story as Borg: keep using restic if dedup matters. Aegis is a
complement, not a replacement, in most cases.

If you want to fully migrate, the steps are:

1. Run a final restic snapshot so you have a complete baseline.
2. Install Aegis and run `node aegis.mjs --setup`.
3. Run a first Aegis backup with `node aegis.mjs` (the TUI) → "Backup now".
4. Verify the archive: `node restore.mjs --archive <latest> --verify --download-only`.
5. Spot-check the restore by extracting to a scratch dir and comparing
   against `restic restore latest --target /tmp/check`.
6. Once confident, uninstall restic: `apt remove restic && rm -rf /var/lib/restic`.

### restic's `restic forget --prune` vs Aegis's prune

Aegis prunes by age:
```json
"retention": {
  "maxDaily": 7,
  "maxWeekly": 4,
  "maxMonthly": 6
}
```

This is a coarser policy than restic's "keep N most recent, then N most
recent within each window" — but for full-snapshot tools, age-based is
the natural one.

## From rsnapshot

rsnapshot is the closest in spirit to Aegis: full snapshots via hardlinks,
no dedup, age-based retention. The migration is almost literal:

1. List your rsnapshot roots: `ls /var/cache/rsnapshot/`.
2. The contents map roughly to Aegis's `extras` paths. The cron entries
   map roughly to Aegis's `crontab.txt` (in the aegis state bundle).
3. Install Aegis, add each rsnapshot root to `cfg.extraPaths`. Skip
   rsnapshot's rotation — let Aegis do it via `cfg.retention`.

The win: rsnapshot is hardlink-based, which means restoring a file from
3 months ago still requires all the snapshots between then and now.
Aegis's archives are independent — restore from any one without reading
any of the others.

## From duplicity

duplicity does incremental encrypted tar. If you need to migrate off it:

1. Run a final full backup: `duplicity full / ssh://...`.
2. Confirm the most recent chain still verifies: `duplicity verify ...`.
3. Install Aegis, point it at the same backend (or a different one).
4. Run a full Aegis backup alongside for at least one cycle.
5. When confident, `apt remove duplicity && rm -rf ~/.cache/duplicity`.

The reason to migrate off duplicity is usually *speed of restore* —
duplicity has to walk the entire incremental chain to reassemble the
latest state, which gets slow over months. Aegis restores from a single
archive in one pass.

## Backup of the Aegis itself

Once Aegis is running, `cfg.aegis.enabled: true` (in v1.4.0+) makes the
Aegis state part of the regular backup:

- `config.json` — your full config
- The SSH key used to talk to the remote (`cfg.ssh.identityFile`)
- `state.json` — last-N run history, used by the TUI dashboard
- `crontab.txt` — current cron entries (so a fresh VPS gets your schedule)

That means the restore command on a fresh host can rebuild *Aegis too*,
not just the things Aegis was backing up. This is what `restore.mjs
--bootstrap` is for.

## Side-by-side: a single command

| Task | Borg | restic | Aegis |
|------|------|--------|-------|
| Run a backup | `borg create ...` | `restic backup ...` | `node aegis.mjs` |
| List backups | `borg list` | `restic snapshots` | `node restore.mjs --list` |
| Verify a backup | `borg check` | `restic check` | `node restore.mjs --verify-latest` |
| Restore everything | `borg extract` | `restic restore latest` | `node restore.mjs --archive <name>` |
| Restore a single file | `borg extract path/to/file` | `restic restore latest --target / --include path/to/file` | (re-run `--archive` with `--only extras`) |
| Restore a single DB | `borg extract && psql < dump` | `restic restore && psql < dump` | `node restore.mjs --archive <name> --only postgres` |
| Prune old backups | `borg prune` | `restic forget --prune` | automatic on each backup |
| Encrypt | built-in (repokey) | built-in | `age` per-recipient (in `cfg.encryption`) |

## When *not* to migrate

- You're already happy with Borg/restic and your backup window is small
  (because of dedup).
- You need file-level restore from arbitrary points in time, with cheap
  storage of all those points. Aegis stores every snapshot as a full
  archive; that gets expensive fast.
- You need FUSE mounts to browse backups (Borg has `borg mount`; restic
  has `restic mount`). Aegis has `restore.mjs --plan` for a textual
  listing, but no FUSE equivalent.

In any of these cases, run Aegis in addition to your existing tool, not
instead of it.
