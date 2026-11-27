# Setting up the Crashpad GitHub App

The service and the companion are implemented and tested locally against a fake GitHub (see [validation](validation.md#github-app-service-and-companion)). The steps below need your GitHub account and a publicly reachable URL, so **they have not been done yet**. Nothing has been registered or deployed.

## What you need

- A host that can run `crashpad service` (Node 22.18+) at a **public HTTPS URL**, because GitHub must be able to deliver webhooks to it. The service stores its state in one JSON file. It runs no repository code and needs no PostgreSQL or Claude.
- On each computer that should run checks: Crashpad installed, PostgreSQL reachable, and optionally Claude Code signed in for repairs.

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
