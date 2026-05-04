# claude-slack-bridge

Drive a Claude Code session from Slack DMs.

DM the bot a message; the bridge spawns a Claude Code session in a configured
working directory and posts the response back in the Slack thread. Reply in
that same thread to keep the conversation going on the same Claude session.
Open a new top-level DM to start a fresh session.

The Claude session inherits the configured directory's `CLAUDE.md`,
`.claude/settings.json`, MCP servers, and skills, exactly as if you ran
`claude` there. So if you point this at `~/projects/your-assistant`, you get
your assistant in Slack with all of its tools, on your machine, no public URL
needed.

## Architecture

- **Slack ingress**: `@slack/bolt` in Socket Mode. No webhooks, no public URL.
- **Auth**: hard allowlist on Slack user IDs.
- **Sessions**: each Slack thread maps to one Claude Code `session_id`,
  persisted to a JSON file so the map survives restarts.
- **Backend**: `@anthropic-ai/claude-agent-sdk` with
  `permissionMode: "bypassPermissions"`, so the agent uses local tools without
  prompting. Run this on a trusted machine.

## Quick start

1. [Create the Slack app](docs/SETUP.md).
2. Copy `.env.example` to `.env`, fill in tokens + `CLAUDE_WORKING_DIR` +
   `ALLOWED_USER_IDS`.
3. `npm install && npm run build && npm start`.
4. DM your bot in Slack.

To keep it running on a Mac, see [`launchd/README.md`](launchd/README.md).

## Security model

This is effectively a remote control for a Claude Code session on your
machine. The only auth gate is `ALLOWED_USER_IDS`. Anyone who compromises
your Slack workspace, or your tokens, gets the same access Claude has.

- Run it in a Slack workspace you trust (a personal one is safest).
- Keep `ALLOWED_USER_IDS` tight; do not include teammates "just in case".
- Never share `.env` or commit it.
- The session runs with `bypassPermissions` enabled, equivalent to
  `claude --dangerously-skip-permissions`. This is intentional for the
  always-on use case but means tool calls are not gated. Point
  `CLAUDE_WORKING_DIR` at a project whose configured tools you are
  comfortable running unattended.

## License

MIT.
