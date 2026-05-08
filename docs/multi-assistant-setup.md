# Multi-Assistant Slack Bridge Setup

Setup recipe for running one `claude-slack-bridge` instance per assistant, each with its own dedicated Slack app. This is the supported architecture; the older "one Slack app, multiple bridges" design doesn't actually work because Slack load-balances events across connected sockets, so messages get dropped.

## Architecture

- **1 Slack app per assistant.** /ivy lives on the Ivy Slack app, /jude on Jude's, etc.
- **1 bridge process per assistant.** Each bridge connects to exactly one Slack app.
- **Bridge runs where the assistant's repo lives.** Each bridge spawns Claude Code with `cwd` set to the assistant's working directory; the working directory must be on the local filesystem.
- **No `PEER_ASSISTANTS`.** With one app per bridge, there's no peer coordination needed; events for a given app only reach that app's bridge.

| Assistant | Machine | Working dir | Slack app | Channel |
|---|---|---|---|---|
| Ivy | Mac Studio | `/Users/tbarsnes/projects/ivy` | "Ivy" (new) | `#C0B2FE6FAG5` (existing) |
| Jude | Linux box | `/home/tbarsnes/projects/jude` | "Tim Claude Bridge" (existing, rename to "Jude" optional) | (Jude's own, TBD) |
| Huahua | Huahua's Windows VM | `<C:\path\to\huahua>` | "Huahua" (new) | (Huahua's own, TBD) |
| Trey | Trey's Windows VM | `<C:\path\to\trey>` | "Trey" (new) | (Trey's own, TBD) |

## Pre-flight (do this once, on the Mac)

The Mac currently has three patches sitting uncommitted on top of `tbarsness/claude-slack-bridge` `main`. Each VM (and the Linux/Jude bridge) needs these. Easiest path: commit and push to `origin/main`, then clone fresh on each VM.

```sh
cd ~/projects/claude-slack-bridge
git status   # should show 3 modified files: src/claude.ts, src/index.ts, src/slack.ts
git add src/claude.ts src/index.ts src/slack.ts
git commit -m "Slash-prefix guard, socket watchdog, pong-timeout interceptor"
git push origin main
```

Patch summary (for the commit message or PR body):
1. `src/claude.ts` — prepend a space to prompts starting with `/` so the Claude Code subprocess doesn't interpret them as CLI slash commands and bail with empty output.
2. `src/index.ts` — exit code 2 on socket disconnect (after 30s grace) and on `auth.test()` heartbeat failure (every 60s). Lets launchd / systemd / NSSM respawn cleanly.
3. `src/slack.ts` — pass a custom Bolt logger that intercepts socket-mode "pong wasn't received" WARN messages and exits with code 2. Catches the silent-socket-death case the disconnect handler misses.

---

## Per-assistant Slack app (do this once per assistant, in your browser)

Repeat for **Ivy**, **Huahua**, **Trey**. Each takes ~10 min.

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**. Name it `Ivy` (or `Huahua` / `Trey`). Pick the fjorge workspace.
2. **OAuth & Permissions** → **Bot Token Scopes** → add all of: `app_mentions:read`, `channels:history`, `chat:write`, `commands`, `groups:history`, `im:history`, `im:write`, `mpim:history`, `mpim:write`, `reactions:write`.
3. **Slash Commands** → **Create New Command**:
   - Command: `/ivy` (or `/huahua` / `/trey`)
   - Short description: `Talk to <name> in a new thread`
   - Usage hint: `<message>`
4. **Event Subscriptions** → toggle **Enable Events** on. Under **Subscribe to bot events**, add: `message.channels`, `message.groups`, `message.im`, `message.mpim`.
5. **Socket Mode** → toggle **Enable Socket Mode** on. When prompted, generate an **App-Level Token** with scope `connections:write`. Copy the `xapp-…` value.
6. **Install App** → **Install to Workspace** → approve.
7. **OAuth & Permissions** → copy the **Bot User OAuth Token** (`xoxb-…`).
8. **Basic Information** → scroll to **App Credentials** → copy the **Signing Secret**.

Save the three values per assistant. Don't paste them into Slack or anywhere they'll get indexed.

---

## Ivy: switch the Mac bridge to its new app

After Ivy's Slack app exists and you have its three secrets, swap the Mac bridge over.

```sh
cd ~/projects/claude-slack-bridge
cp .env .env.bak.$(date +%Y%m%d-%H%M%S)
$EDITOR .env
```

Replace the three Slack credential lines with Ivy's new values. Drop `PEER_ASSISTANTS` (no peers anymore). Final `.env`:

```
SLACK_BOT_TOKEN=xoxb-<ivy>
SLACK_APP_TOKEN=xapp-<ivy>
SLACK_SIGNING_SECRET=<ivy>
ALLOWED_USER_IDS=U02N0CA48
ASSISTANTS=ivy:/Users/tbarsnes/projects/ivy
DEFAULT_ASSISTANT=ivy
CHANNEL_ASSISTANTS=C0B2FE6FAG5:ivy
```

```sh
chmod 600 .env
launchctl kickstart -k gui/$(id -u)/com.timbarsness.ivy-slack
```

