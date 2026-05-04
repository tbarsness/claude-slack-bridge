# Run as a macOS launchd agent

`com.example.claude-slack-bridge.plist` is a template. Copy it to
`~/Library/LaunchAgents/`, replace the four `{{...}}` placeholders, and load it.

## One-shot install

```sh
LABEL=com.timbarsness.ivy-slack
NODE_BIN=$(which node)
REPO_DIR=$(pwd)
LOG_DIR="$REPO_DIR/logs"

mkdir -p "$LOG_DIR"
sed \
  -e "s|{{LABEL}}|$LABEL|g" \
  -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
  -e "s|{{REPO_DIR}}|$REPO_DIR|g" \
  -e "s|{{LOG_DIR}}|$LOG_DIR|g" \
  launchd/com.example.claude-slack-bridge.plist \
  > ~/Library/LaunchAgents/$LABEL.plist

launchctl load -w ~/Library/LaunchAgents/$LABEL.plist
```

## Operate

```sh
# status
launchctl list | grep ivy-slack

# tail logs
tail -f logs/launchd.err.log logs/launchd.out.log

# restart after a code change
npm run build
launchctl kickstart -k gui/$(id -u)/$LABEL

# uninstall
launchctl unload ~/Library/LaunchAgents/$LABEL.plist
rm ~/Library/LaunchAgents/$LABEL.plist
```

## Notes

- The agent runs as your user, so it has your env access (Keychain, Photos,
  iMessage DB, etc.) just like an interactive Claude Code session.
- `KeepAlive` only restarts on crash, not on clean exit. SIGINT/SIGTERM stop
  the agent cleanly.
- `node` from `which node` may be in `/usr/local/bin`, `/opt/homebrew/bin`,
  or a version manager's shim. launchd does **not** read your shell rc files,
  so always use the absolute path resolved by `which node` at install time.
