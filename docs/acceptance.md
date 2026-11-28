# Acceptance test: the GitHub App end to end

This is the first live run of the GitHub App path. **It has not been run yet.** Until it passes, everything from the App's webhooks to the draft fix PR is verified only against a fake GitHub (see [validation](validation.md)).

The run covers: **install App → connect companion → receive a real PR event → run checks → request Claude repair → verify patch → open a draft fix PR.**

## Before you start

- The service is deployed and healthy: `deploy/healthcheck.sh https://<host>` passes, and `crashpad service check --online` reports no errors (see [deploy/README.md](../deploy/README.md)).
- **Choose the test repository.** Pick one repository you own where Crashpad has something to check, and install the App only there (**selected repositories**). Willo is the one where a check and a live Claude repair already worked locally.
- **The test PR is a validation PR, not a showcase.** Open it on a branch named for the purpose, for example `crashpad-acceptance`, close it after the run, and delete both branches (yours and the `crashpad/fix-*` branch).
- On your computer: Crashpad 0.3.0, PostgreSQL reachable, and Claude Code signed in (`claude auth status`).

Record each **Record** item below; together they make the validation entry.

## Steps

1. **Install the App.** Open `https://github.com/apps/<slug>/installations/new`, choose your account, then **Only select repositories**, and select the test repository.
   - Expect: `journalctl -u crashpad` logs the `installation` event, and the App's **Advanced → Recent Deliveries** shows a 200.
   - Record: the delivery ID.
2. **Connect the companion.**
   ```sh
   crashpad connect --service https://<host>     # enter the code at https://github.com/login/device
   crashpad setup                                # discovers the installation's repositories
   crashpad companion --enable-repair            # allows Claude repairs on this computer
   crashpad companion                            # keep it running in a terminal for the test
   ```
   - Expect: `connect` prints your login and installation; `setup` lists the test repository with per-area readiness; `crashpad companion status` shows "online".
   - Record: the `setup` output for the repository.
3. **Receive a real PR event and run checks.** On a branch `crashpad-acceptance`, commit a small change that Crashpad should catch, and open a PR. For Willo, the change from the local trial works: rename an exported function in one file and not in its caller, so startup fails.
   - Expect: a **Crashpad** check appears on the PR. It goes **queued** (saying your companion is online), then **in progress**, then **failure**, with the report and annotations, and a **Repair with Claude** button.
   - Record: the check-run URL, the job's lines in the companion output, and the report headline.
4. **Request a Claude repair.** Click **Repair with Claude** on the check run.
   - Expect: a **Crashpad repair** check that runs on your computer. Your Claude Code makes a bounded attempt, and Crashpad re-verifies the patch against the original expectations and the project's commands.
   - Record: the attempt count, turns, and estimated cost from the repair check's summary.
5. **Verify the patch.** The repair check says **verified** only if every check passes again against the failing commit's original expectations.
   - Independently: fetch the fix branch, run the project's own build and tests, and run `crashpad check --base <PR base>` on it.
   - Record: both results.
6. **Draft fix PR.**
   - Expect: a **draft** PR from `crashpad/fix-*` into your `crashpad-acceptance` branch, opened by `<slug>[bot]`. Its body has the verification summary. Its parent commit is the PR's exact head.
   - Crashpad checks it, but never offers to repair it (loop prevention).
   - Record: the PR URL and the commit SHAs.
7. **Offline behaviour.** Stop the companion and push one more commit.
   - Expect: the check stays **queued** with a message that the companion is offline.
   - Then restart the companion and confirm the job runs.
8. **Clean up.** Close both PRs and delete the `crashpad-acceptance` and `crashpad/fix-*` branches. Uninstall the App from the test repository if you are not keeping it.

## If a step fails

| Symptom | Look at |
|---|---|
| No check appears | **Advanced → Recent Deliveries** (status, response body); `journalctl -u crashpad`; whether the repository is in the installation's selection |
| Delivery shows 401 | The webhook secret in `/etc/crashpad/service.env` does not match the App's |
| Check stays queued with the companion online | `crashpad companion status`; the companion's terminal output; the job lease in `journalctl` |
| `connect` fails | Device Flow is not enabled in the App's settings, or `CRASHPAD_GITHUB_CLIENT_ID` is wrong (`crashpad service check --online`) |
| Repair never starts | Repairs not enabled on the companion (`--enable-repair`); the clicker lacks write access; the per-PR repair bound was reached |
| Fix PR not opened | The service log for the Git Data API calls (blob, tree, commit, ref, then PR); the PR head moved since the job started (by design, nothing is published) |

Afterwards, add the recorded results to `docs/validation.md` under a live section. Move each verified item out of the "Not yet verified live" lists in `docs/github-app.md` and the README.
