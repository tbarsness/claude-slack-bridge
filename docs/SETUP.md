# Setup

This bridge connects a Slack workspace to one or more Claude Code sessions
running on your own machine. DM the bot to talk to your default assistant;
use `/<assistant>` slash commands to talk to others.

## 1. Create the Slack app

1. Go to <https://api.slack.com/apps> and click **Create New App** -> **From scratch**.
2. Name it whatever you like (e.g. "Assistants", "Bridge") and pick a workspace.
3. In the left sidebar:
   - **Socket Mode** -> Enable. Generate an app-level token with the
     `connections:write` scope. Copy the token (`xapp-...`) into
     `SLACK_APP_TOKEN`.
   - **OAuth & Permissions** -> add these **Bot Token Scopes**:
     - `chat:write`
     - `commands`
     - `files:read` (for image / file attachments — see below)
     - `im:history`
     - `im:read`
     - `im:write`
     - `reactions:write`
     - `users:read`
     - For threads in non-DM channels you also need `channels:history`,
       `groups:history`, and/or `mpim:history` matching where you'll use
       slash commands.
   - **Event Subscriptions** -> Enable Events. Under **Subscribe to bot
     events**, add:
     - `message.im`
     - `message.channels` (optional, to continue threads in public channels)
     - `message.groups` / `message.mpim` (optional, for private channels / group DMs)
   - **Slash Commands** -> for each assistant in your `ASSISTANTS` env var,
     add a slash command:
     - **Command**: `/ivy` (matching the assistant name)
     - **Short description**: e.g. "Talk to Ivy in a new thread"
     - **Usage hint**: `<message>`
     - Repeat for `/jude` etc.
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
# edit .env: tokens, ALLOWED_USER_IDS, ASSISTANTS, DEFAULT_ASSISTANT
npm install
npm run build
npm start
```

`ASSISTANTS` is a comma-separated list of `name:absolute-path` entries. Each
named assistant runs Claude Code in that directory and inherits its
`CLAUDE.md`, `.claude/settings.json`, MCP servers, and skills. The slash
command for each assistant is `/<name>`, so names must be lowercase
alphanumeric.

`DEFAULT_ASSISTANT` is which assistant handles plain DMs to the bot.

To verify, DM the bot in Slack:

> hey, can you see this?

You should see an :eyes: reaction, then a reply in-thread from your default
assistant. Then try `/<other-assistant> ping` from anywhere — it'll start a
new thread with that assistant.

## 4. File attachments (images, PDFs, etc.)

Drop a screenshot or other file into a Slack message and the bridge will
download it (using the bot token) into the assistant's working directory at:

```
<workingDir>/.slack-uploads/<channelId>-<threadTs>/<fileId>-<filename>
```

The user's prompt is then augmented with a short block listing the absolute
paths and MIME types of saved files, so Claude can `Read` them when it needs
to look (Read handles images, PDFs, and text natively).

Requires the `files:read` bot scope. Files larger than 50 MB are skipped.

If you don't want these uploads tracked in git, add `.slack-uploads/` to
the assistant's working-directory `.gitignore`.

## 5. Run as a launchd service (macOS)

To keep the bridge running, see [`launchd/README.md`](../launchd/README.md).

## Troubleshooting

- **No response to DMs**: check the app is installed to the workspace, Socket
  Mode is enabled, and the bot has been added (open a DM with the bot first
  by searching its name in Slack).
- **Slash command says "/ivy is not a recognized command"**: register it in
  the Slack app's **Slash Commands** section, then reinstall the app.
- **"not_authed" or "invalid_auth"**: regenerate tokens after any scope
  change and reinstall the app.
- **Bot replies "you're not on the allowlist"**: confirm `ALLOWED_USER_IDS`
  matches your real Slack user ID (not your handle).
- **Thread in a public channel goes silent after first reply**: subscribe to
  the relevant `message.*` event for that channel type and grant the matching
  `*:history` scope.
- **Claude errors / tool failures**: tail the configured `LOG_DIR` and the
  Claude Code session logs in each assistant's working directory under
  `.claude/`.
