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
- **Assistants**: a single bridge process serves N assistants, each defined
  by a name and a working directory in `ASSISTANTS`.
- **Routing**:
  - Slash command `/<assistant> <message>` posts a starter message in the
    current channel and runs the named assistant on it. Replies to that
    thread continue with the same assistant.
  - DMs to the bot use `DEFAULT_ASSISTANT`.
  - `CHANNEL_ASSISTANTS` (optional) pins channels to specific assistants
    when threads are kicked off there.
- **Sessions**: each `(channelId, threadTs)` pair maps to one Claude Code
  `session_id` plus the assistant that owns it, persisted to a JSON file so
  the map survives restarts.
- **Backend**: `@anthropic-ai/claude-agent-sdk` with
  `permissionMode: "bypassPermissions"`, so the agent uses local tools without
  prompting. Run this on a trusted machine.

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
