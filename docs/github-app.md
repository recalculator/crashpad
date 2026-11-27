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

**Software.** Node.js 22.18 or later, and Crashpad installed from the `npm pack` archive (`npm install -g ./crashpad-0.2.0.tgz`). The host needs no PostgreSQL, Git checkout, or Claude Code. The service never runs repository code.

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

**Account actions, in order** (all yours; each needs your GitHub login):

1. Choose the App owner. Use your personal account (`recalculator`) unless the App will serve an organization.
2. Register the App from the manifest (step 1 below) and set the webhook secret.
3. Turn on **Enable Device Flow**, generate the private key, and note the App ID, client ID, and slug.
4. Deploy the service with those values and confirm that `https://<host>/healthz` returns `{"ok":true}`. Use the App's **Advanced** tab to check that the `ping` delivery got a 200.
5. Install the App on **selected repositories**, starting with one low-risk repository you own. The trial repository, `Willo-Story-Generation`, is a good first candidate.
6. On your computer: `crashpad connect --service https://<host>`, then `crashpad setup`, then `crashpad companion`. Run `crashpad companion --enable-repair` only if you want Claude repairs.
7. Open a small test PR and confirm the **Crashpad** check moves from pending to running to completed. Then test the offline message by stopping the companion.

**Before you rely on it:** none of the GitHub calls have run against github.com yet (see the end of this page). Treat the first week as validation, and keep the GitHub Actions integration if you already use it.

## 1. Register the App

1. Print a manifest with your service's public URL:
   ```sh
   crashpad service manifest --url https://crashpad.example.com > manifest.json
   ```
   The manifest requests these permissions: **Checks: write**, **Contents: write** (to create fix branches), **Pull requests: write** (draft fix PRs), and **Metadata: read**. It subscribes to the `pull_request` and `check_run` events. GitHub also sends `installation` and `installation_repositories` events to every App.
2. Register it, either with GitHub's [manifest flow](https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) or by entering the same values under **Settings → Developer settings → GitHub Apps → New GitHub App**:
   - Webhook URL: `https://crashpad.example.com/github/webhook`.
   - Webhook secret: a long random string.
   - Keep the App **private** unless others should install it.
3. In the App's settings:
   - Turn on **"Enable Device Flow"**. The companion pairs with it.
   - Generate a **private key** and download the `.pem` file.
   - Note the App ID, client ID, and slug.

## 2. Run the service

```sh
export CRASHPAD_GITHUB_APP_ID=123456
export CRASHPAD_GITHUB_CLIENT_ID=Iv1.xxxxxxxx
export CRASHPAD_GITHUB_APP_SLUG=crashpad-yourname     # bot login <slug>[bot], used for loop prevention
export CRASHPAD_GITHUB_PRIVATE_KEY_FILE=/secure/path/crashpad.private-key.pem
export CRASHPAD_GITHUB_WEBHOOK_SECRET=…               # the same secret as in the App settings
export CRASHPAD_SERVICE_DATA=/var/lib/crashpad/state.json
crashpad service --host 0.0.0.0 --port 8787           # put it behind HTTPS (a reverse proxy or a platform's TLS)
```

The App's private key and webhook secret stay on this host. They are unrelated to anyone's Claude Code sign-in.

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
- the Git Data API calls that create fix branches.

Run steps 1–4 and open a test PR in a repository you control to verify them.
