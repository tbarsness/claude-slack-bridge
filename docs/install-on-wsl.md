# Install claude-slack-bridge on a Windows VM (WSL1)

Per-VM install recipe for Huahua or Trey running inside WSL1 on a Windows VM. One Slack app per assistant, one bridge process per VM. Substitute the assistant name (`huahua` or `trey`) wherever you see `<assistant>` and the matching Title Case name (`Huahua` or `Trey`) where you see `<Assistant>`.

WSL1 has no systemd / real init, so the bridge process is supervised from the Windows side: an NSSM service wraps `wsl.exe`, which in turn runs the bridge inside the Linux distro. When the bridge exits (e.g. its pong-timeout watchdog fires), `wsl.exe` exits, NSSM detects the exit and respawns it, and a fresh socket comes up.

## Values you'll need before starting

Fill these in before doing the WSL install. The Slack-app section produces the first three.

| Variable | Source | Example |
|---|---|---|
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot User OAuth Token | `xoxb-…` |
| `SLACK_APP_TOKEN` | Slack app → Basic Information → App-Level Tokens (or Socket Mode page) | `xapp-…` |
| `SLACK_SIGNING_SECRET` | Slack app → Basic Information → App Credentials → Signing Secret | 32-char hex |
| `<assistant>` working dir | Path inside WSL where the assistant's repo is cloned | `/home/<user>/projects/<assistant>` |
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

## Part 2: Confirm WSL on the VM

Open **PowerShell** on the Windows VM.

```powershell
# Confirm WSL is installed and which distros are present.
wsl --list --verbose
# Expect: <distro>  Running|Stopped  1

# Install NSSM on the Windows side (used in Part 6 to supervise wsl.exe).
nssm version
# if missing:
winget install NSSM.NSSM
```

If WSL isn't installed yet, install it (older versions of Windows Server may need the optional feature enabled separately):

```powershell
wsl --install -d Ubuntu      # installs the distro and prompts for first-run
wsl --set-version Ubuntu 1   # force WSL1 (skip if WSL1 is already the default)
```

Note the distro name — you'll reference it in Part 6.

---

## Part 3: Install bridge prerequisites in WSL

Still inside the Ubuntu shell:

```sh
sudo apt update
sudo apt install -y git curl build-essential

# Node.js 20+ via NodeSource (Ubuntu's apt-shipped node is too old)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node --version    # expect v20.x or higher
git --version
```

Make sure the assistant's repo is cloned somewhere in your home directory. The exact location is up to you, but write it down — you'll put the absolute Linux path in `.env`.

```sh
mkdir -p ~/projects
git clone <assistant-repo-url> ~/projects/<assistant>
```

---

## Part 4: Install the bridge in WSL (~5 min)

```sh
git clone https://github.com/tbarsness/claude-slack-bridge.git ~/projects/claude-slack-bridge
cd ~/projects/claude-slack-bridge
npm install
npm run build
```

Create `~/projects/claude-slack-bridge/.env` with these contents (paste the three Slack secrets and the Linux-side assistant path):

```
SLACK_BOT_TOKEN=xoxb-<paste>
SLACK_APP_TOKEN=xapp-<paste>
SLACK_SIGNING_SECRET=<paste>

ALLOWED_USER_IDS=U02N0CA48

ASSISTANTS=<assistant>:/home/<your-linux-user>/projects/<assistant>
DEFAULT_ASSISTANT=<assistant>

# Optional: pin a Slack channel to this bridge so top-level messages there
# route to <assistant> without /<assistant>. Add later if you want it.
# CHANNEL_ASSISTANTS=Cxxxxxxxx:<assistant>
```

Lock the file down:

```sh
chmod 600 ~/projects/claude-slack-bridge/.env
```

---

## Part 5: Smoke test in the foreground

```sh
cd ~/projects/claude-slack-bridge
npm start
```

Expect:
```
[<timestamp>] starting {"assistants":{"<assistant>":"<path>"},...}
[<timestamp>] ready (Socket Mode connected)
```

