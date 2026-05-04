# Setup

This bridge connects a Slack workspace to a Claude Code session running on
your own machine. When you DM the bot, it spawns or resumes a Claude session
in a configured working directory and posts the response back to the same
Slack thread.

## 1. Create the Slack app

1. Go to <https://api.slack.com/apps> and click **Create New App** -> **From scratch**.
2. Name it whatever you like (e.g. "Ivy", "Jude") and pick a workspace.
3. In the left sidebar:
   - **Socket Mode** -> Enable. Generate an app-level token with the
     `connections:write` scope. Copy the token (`xapp-...`) into
     `SLACK_APP_TOKEN`.
   - **OAuth & Permissions** -> add these **Bot Token Scopes**:
     - `chat:write`
     - `im:history`
     - `im:read`
     - `im:write`
     - `reactions:write`
     - `users:read`
   - **Event Subscriptions** -> Enable Events. Under **Subscribe to bot
     events**, add:
     - `message.im`
   - **App Home** -> enable the **Messages Tab** and check
     "Allow users to send Slash commands and messages from the messages tab".
4. **Install App** -> Install to Workspace. Copy the **Bot User OAuth Token**
   (`xoxb-...`) into `SLACK_BOT_TOKEN`.
5. **Basic Information** -> copy the **Signing Secret** into
   `SLACK_SIGNING_SECRET`.

## 2. Get your Slack user ID

In Slack, click your own profile -> **More** (`...`) -> **Copy member ID**.
It looks like `U0123456789`. Put it in `ALLOWED_USER_IDS`. Anyone not on this
list will be politely refused; multiple IDs are comma-separated.

## 3. Configure and run

```sh
cp .env.example .env
# edit .env with the four values above plus CLAUDE_WORKING_DIR
npm install
npm run build
npm start
```

`CLAUDE_WORKING_DIR` is the project directory the Claude session will run in.
The session inherits that project's `CLAUDE.md`, `.claude/settings.json`, MCP
servers, and skills, exactly as if you ran `claude` there yourself.

To verify, DM the bot in Slack:

> hey, can you see this?

You should see an :eyes: reaction, then a reply in-thread.

## 4. Run as a launchd service (macOS)

To keep the bridge running, see [`launchd/README.md`](../launchd/README.md).

## Troubleshooting

- **No response to DMs**: check the app is installed to the workspace, Socket
  Mode is enabled, and the bot has been added (open a DM with the bot first
  by searching its name in Slack).
- **"not_authed" or "invalid_auth"**: regenerate tokens after any scope
  change and reinstall the app.
- **Bot replies "you're not on the allowlist"**: confirm `ALLOWED_USER_IDS`
  matches your real Slack user ID (not your handle).
- **Claude errors / tool failures**: tail the configured `LOG_DIR` and the
  Claude Code session logs in `CLAUDE_WORKING_DIR/.claude/`.
