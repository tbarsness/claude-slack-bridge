# Install claude-slack-bridge on a Windows VM

Per-VM install recipe for Huahua or Trey. One Slack app per assistant, one bridge process per VM. Substitute the assistant name (`huahua` or `trey`) wherever you see `<assistant>` and the matching Title Case name (`Huahua` or `Trey`) where you see `<Assistant>`.

## Values you'll need before starting

Fill these in before doing the VM install. The Slack-app section produces the first three.

| Variable | Source | Example |
|---|---|---|
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot User OAuth Token | `xoxb-…` |
| `SLACK_APP_TOKEN` | Slack app → Basic Information → App-Level Tokens (or Socket Mode page) | `xapp-…` |
| `SLACK_SIGNING_SECRET` | Slack app → Basic Information → App Credentials → Signing Secret | 32-char hex |
| `<assistant>` working dir | The path on the VM where the assistant's repo is cloned | `C:\Users\you\projects\<assistant>` |
| Slack channel ID | Optional, the channel pinned to this bridge | `Cxxxxxxxx` |

---

## Part 1: Create the Slack app (in your browser, ~10 min)

You only do this once per assistant. Don't share apps across assistants — Slack load-balances events across sockets connected to the same app, which silently drops messages.

1. https://api.slack.com/apps → **Create New App** → **From scratch** → name it `<Assistant>` (e.g. `Huahua`) → fjorge workspace.

2. **OAuth & Permissions** → scroll to **Scopes** → **Bot Token Scopes** → click **Add an OAuth Scope** and add **all** of these *before* installing the app, or you'll have to reinstall after:
   - `app_mentions:read`
   - `channels:history`
   - `chat:write`
   - `commands`
   - `groups:history`
   - `im:history`
   - `im:write`
   - `mpim:history`
   - `mpim:write`
   - `reactions:write`

3. **Slash Commands** → **Create New Command**:
   - Command: `/<assistant>` (e.g. `/huahua`)
   - Short description: `Talk to <Assistant> in a new thread`
   - Usage hint: `<message>`
   - Save.

4. **Event Subscriptions** → toggle **Enable Events** **on**. Under **Subscribe to bot events**, click **Add Bot User Event** and add all four:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`
   - **Click Save Changes at the bottom of the page.** Easy to forget; without it, the bot won't receive any messages.

5. **App Home** (left sidebar) → scroll to **Show Tabs** → **Messages Tab** toggle **on** → check **"Allow users to send Slash Commands and messages from the messages tab"**. Both are needed; without the checkbox, users get "Sending messages to this app has been turned off" when they DM the bot.

6. **Socket Mode** → toggle **Enable Socket Mode** **on**. When prompted to generate an **App-Level Token**, give it scope `connections:write`. Copy the `xapp-…` value.

7. **Install App** → **Install to Workspace** → approve. After install, **OAuth & Permissions** at the top of the page shows the **Bot User OAuth Token** (`xoxb-…`); copy it.

8. **Basic Information** → scroll to **App Credentials** → copy the **Signing Secret**.

You now have all three secrets. Hand them to Ivy via Bitwarden Send (one entry per assistant; Ivy's session can decrypt directly).

---

## Part 2: Prepare the Windows VM (~10 min)

PowerShell on the VM. Skip any installer step if the tool is already present.

```powershell
# Verify or install Node.js 20+
node --version
# if missing:
winget install OpenJS.NodeJS.LTS

# Verify or install Git
git --version
# if missing:
winget install Git.Git

# Install NSSM (used to run the bridge as a Windows service)
nssm version
# if missing:
winget install NSSM.NSSM
```

Make sure the assistant's repo is cloned on the VM. The exact location is up to you, but write it down — you'll put the absolute path in `.env`.

```powershell
# Example, adjust path to taste:
$assistantDir = "C:\Users\$env:USERNAME\projects\<assistant>"
git clone <assistant-repo-url> $assistantDir
```

---

## Part 3: Install the bridge on the VM (~5 min)

```powershell
$repoDir = "C:\Users\$env:USERNAME\projects\claude-slack-bridge"
git clone https://github.com/tbarsness/claude-slack-bridge.git $repoDir
cd $repoDir
npm install
npm run build
```

Create `$repoDir\.env` with these contents (paste the three Slack secrets and the assistant working-dir path):

```
SLACK_BOT_TOKEN=xoxb-<paste>
SLACK_APP_TOKEN=xapp-<paste>
SLACK_SIGNING_SECRET=<paste>

