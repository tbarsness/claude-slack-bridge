# claude-slack-bridge

Drive multiple Claude Code sessions from Slack — one bridge, many assistants.

DM the bot a message and the bridge spawns a Claude Code session in the
default assistant's working directory; reply in the thread to keep talking to
that session. Use `/<assistant>` slash commands (e.g. `/ivy`, `/jude`) to
start a thread with a specific assistant from any channel.

Each Claude session inherits its configured directory's `CLAUDE.md`,
`.claude/settings.json`, MCP servers, and skills, exactly as if you ran
`claude` there. Point one assistant at `~/projects/ivy` and another at
`~/projects/jude` and you get both in Slack with all of their tools, on your
machine, no public URL needed.

## Architecture

- **Slack ingress**: `@slack/bolt` in Socket Mode. No webhooks, no public URL.
- **Auth**: hard allowlist on Slack user IDs.
- **Assistants**: a bridge process serves the assistants declared in its own
  `ASSISTANTS` env var. You can run **multiple bridge instances** against the
  same Slack app — each instance hosts the assistants whose working
  directories live on its machine, and stays silent for everything else.
- **Routing**:
  - **Slash command** `/<assistant> <message>` posts a starter message in
    the current channel and runs the named assistant on it. Replies to that
    thread continue with the same assistant. The slash command is only
    handled by the bridge instance whose `ASSISTANTS` includes that name.
  - **Address prefix** in a message: starting a message with an assistant
    name (`jude check this`, `@jude check this`, `jude: check this`,
    `jude, check this`) routes that message to the named assistant. Inside
    an existing thread it's a one-shot "guest turn" — the addressed
    assistant answers but the thread's owner doesn't change. In a brand-new
    DM the address prefix opens a new thread for that assistant.
  - **DMs** to the bot use `DEFAULT_ASSISTANT`. Only the instance configured
    with a matching `DEFAULT_ASSISTANT` responds; in a multi-bridge setup,
    set `DEFAULT_ASSISTANT` on exactly one instance.
  - **`CHANNEL_ASSISTANTS`** (optional) pins channels to specific
    assistants when threads are kicked off there.
- **Sessions**: each `(channelId, threadTs)` pair maps to one Claude Code
  `session_id` plus the assistant that owns it, persisted to a JSON file so
  the map survives restarts. Each instance has its own sessions file, and
  only handles thread replies it has stored locally.
- **Backend**: `@anthropic-ai/claude-agent-sdk` with
  `permissionMode: "bypassPermissions"`, so the agent uses local tools without
  prompting. Run this on a trusted machine.

### Multi-machine setup

Slack delivers every event (messages and slash commands) to all Socket Mode
clients connected for an app. Each bridge instance ignores events it can't
handle:

- A slash command for `/jude` is acked by the instance whose `ASSISTANTS`
  declares `jude`. Other instances see the event but have no handler.
- A thread reply is handled by the instance that has the thread's session
  on disk. Other instances see the event and stay silent.
- A new DM (top-level) is handled by the instance whose `DEFAULT_ASSISTANT`
  is set.
- An address-prefixed message (`jude check this`) is handled by the
  instance hosting that assistant. Other instances recognize the name as a
  peer's via `PEER_ASSISTANTS` and stay silent.

So: run one instance on each machine, declare the assistants whose code
lives there in `ASSISTANTS`, list peer assistants in `PEER_ASSISTANTS`,
share the Slack app, and they cooperate without coordination.

## Quick start

1. [Create the Slack app](docs/SETUP.md), including a slash command for each
   assistant you'll declare.
2. Copy `.env.example` to `.env`, fill in tokens, `ALLOWED_USER_IDS`,
   `ASSISTANTS`, and `DEFAULT_ASSISTANT`.
3. `npm install && npm run build && npm start`.
4. DM your bot in Slack — you're talking to `DEFAULT_ASSISTANT`. Try
   `/<other-assistant> hello` from any channel to start a thread with a
   different assistant.

To keep it running on a Mac, see [`launchd/README.md`](launchd/README.md).

## Security model

This is effectively a remote control for one or more Claude Code sessions on
your machine. The only auth gate is `ALLOWED_USER_IDS`. Anyone who compromises
your Slack workspace, or your tokens, gets the same access Claude has.

- Run it in a Slack workspace you trust (a personal one is safest).
- Keep `ALLOWED_USER_IDS` tight; do not include teammates "just in case".
- Never share `.env` or commit it.
- Sessions run with `bypassPermissions` enabled, equivalent to
  `claude --dangerously-skip-permissions`. This is intentional for the
  always-on use case but means tool calls are not gated. Point each
  assistant at a working directory whose configured tools you are comfortable
  running unattended.

## License

MIT.
