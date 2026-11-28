# Deploying the Crashpad GitHub App service

This directory is the deployment package for the approach in [docs/github-app.md](../docs/github-app.md#recommended-deployment):

- **one** long-lived `crashpad service` process on a small always-on Linux host with systemd;
- Caddy in front of it for HTTPS;
- state in `/var/lib/crashpad/state.json`;
- a daily backup timer.

The package ships inside the npm archive (`package/deploy/`).

**Status.** These files have been exercised locally:

- `backup.sh` and `healthcheck.sh` run in the automated tests against a real service process;
- `crashpad service check` and `crashpad service register` were tested against a fake GitHub.

The systemd units, `install.sh`, and the Caddyfile have **not** been run on a real host: no host has been provisioned. Treat the first deployment as their validation.

| File | Purpose |
|---|---|
| `install.sh` | Run as root on the host. Creates the `crashpad` user, installs the package globally, installs the configuration with mode 600, installs the units, validates the configuration, and starts the service and the backup timer. Re-run it to upgrade. |
| `crashpad.service` | systemd unit. `ExecStartPre` runs `crashpad service check`, so an invalid configuration never starts. Listens on `127.0.0.1:8787` only. |
| `crashpad-backup.service`, `crashpad-backup.timer` | Daily `backup.sh`, keeping 14 dated copies in `/var/lib/crashpad/backups`. |
| `backup.sh` | Copies `state.json`, verifies it is valid JSON, and prunes old copies. |
| `Caddyfile` | HTTPS. Exposes only `/github/webhook`, `/api/*`, and `/healthz`, with a 5 MB body limit and a 90 s timeout for companion long-polls. |
| `healthcheck.sh` | External check of a running service: health, webhook signature enforcement, token-protected companion API, nothing else exposed. |
| `service.env.example` | Every setting. `crashpad service register` writes the real file for you. |

## What you need

- A Linux host with systemd and a public IP address: Ubuntu 24.04 or Debian 12, 1 vCPU, 512 MB–1 GB RAM, a few GB of disk.
- A DNS name pointing at it, for example `crashpad.example.com`.
- On the host: Node.js 22.18 or later, installed system-wide so it is on systemd's default `PATH` (for example from NodeSource; not nvm), and Caddy.
- On your computer: Crashpad 0.3.0 installed, and a browser signed in to GitHub.

## Steps

Replace `crashpad.example.com` with your host name throughout.

**On your computer**

1. Register the App from its manifest. This writes the App's private key and a complete `service.env` (mode 600) into `./crashpad-app-credentials`:
   ```sh
   crashpad service register --url https://crashpad.example.com      # add --org <org> for an organization-owned App
   ```
   Open the printed `http://localhost:3999/` and confirm the App on GitHub. GitHub then sends you back to localhost, and the credentials are saved. Nothing else leaves your computer.
2. In the App's settings on GitHub, turn on **Enable Device Flow** and save. The manifest cannot set this, and companions pair through it.
3. Copy the package and the credentials to the host:
   ```sh
   scp crashpad-0.3.0.tgz crashpad-app-credentials/service.env crashpad-app-credentials/app.private-key.pem crashpad.example.com:
   ```

**On the host**

4. Install and start:
   ```sh
   tar -xzf crashpad-0.3.0.tgz package/deploy
   sudo sh package/deploy/install.sh ./crashpad-0.3.0.tgz ./service.env ./app.private-key.pem
   rm ./service.env ./app.private-key.pem        # the installed copies are in /etc/crashpad
   ```
5. Put Caddy in front:
   ```sh
   sudo cp package/deploy/Caddyfile /etc/caddy/Caddyfile
   sudo sed -i 's/crashpad.example.com/<your host name>/' /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```
6. Verify:
   ```sh
   sh package/deploy/healthcheck.sh https://crashpad.example.com
   sudo -u crashpad sh -c 'set -a; . /etc/crashpad/service.env; set +a; crashpad service check --online'
   ```
   `--online` asks GitHub whether the App ID, private key, slug, and client ID belong together, and whether the App has the required permissions and events.
7. In the App's settings, open **Advanced → Recent Deliveries** and redeliver the `ping`. It should get a 200. The first ping was sent before the service existed, so it failed.

Next: [install the App and connect your computer](../docs/github-app.md#3-install-the-app), then run the [acceptance test](../docs/acceptance.md).

## Operating it

- **Logs:** `journalctl -u crashpad -f`.
- **Upgrade:** copy the new `.tgz`, re-run `install.sh` with the same three arguments, and keep the `service.env` and key copies until then. State is kept.
- **Backups:**
  - `systemctl list-timers crashpad-backup.timer` shows the next run; `sudo systemctl start crashpad-backup.service` runs one now.
  - Local copies do not survive losing the disk. Also enable your provider's volume snapshots, or copy `/var/lib/crashpad/backups` off the host.
- **Restore:**
  ```sh
  sudo systemctl stop crashpad
  sudo install -m 600 -o crashpad -g crashpad /var/lib/crashpad/backups/state-<stamp>.json /var/lib/crashpad/state.json
  sudo systemctl start crashpad
  ```
  Jobs that ran after that backup are forgotten. Their check runs stay pending until someone re-runs them or pushes again.
- **Losing the state entirely:**
  - companions must run `crashpad connect` again;
  - repository repair policies return to their defaults (automatic repair off).

  Nothing in `state.json` is a GitHub token or key. Companion tokens are stored only as hashes.
- **Rotating the private key:** generate a new key in the App's settings, replace `/etc/crashpad/app.private-key.pem` (mode 600, owner `crashpad`), restart, then delete the old key on GitHub.