ALLOWED_USER_IDS=U02N0CA48

ASSISTANTS=<assistant>:C:\Users\you\projects\<assistant>
DEFAULT_ASSISTANT=<assistant>

# Optional: pin a Slack channel to this bridge so top-level messages there
# route to <assistant> without /<assistant>. Add later if you want it.
# CHANNEL_ASSISTANTS=Cxxxxxxxx:<assistant>
```

Lock down the file:

```powershell
icacls $repoDir\.env /inheritance:r /grant:r "$env:USERNAME:(R,W)"
```

---

## Part 4: Smoke test before running as a service

```powershell
cd $repoDir
npm start
```

Expect:
```
[<timestamp>] starting {"assistants":{"<assistant>":"<path>"},...}
[<timestamp>] ready (Socket Mode connected)
```

Find the new bot in Slack:
- Click **Direct messages** → **+** → search `<assistant>` (it'll be the new bot user, e.g. `huahua_bridge` or whatever name Slack assigned during install) → start a DM.
- Send `hello`.
- Expect a real reply within ~5 seconds.

Then test the slash command from any channel: `/<assistant> hello`. Expect a new thread with a reply.

If either fails, check `$repoDir\logs\<date>.log` for what arrived (or didn't). The most common failure is forgetting to **Save Changes** on the Event Subscriptions page — DMs reach Slack but never reach the bridge socket.

`Ctrl+C` to stop the foreground process when satisfied.

---

## Part 5: Install as a Windows service (NSSM)

Run PowerShell **as Administrator**.

```powershell
$repoDir  = "C:\Users\<you>\projects\claude-slack-bridge"
$nodeBin  = (Get-Command node).Path
$svcName  = "claude-slack-bridge-<assistant>"

nssm install $svcName $nodeBin "--enable-source-maps `"$repoDir\dist\index.js`""
nssm set $svcName AppDirectory $repoDir
nssm set $svcName AppStdout  "$repoDir\logs\nssm.out.log"
nssm set $svcName AppStderr  "$repoDir\logs\nssm.err.log"
nssm set $svcName AppRotateFiles 1
nssm set $svcName AppRotateBytes 10485760
nssm set $svcName AppEnvironmentExtra "NODE_ENV=production"
nssm set $svcName AppExit Default Restart
nssm set $svcName AppRestartDelay 5000
nssm set $svcName Start SERVICE_AUTO_START

nssm start $svcName
nssm status $svcName    # expect SERVICE_RUNNING
```

The bridge intentionally exits with code 2 when its websocket goes silent (pong-timeout watchdog patch). NSSM's `AppExit Default Restart` setting respawns it within ~5 seconds, which is what we want.

Verify it's healthy:

```powershell
Get-Content "$repoDir\logs\<today-date>.log" -Tail 5
```

---

## Restart procedure (after code or .env changes)

```powershell
cd $repoDir
git pull
npm install
npm run build
nssm restart claude-slack-bridge-<assistant>
```

## Uninstall

```powershell
nssm stop   claude-slack-bridge-<assistant>
nssm remove claude-slack-bridge-<assistant> confirm
```

---

## Things that broke during Ivy's setup, baked into this doc

- Adding bot scopes **after** install requires a reinstall. Add them all in Part 1 step 2 before clicking Install.
- Saving Event Subscriptions is a separate explicit click. If you only "add" events without hitting Save, none take effect.
- Messages Tab in App Home defaults **off** for new apps. Enable it AND the "Allow users to send..." checkbox.
- New apps default to **only one** Slack connection per app. If you ever see `num_connections":2` (or higher) in the bridge log on startup, another socket is connected to the same app — find and kill it, or events will load-balance and disappear.
- Bots only receive `message.channels` events for channels they're a member of. Invite the bot (`/invite @<bot-name>`) to any channel you want top-level messages routed to.