Find the new bot in Slack:
- Click **Direct messages** → **+** → search `<assistant>` (it'll be the new bot user, e.g. `huahua_bridge`) → start a DM.
- Send `hello`. Expect a real reply within ~5 seconds.
- Then test the slash: `/<assistant> hello` from any channel where the bot is a member or via DM. Expect a new thread with a reply.

If a test fails, check `~/projects/claude-slack-bridge/logs/<date>.log` for what arrived. Most common cause is forgetting to **Save Changes** on the Event Subscriptions page — DMs reach Slack but never reach the bridge socket.

`Ctrl+C` to stop the foreground process.

---

## Part 6: Run as a Windows service via NSSM (wrapping `wsl.exe`)

WSL1 has no systemd, so the supervisor lives on the Windows side. NSSM runs `wsl.exe`, which runs a tiny launcher script inside the distro, which runs the bridge. When the bridge exits (pong watchdog, crash, or otherwise), `wsl.exe` exits, NSSM respawns it, and a fresh socket comes up.

### 6a. Create the Linux-side launcher script

Inside the Ubuntu shell:

```sh
cat > ~/projects/claude-slack-bridge/start.sh <<'EOF'
#!/bin/bash
set -e
cd "$HOME/projects/claude-slack-bridge"
exec /usr/bin/node --enable-source-maps dist/index.js
EOF
chmod +x ~/projects/claude-slack-bridge/start.sh
```

Smoke-test the launcher invokes correctly: `~/projects/claude-slack-bridge/start.sh` should produce the same `starting` / `ready` lines as `npm start` did. `Ctrl+C` to stop.

### 6b. Install the NSSM service

PowerShell **as Administrator** on the Windows side:

```powershell
$svcName  = "claude-slack-bridge-<assistant>"   # e.g. claude-slack-bridge-huahua
$distro   = "Ubuntu"                            # whatever wsl --list shows
$linuxUser = "<your-linux-user>"                # the WSL user that owns the install
$wslExe   = "C:\Windows\System32\wsl.exe"
$logDir   = "C:\ProgramData\claude-slack-bridge\<assistant>"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

nssm install $svcName $wslExe "-d $distro -u $linuxUser /home/$linuxUser/projects/claude-slack-bridge/start.sh"
nssm set $svcName AppStdout  "$logDir\nssm.out.log"
nssm set $svcName AppStderr  "$logDir\nssm.err.log"
nssm set $svcName AppRotateFiles 1
nssm set $svcName AppRotateBytes 10485760
nssm set $svcName AppExit Default Restart
nssm set $svcName AppRestartDelay 5000
nssm set $svcName Start SERVICE_AUTO_START
nssm set $svcName ObjectName "$env:COMPUTERNAME\$env:USERNAME" "<your-windows-password>"

nssm start $svcName
nssm status $svcName    # expect SERVICE_RUNNING
```

The `ObjectName` line runs the service as your Windows user instead of `LocalSystem`. WSL1 distros are per-user — `LocalSystem` won't see your Ubuntu install. If you'd rather not bake a password into the service, register the service interactively via `services.msc` and set the **Log On** identity manually with stored credentials.

The bridge intentionally exits with code 2 when its websocket goes silent. `AppExit Default Restart` + `AppRestartDelay 5000` gives us a fresh socket within ~5 seconds.

### 6c. Auto-start at Windows boot

Because the service runs as your user, it'll start when the service controller boots that user's session — which on a server VM that boots without an interactive login means you should also run:

```powershell
# Make sure the service starts on boot regardless of interactive login state.
sc.exe config $svcName start= auto
sc.exe failure $svcName reset= 0 actions= restart/5000/restart/5000/restart/5000
```

(NSSM's `Start SERVICE_AUTO_START` and `AppExit ... Restart` should already cover this; `sc.exe` is just defense in depth.)

---

## Restart procedure (after code or .env changes)

In WSL:

```sh
cd ~/projects/claude-slack-bridge
git pull
npm install
npm run build
```

Then in PowerShell as Admin (or via `services.msc`):

```powershell
nssm restart claude-slack-bridge-<assistant>
```

## View logs

```sh
# Bridge's own log file (inside WSL)
tail -f ~/projects/claude-slack-bridge/logs/$(date +%Y-%m-%d).log
```

```powershell
# NSSM-captured stdout/stderr (includes socket-mode debug + pong warnings)
Get-Content "C:\ProgramData\claude-slack-bridge\<assistant>\nssm.out.log" -Tail 50
Get-Content "C:\ProgramData\claude-slack-bridge\<assistant>\nssm.err.log" -Tail 50
```

## Uninstall

PowerShell as Admin:

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
- WSL1-specific: WSL1 distros are **per-user**. A service running as `LocalSystem` won't find your Ubuntu install. The NSSM `ObjectName` step (or setting Log On in `services.msc`) is required.
- WSL1-specific: if the NSSM service silently fails right after start, run the same `wsl.exe` command interactively from PowerShell and look at the error. Most common: the Linux user passed via `-u` doesn't exist, the launcher script path is wrong, or `node` isn't on the Linux user's `PATH` (ExecStart uses an absolute `/usr/bin/node` for that reason).
