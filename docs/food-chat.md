# Food chat endpoint

Ivy Mobile's day chats and Recipes chat talk to the Ivy assistant through a
private HTTP endpoint on this bridge (`src/food-chat-endpoint.ts`). Each turn
is accepted with 202 and runs in the background; the app polls the
transcript. Every turn and app event is mirrored into a Slack thread in
`#ivy`, one thread per chat.

## Setup

1. Generate a secret and add it to the bridge's `.env`:

   ```sh
   openssl rand -hex 32
   ```

   ```
   FOODCHAT_SECRET=<the value>
   ```

   The endpoint does not start without it.

2. Check the rest of the `FOODCHAT_*` settings in `.env.example`. The
   defaults fit this Mac:
   - binds `127.0.0.1:8739`;
   - runs turns in the `ivy` assistant's working directory from `ASSISTANTS`;
   - mirrors to the channel `CHANNEL_ASSISTANTS` maps to `ivy`, unless
     `FOODCHAT_CHANNEL` names one;
   - keeps transcripts in `data/food-chat/` next to `sessions.json`
     (git-ignored);
   - reads the Food Log exec URL from `FOODLOG_EXEC_URL` in Ivy's own `.env`,
     unless `FOODCHAT_FOODLOG_URL` is set. The bridge only reads the Food Log;
     Ivy writes through its `foodlog` CLI.

3. Restart the bridge. The log shows `food chat endpoint ready`.

4. Publish the port to the tailnet over HTTPS. The app accepts only
   `https://` URLs. Tailnet only: never use `tailscale funnel`.

   ```sh
   tailscale serve --bg --https=8739 http://127.0.0.1:8739
   tailscale serve status
   ```

   Pick an HTTPS port that the Mac's other `tailscale serve` proxies do not
   already use.

5. Put the resulting `https://<mac>.<tailnet>.ts.net:8739` URL in Ivy Mobile's
   `FoodChatURL` setting and the secret in the app's Keychain.

6. Check it from the phone, on Tailscale:

   ```sh
   curl -H "x-foodchat-secret: $FOODCHAT_SECRET" https://<mac>.<tailnet>.ts.net:8739/health
   ```

## Routes

All routes need the `x-foodchat-secret` header (401 otherwise).

| Route | Purpose |
|---|---|
| `GET /health` | `{ok:true}` |
| `POST /turns` | `{turnId, chat, text, photos:[{name, mime, data}]}`; 202 for a new turn, 200 with the existing turn for a repeat ID; 413 over 12 MB |
| `GET /chats/<key>?since=<cursor>` | transcript entries after the cursor, every turn, `recipesChangedAt` |
| `POST /events` | `{eventId, chat, kind, entries}`; recorded once, mirrored, never starts a turn |
| `POST /turns/<turnId>/undo` | `{removed, total, alreadyGone}` from the app's Undo |

Chat keys are `recipes` or `day:YYYY-MM-DD`. Turn and event IDs are lowercase
UUIDs.

## How a turn runs

1. Photos are saved under Ivy's `.slack-uploads/food-chat-<chat>-<tag>/`.
2. The bridge reads that day's rows and the recipe names, and puts them in
   front of Tim's message with the date, whether it is today and the turn's
   marker prefix, labeled as data.
3. Ivy runs in the chat's own session, one turn at a time per chat, with
   `IVY_CHAT_MARKER=via Ivy chat <tag>` and, for a day chat,
   `IVY_CHAT_DATE=<date>`. The `foodlog` CLI stamps the marker into each
   row's notes.
4. A turn that passes `FOODCHAT_TURN_CEILING_MS` (default 15 minutes) is
   aborted. The bridge waits for the run to stop before going on.
5. The bridge reads the Food Log back and records the rows whose notes start
   with `via Ivy chat <tag>-` (a recipes turn records the recipe it added or
   changed). State ends `done`, `partial` (error with rows) or `failed`
   (error, no rows).
6. The turn is mirrored to Slack. A failed post leaves the turn unmirrored
   and never fails it.

After a restart, turns left queued or running become `interrupted`, and their
rows are read back by marker.

## Rotating the secret

1. Generate a new value with `openssl rand -hex 32`.
2. Replace `FOODCHAT_SECRET` in the bridge's `.env` and restart the bridge.
3. Update the secret in Ivy Mobile's Keychain. Until then the app shows
   "wrong secret" and disables Send; nothing is lost, since transcripts stay
   on the bridge.

`tailscale serve` needs no change when the secret rotates.