Then in Slack:
- Invite the new "Ivy" bot user to `#C0B2FE6FAG5` (`/invite @Ivy`).
- Open a new DM with the Ivy bot (search for "Ivy" in the DM picker).
- Optional cleanup: kick the old "Tim Claude Bridge" bot out of `#C0B2FE6FAG5`, and remove the `/ivy` slash command from the old "Tim Claude Bridge" Slack app.

Smoke test: `/ivy hello` from the new DM, post in `#C0B2FE6FAG5`, send a plain DM, reply in a thread.

---

## Huahua / Trey: fresh bridge on a Windows VM

Repeat this whole section on each VM. Replace `<assistant>` with `huahua` or `trey`, and the working-dir path with the right one for that VM.

### Prerequisites on the VM

- **Node.js 20+** (LTS). Install via the official MSI from https://nodejs.org or `winget install OpenJS.NodeJS.LTS`. Verify with `node --version`.
- **Git for Windows.** `winget install Git.Git`. Verify with `git --version`.
- **NSSM** (Non-Sucking Service Manager) for running the bridge as a Windows service. Download from https://nssm.cc/download or `winget install NSSM.NSSM`. Verify with `nssm version`.
- The assistant's repo cloned somewhere local. Note the absolute path, e.g. `C:\Users\<user>\projects\huahua`.

### Install the bridge

PowerShell on the VM:

```powershell
$repoDir = "C:\Users\$env:USERNAME\projects\claude-slack-bridge"
git clone https://github.com/tbarsness/claude-slack-bridge.git $repoDir
cd $repoDir
npm install
npm run build
```

If you didn't push the three patches to `origin/main` yet (pre-flight step above), the VM will be running stock upstream code and will hit the same socket / slash-prefix bugs the Mac hit. Push the patches first.

### Configure `.env`

In `$repoDir\.env`, paste:

```
SLACK_BOT_TOKEN=xoxb-<this-assistant>
SLACK_APP_TOKEN=xapp-<this-assistant>
SLACK_SIGNING_SECRET=<this-assistant>
ALLOWED_USER_IDS=U02N0CA48
ASSISTANTS=<assistant>:<C:\absolute\path\to\assistant\repo>
DEFAULT_ASSISTANT=<assistant>
```

(Skip `CHANNEL_ASSISTANTS` until you decide which channel pins to this assistant; add later as `CHANNEL_ASSISTANTS=Cxxxxxxxx:<assistant>`.)

Lock it down so other Windows users on the VM can't read it:

```powershell
icacls $repoDir\.env /inheritance:r /grant:r "$env:USERNAME:(R,W)"
```

### Smoke test in the foreground

```powershell
cd $repoDir
npm start
```

You should see `starting {…}` and `ready (Socket Mode connected)`. From Slack, run `/<assistant> hello` in a DM with the new bot. Confirm a reply lands. Ctrl+C to stop.

### Install as a Windows service via NSSM

Run PowerShell **as Administrator** for this part:

```powershell
$repoDir  = "C:\Users\<user>\projects\claude-slack-bridge"
$nodeBin  = (Get-Command node).Path
$svcName  = "claude-slack-bridge-<assistant>"   # e.g. claude-slack-bridge-huahua

nssm install $svcName $nodeBin "--enable-source-maps `"$repoDir\dist\index.js`""
nssm set $svcName AppDirectory $repoDir
nssm set $svcName AppStdout  "$repoDir\logs\nssm.out.log"
nssm set $svcName AppStderr  "$repoDir\logs\nssm.err.log"
nssm set $svcName AppRotateFiles 1
nssm set $svcName AppRotateBytes 10485760
nssm set $svcName AppEnvironmentExtra "NODE_ENV=production"
nssm set $svcName Start SERVICE_AUTO_START

nssm start $svcName
nssm status $svcName    # should be SERVICE_RUNNING
```

The bridge exits with code 2 on socket failures (the watchdog patches above); NSSM's default failure action is to restart the service immediately, which is what we want. If it isn't, set:

```powershell
nssm set $svcName AppExit Default Restart
nssm set $svcName AppRestartDelay 5000
```

### Restart procedure (after code or `.env` edits)

```powershell
cd $repoDir
git pull            # only if you pushed new commits
npm install         # only if dependencies changed
npm run build
nssm restart claude-slack-bridge-<assistant>
```

### Uninstall

```powershell
nssm stop    claude-slack-bridge-<assistant>
nssm remove  claude-slack-bridge-<assistant> confirm
```

---

## Verifying the split

After all four bridges (Ivy, Jude, Huahua, Trey) are on their own Slack apps, each app's `auth.test` endpoint should report a unique `bot_id`. In Slack, each `/<name>` slash command should be uniquely registered to its app, and each bot user should appear with its own name and avatar.

If you ever see **`num_connections":2`** (or higher) in any bridge's startup log, that means another socket is connected to the same app — most commonly a stale `npm start` or a forgotten service. Track it down and kill it; load-balancing will eat events otherwise.

Useful Slack-side queries (via `curl` with that app's `xoxb-…`):

```sh
# Bot identity for this app
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test

# Recent messages in a thread (replace channel + ts)
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.replies?channel=Cxxxxxxxx&ts=<thread-root-ts>&limit=20"
```

## What you only do once

- Pushing the three patches to `origin/main` (pre-flight section).
- Allowed user list in `.env` is just `U02N0CA48` (you). If anyone else on the team needs access, add their Slack user ID to `ALLOWED_USER_IDS` (comma-separated).
