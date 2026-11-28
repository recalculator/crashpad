# Setting up the Crashpad GitHub App

The service and the companion are implemented and tested locally against a fake GitHub (see [validation](validation.md#github-app-service-and-companion)). The steps below need your GitHub account and a publicly reachable URL, so **they have not been done yet**. Nothing has been registered or deployed.

## What you need

- A host that can run `crashpad service` (Node 22.18+) at a **public HTTPS URL**, because GitHub must be able to deliver webhooks to it. The service stores its state in one JSON file. It runs no repository code and needs no PostgreSQL or Claude.
- On each computer that should run checks: Crashpad installed, PostgreSQL reachable, and optionally Claude Code signed in for repairs.

## Recommended deployment

This is a recommendation, not a record: nothing has been deployed.

**Shape.** Run **one** long-lived service process on a small always-on host. Examples: a $5–10/month VPS (1 vCPU, 512 MB–1 GB RAM) running systemd, with Caddy or nginx for TLS; or a single container with an attached volume (a Fly.io Machine with a volume, Railway, or Render with a disk). Do **not** use serverless functions or more than one replica, for three reasons:

- the job queue and long-poll leases live in one process;
- state is a single JSON file written by that process;
- the `job` wake-up event is in memory.

**Software.** Node.js 22.18 or later, and Crashpad installed from the `npm pack` archive (`npm install -g ./crashpad-0.3.0.tgz`). The host needs no PostgreSQL, Git checkout, or Claude Code. The service never runs repository code.

**Configuration** (environment variables):

| Variable | Value |
|---|---|
| `CRASHPAD_GITHUB_APP_ID` | the App ID |
| `CRASHPAD_GITHUB_CLIENT_ID` | the App's client ID (used for device-flow pairing) |
| `CRASHPAD_GITHUB_APP_SLUG` | the App slug (loop prevention uses the bot login `<slug>[bot]`) |
| `CRASHPAD_GITHUB_PRIVATE_KEY_FILE` | path to the `.pem`, owned by the service user, mode `600`, or a mounted secret |
| `CRASHPAD_GITHUB_WEBHOOK_SECRET` | a long random string (for example from `openssl rand -hex 32`), from a secret store |
| `CRASHPAD_SERVICE_DATA` | a file on **persistent** storage, for example `/var/lib/crashpad/state.json` |
| `CRASHPAD_GITHUB_API_URL`, `CRASHPAD_GITHUB_URL` | leave unset for github.com |

Run it with `crashpad service --host 127.0.0.1 --port 8787` behind the TLS proxy. The proxy must:

- allow request bodies up to 5 MB (the service's webhook limit);
- keep idle connections open for at least 60 s, because companions long-poll for 25 s;
- expose only `/github/webhook`, `/api/*`, and `/healthz`.

Use `GET /healthz` for health checks.

**Persistent storage.** `state.json` holds:

- installations and their repository selection;
- paired companions, **as token hashes only**;
- jobs, with their check-run ids and leases;
- per-repository repair policies;
- recent webhook delivery ids.

It holds no GitHub tokens, no private key, and no Claude credentials. Back it up daily, and keep it on a volume that survives redeploys. Losing it means:

- companions must pair again;
- queued or running jobs are forgotten, and their check runs stay pending until someone clicks Re-run or pushes again;
- per-repository policies are reset to their defaults (automatic repair off).

**Example systemd unit** (Caddy in front, with `crashpad.example.com { reverse_proxy 127.0.0.1:8787 }`):

```ini
[Unit]
Description=Crashpad GitHub App service
After=network-online.target

[Service]
User=crashpad
EnvironmentFile=/etc/crashpad/service.env      # the variables above; file mode 600
ExecStart=/usr/bin/crashpad service --host 127.0.0.1 --port 8787
Restart=on-failure
StateDirectory=crashpad                         # /var/lib/crashpad for CRASHPAD_SERVICE_DATA

[Install]
WantedBy=multi-user.target
```

**Deployment package.** Everything above is packaged in [`deploy/`](../deploy/README.md), which also ships inside the npm archive:

- `install.sh`, which creates the user and directories, installs the configuration with mode 600 and the units, validates, and starts;
- the systemd unit, with `ExecStartPre=crashpad service check`;
- the daily backup timer and `backup.sh`;
- the Caddyfile, exposing only the service's paths;
- `healthcheck.sh`.

**Account actions, in order.** These are all yours, and each needs your GitHub login or your hosting account. The details are in [deploy/README.md](../deploy/README.md#steps).

1. **Host and name.** Get the host (for example a small VPS) and a DNS name pointing at it. Install Node.js 22.18+ (system-wide) and Caddy on it.
2. **Register the App** from your computer: `crashpad service register --url https://<host>`. Add `--org <org>` for an organization-owned App; otherwise it is owned by your personal account. Confirm on GitHub. The private key and `service.env` are written locally with mode 600.
3. **Enable Device Flow** in the App's settings.
4. **Deploy:** copy the archive and the two credential files to the host, then run `sudo sh package/deploy/install.sh …`. Install the Caddyfile.
5. **Verify:**
   - `deploy/healthcheck.sh https://<host>`;
   - on the host, `crashpad service check --online`;
   - redeliver the App's `ping` from **Advanced**, and expect a 200.
6. **Install the App** on **selected repositories**: start with one low-risk repository you own that has something for Crashpad to check.
7. **Connect your computer:** `crashpad connect --service https://<host>`, `crashpad setup`, then `crashpad companion --enable-repair` (repairs are optional), and keep `crashpad companion` running.
8. Run the [acceptance test](acceptance.md).

**Before you rely on it:** none of the GitHub calls have run against github.com yet (see the end of this page). Treat the first week as validation, and keep the GitHub Actions integration if you already use it.

## 1. Register the App

`crashpad service register --url https://crashpad.example.com` serves a one-shot local page at `http://localhost:3999/`. It posts the manifest to GitHub (`/settings/apps/new`, or `/organizations/<org>/settings/apps/new` with `--org`). After you confirm, GitHub redirects back to localhost with a one-time code. Crashpad then exchanges the code (`POST /app-manifests/{code}/conversions`) and writes two files with mode 600:

- `crashpad-app-credentials/app.private-key.pem`;
- `crashpad-app-credentials/service.env`: App ID, client ID, slug, webhook secret, and the host paths.

The code works once and expires after an hour. Existing files are never overwritten.

`crashpad service manifest --url https://crashpad.example.com` prints the same manifest, if you prefer GitHub's manual **New GitHub App** form. The manifest:

- requests **Checks: write**, **Contents: write** (to create fix branches), **Pull requests: write** (draft fix PRs), and **Metadata: read**;
- subscribes to `pull_request` and `check_run`; GitHub also sends `installation` and `installation_repositories` to every App;
- keeps the App **private**.

Then, in the App's settings, turn on **"Enable Device Flow"**. The manifest cannot set it, and the companion pairs with it.

## 2. Run the service

With the deployment package, `install.sh` installs `/etc/crashpad/service.env` and starts the unit. To run it by hand:

```sh
set -a; . ./service.env; set +a        # the file written by crashpad service register
crashpad service check --online        # validate locally, then ask GitHub whether ID, key, slug, and client ID match
crashpad service --host 127.0.0.1 --port 8787   # behind HTTPS (deploy/Caddyfile)
```

`crashpad service` runs the same validation and refuses to start if anything is wrong. The App's private key and webhook secret stay on this host; they are unrelated to anyone's Claude Code sign-in. `GET /healthz` returns `{"ok":true,"version":…,"storage":"ok","companionsOnline":N}`, or 503 if the state directory is not writable.

## 3. Install the App

On GitHub, open `https://github.com/apps/<slug>/installations/new`. Choose your account or organization, and choose **All repositories** or **Only select repositories**. Crashpad acts only on the repositories in that selection, and follows changes to it.

## 4. Connect your computer (once)

```sh
crashpad connect --service https://crashpad.example.com
# → "open https://github.com/login/device and enter the code XXXX-XXXX"
crashpad companion --enable-repair     # optional: allow Claude repairs on this machine (uses your Claude usage)
crashpad setup                         # checks prerequisites and discovers every repository in the installation
crashpad companion                     # keep it running (for example as a login item or a systemd user service)
```

Optional: turn on automatic repair for a repository with `crashpad policy --repo owner/name --auto-repair on`. It is off by default.

## What to expect

- **New and updated pull requests** get a **Crashpad** check:
  - **queued** at first, with a message saying whether your companion is online;
  - **in progress** while it runs on your computer;
  - **success** or **failure** when it finishes, with the full report and file annotations.
- **Fork PRs** and authors without write access show **action required** with a **Run Crashpad** button. Clicking it needs write access.
- **Failed checks** on trusted PRs offer **Repair with Claude**. A repair produces a separate **Crashpad repair** check. If the repair is verified, a draft PR into the PR's branch opens.
- **While your computer is off,** checks stay pending and say so.

## Not yet verified live

All of the following has been exercised only against the fake GitHub in `test/integration/github-app.test.ts`:

- App JWT and installation-token exchange with github.com;
- real webhook deliveries and their payload variants;
- check-run rendering and annotation limits on github.com;
- device-flow pairing against github.com;
- the Git Data API calls that create fix branches;
- manifest registration and the code exchange (`crashpad service register`), and `crashpad service check --online`;
- the systemd units, `install.sh`, and the Caddyfile on a real host.

The [acceptance test](acceptance.md) verifies them.
