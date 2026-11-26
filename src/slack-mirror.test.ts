import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunHooks, RunResult } from "./claude.js";

// config.ts runs at import time and throws on a missing required var. Point it
// at dummy values from an empty directory so the tests never load the live
// bridge's settings. `jude` is a peer assistant, for the guest-turn case.
const envDir = await mkdtemp(join(tmpdir(), "bridge-test-env-"));
const originalCwd = process.cwd();
delete process.env.SHARED_ENV_FILE;
for (const name of ["DEFAULT_ASSISTANT", "CHANNEL_ASSISTANTS", "FOODCHAT_ASSISTANT"]) {
  delete process.env[name];
}
Object.assign(process.env, {
  ASSISTANTS: `ivy:${envDir}`,
  PEER_ASSISTANTS: "jude",
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_SIGNING_SECRET: "test-secret",
  ALLOWED_USER_IDS: "U0TIM,U0OTHER",
  SESSIONS_FILE: join(envDir, "sessions.json"),
  MAX_CONCURRENT_CLAUDE: "4",
});
process.chdir(envDir);
const { FoodChat } = await import("./food-chat-endpoint.js");
const { ChatStore } = await import("./chat-store.js");
const { routeFoodChatMessage } = await import("./slack.js");
process.chdir(originalCwd);
await rm(envDir, { recursive: true, force: true });

const CHANNEL = "C0IVY";
const TIM = "U0TIM";
const DAY = "day:2026-11-26";
const ROOT_TS = "1764100000.000100";

async function setup() {
  const store = new ChatStore(await mkdtemp(join(tmpdir(), "slack-mirror-data-")));
  await store.load();
  await store.setThreadTs(DAY, ROOT_TS);
  const posts: { channel: string; text: string; thread_ts?: string }[] = [];
  const calls: string[] = [];
  const chat = new FoodChat({
    config: { secret: "s", channel: CHANNEL, ivyDir: await mkdtemp(join(tmpdir(), "slack-mirror-ivy-")), ceilingMs: 60_000 },
    store,
    runClaude: async (prompt: string, _resume: string | undefined, _dir: string, _hooks?: RunHooks): Promise<RunResult> => {
      calls.push(prompt);
      return { text: "Logged two eggs.", sessionId: "sess-1" };
    },
    foodlogGet: async (params) =>
      params.action === "recipes" ? { recipes: [] } : { entries: [], totals: null, targets: null },
    slack: {
      postMessage: async (args) => {
        posts.push(args);
        return { ts: `1764100001.00${posts.length}` };
      },
    },
    now: () => new Date("2026-11-26T18:30:00Z"),
  });
  const downloads: string[] = [];
  const deps = {
    foodChat: chat,
    channel: CHANNEL,
    timUserId: TIM,
    assistant: "ivy",
    downloadPhotos: async (files: { name?: string }[]) => {
      downloads.push(...files.map((f) => f.name ?? ""));
      return [{ name: "plate.jpg", mime: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]) }];
    },
  };
  return { store, chat, posts, calls, downloads, deps };
}

const msg = (over: Partial<Parameters<typeof routeFoodChatMessage>[0]> = {}) => ({
  channelId: CHANNEL,
  threadTs: ROOT_TS,
  ts: "1764100500.000200",
  userId: TIM,
  text: "two eggs for breakfast",
  files: [],
  ...over,
});

test("Tim's reply in a mirror thread becomes a slack-origin turn in that chat, and only the reply is posted", async () => {
  const t = await setup();
  const handled = await routeFoodChatMessage(
    msg({ files: [{ id: "F1", name: "plate.jpg", mimetype: "image/jpeg" }] }),
    t.deps,
  );
  assert.equal(handled, true);
  await t.chat.idle();

  const turn = t.store.getTurn("1764100500.000200")!;
  assert.ok(turn);
  assert.equal(turn.chat, DAY);
  assert.equal(turn.origin, "slack");
  assert.equal(turn.state, "done");
  assert.equal(t.calls.length, 1);
  assert.match(t.calls[0]!, /two eggs for breakfast/);
  assert.deepEqual(t.downloads, ["plate.jpg"]);

  const { entries } = t.store.read(DAY);
  assert.deepEqual(
    entries.map((e) => [e.kind, e.origin, e.text, e.photoCount]),
    [
      ["message", "slack", "two eggs for breakfast", 1],
      ["reply", "bridge", "Logged two eggs.", null],
    ],
  );
  // Tim's own message is already in the thread; only Ivy's reply is posted, once.
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0]!.thread_ts, ROOT_TS);
  assert.match(t.posts[0]!.text, /Logged two eggs\./);
  assert.doesNotMatch(t.posts[0]!.text, /Tim:/);
});

test("a reply from another user, or a guest-addressed reply, in a mirror thread starts no turn", async () => {
  const t = await setup();
  assert.equal(await routeFoodChatMessage(msg({ userId: "U0OTHER", ts: "1764100500.000300" }), t.deps), false);
  assert.equal(
    await routeFoodChatMessage(msg({ text: "jude what's on my calendar", ts: "1764100500.000400" }), t.deps),
    false,
  );
  await t.chat.idle();
  assert.equal(t.store.getTurn("1764100500.000300"), undefined);
  assert.equal(t.store.getTurn("1764100500.000400"), undefined);
  assert.deepEqual(t.store.read(DAY).entries, []);
  assert.equal(t.calls.length, 0);
  assert.equal(t.posts.length, 0);
});

test("a redelivered Slack event with the same message ts produces one turn", async () => {
  const t = await setup();
  const [a, b] = await Promise.all([
    routeFoodChatMessage(msg(), t.deps),
    routeFoodChatMessage(msg(), t.deps),
  ]);
  assert.equal(a, true);
  assert.equal(b, true);
  await t.chat.idle();
  assert.equal(await routeFoodChatMessage(msg(), t.deps), true);
  await t.chat.idle();

  assert.equal(t.calls.length, 1);
  assert.equal(t.store.read(DAY).turns.length, 1);
  assert.equal(t.store.read(DAY).entries.filter((e) => e.kind === "message").length, 1);
  assert.equal(t.posts.length, 1);
});

test("a reply in a non-mirror thread, or with the food chat off, follows the existing Slack path", async () => {
  const t = await setup();
  assert.equal(await routeFoodChatMessage(msg({ threadTs: "1764000000.000999" }), t.deps), false);
  assert.equal(await routeFoodChatMessage(msg({ threadTs: undefined }), t.deps), false);
  assert.equal(await routeFoodChatMessage(msg({ channelId: "C0OTHER" }), t.deps), false);
  assert.equal(await routeFoodChatMessage(msg(), { ...t.deps, foodChat: undefined }), false);
  await t.chat.idle();
  assert.equal(t.calls.length, 0);
  assert.equal(t.posts.length, 0);
  assert.equal(t.store.getTurn("1764100500.000200"), undefined);
});
