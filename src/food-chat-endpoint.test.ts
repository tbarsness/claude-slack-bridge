import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { RunHooks, RunResult } from "./claude.js";

// config.ts runs at import time (through attachments.ts): it reads `.env` from
// the cwd and throws on a missing required var. Point it at dummy values from
// an empty directory so the tests never load the live bridge's settings.
const envDir = await mkdtemp(join(tmpdir(), "bridge-test-env-"));
const originalCwd = process.cwd();
delete process.env.SHARED_ENV_FILE;
for (const name of ["PEER_ASSISTANTS", "DEFAULT_ASSISTANT", "CHANNEL_ASSISTANTS"]) {
  delete process.env[name];
}
Object.assign(process.env, {
  ASSISTANTS: `ivy:${envDir}`,
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_SIGNING_SECRET: "test-secret",
  ALLOWED_USER_IDS: "U000TEST",
  MAX_CONCURRENT_CLAUDE: "4",
});
process.chdir(envDir);
const { FoodChat, createFoodChatServer, MAX_BODY_BYTES } = await import("./food-chat-endpoint.js");
const { ChatStore, turnTag } = await import("./chat-store.js");
process.chdir(originalCwd);
await rm(envDir, { recursive: true, force: true });

const SECRET = "test-food-chat-secret";
const CHANNEL = "C0IVY";
const DAY = "day:2026-11-26";

interface SheetRow {
  row: number;
  meal: string;
  items: string;
  calories: number;
  protein: number;
  carbs: number;
  fiber: number;
  fat: number;
  sodium: number;
  notes: string;
}
interface Recipe {
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fiber: number;
  fat: number;
  sodium: number;
}

/** A fake Food Log: rows per date and a Recipes tab, read through the GET actions. */
class FakeSheet {
  days = new Map<string, SheetRow[]>();
  recipes: Recipe[] = [{ name: "Egg Bake", calories: 400, protein: 30, carbs: 10, fiber: 2, fat: 25, sodium: 700 }];
  reads: Record<string, string>[] = [];
  /** GET actions that reject, to exercise the read-back failure paths. */
  failActions = new Set<string>();

  add(date: string, items: string, notes: string): void {
    const rows = this.days.get(date) ?? [];
    rows.push({
      row: rows.length + 3,
      meal: "Lunch",
      items,
      calories: 100,
      protein: 10,
      carbs: 5,
      fiber: 1,
      fat: 3,
      sodium: 50,
      notes,
    });
    this.days.set(date, rows);
  }

  get = async (params: Record<string, string>): Promise<unknown> => {
    this.reads.push(params);
    if (this.failActions.has(params.action!)) throw new Error(`Food Log read failed: HTTP 500`);
    if (params.action === "foodlog") {
      const entries = this.days.get(params.date!) ?? [];
      const totals = { calories: 0, protein: 0, carbs: 0, fiber: 0, fat: 0, sodium: 0 };
      for (const e of entries) {
        for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += e[k];
      }
      return {
        date: params.date,
        count: entries.length,
        entries: entries.map((e) => ({ ...e })),
        totals,
        targets: { calories: 2900, protein: 200, carbs: 345, fiber: 35, fat: 80, sodium: 3500 },
      };
    }
    if (params.action === "recipes") return { recipes: this.recipes.map((r) => ({ ...r })) };
    throw new Error(`unexpected action ${params.action}`);
  };
}

interface Posted {
  channel: string;
  text: string;
  thread_ts?: string;
  ts?: string;
}

class FakeSlack {
  posts: Posted[] = [];
  failRoot = false;
  failAll = false;
  /** Every post never settles, like a Slack call stuck in its retry window. */
  hangAll = false;
  /** Thread posts never settle; root posts still work. */
  hangReplies = false;
  private n = 0;
  postMessage = async (args: Posted): Promise<{ ts?: string }> => {
    if (this.hangAll || (this.hangReplies && args.thread_ts)) return new Promise(() => undefined);
    if (this.failAll) throw new Error("slack down");
    if (!args.thread_ts && this.failRoot) throw new Error("root post failed");
    this.n += 1;
    const ts = `1764100000.00${this.n}`;
    this.posts.push({ ...args, ts });
    return { ts };
  };
}

interface Call {
  prompt: string;
  resume: string | undefined;
  workingDir: string;
  hooks: RunHooks;
}

type Behavior = (call: Call) => Promise<RunResult>;

async function setup(
  opts: { now?: Date; ceilingMs?: number; dir?: string; behavior?: Behavior; slackTimeoutMs?: number; ivyDir?: string } = {},
) {
  const dataDir = opts.dir ?? (await mkdtemp(join(tmpdir(), "food-chat-data-")));
  const ivyDir = opts.ivyDir ?? (await mkdtemp(join(tmpdir(), "food-chat-ivy-")));
  const store = new ChatStore(dataDir);
  const { interrupted, queued } = await store.load();
  const sheet = new FakeSheet();
  const slack = new FakeSlack();
  const calls: Call[] = [];
  let behavior: Behavior =
    opts.behavior ?? (async () => ({ text: "Logged it.", sessionId: "sess-1" }));
  const runClaude = async (
    prompt: string,
    resume: string | undefined,
    workingDir: string,
    hooks: RunHooks = {},
  ): Promise<RunResult> => {
    const call = { prompt, resume, workingDir, hooks };
    calls.push(call);
    return behavior(call);
  };
  const chat = new FoodChat({
    config: {
      secret: SECRET,
      channel: CHANNEL,
      ivyDir,
      ceilingMs: opts.ceilingMs ?? 60_000,
      ...(opts.slackTimeoutMs ? { slackTimeoutMs: opts.slackTimeoutMs } : {}),
    },
    store,
    runClaude,
    foodlogGet: sheet.get,
    slack,
    now: () => opts.now ?? new Date("2026-11-26T18:30:00Z"),
  });
  const server = createFoodChatServer(chat);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const request = async (method: string, path: string, body?: unknown, secret: string | null = SECRET) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret !== null) headers["x-foodchat-secret"] = secret;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  return {
    dataDir,
    ivyDir,
    store,
    interrupted,
    queued,
    sheet,
    slack,
    calls,
    chat,
    request,
    setBehavior: (b: Behavior) => {
      behavior = b;
    },
    close: async () => {
      await chat.idle();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Writes one row the way the foodlog CLI would under the run's marker. */
function writeRow(sheet: FakeSheet, call: Call, items: string, n = 1): void {
  const env = call.hooks.env ?? {};
  sheet.add(env.IVY_CHAT_DATE!, items, `${env.IVY_CHAT_MARKER}-${n} 12:30:00`);
}

test("a turn returns 202; a repeat turn ID returns the same turn and never runs again", async () => {
  const t = await setup({
    behavior: async (call) => {
      call.hooks.onActivity?.({ type: "assistant", count: 1 });
      writeRow(t.sheet, call, "eggs");
      return { text: "Logged eggs.", sessionId: "sess-1" };
    },
  });
  const body = { turnId: uuid(1), chat: DAY, text: "two eggs", photos: [] };
  const first = await t.request("POST", "/turns", body);
  assert.equal(first.status, 202);
  assert.equal(first.body.turn.turnId, uuid(1));
  assert.equal(first.body.turn.tag, turnTag(uuid(1)));
  await t.chat.idle();

  const again = await t.request("POST", "/turns", body);
  assert.equal(again.status, 200);
  assert.equal(again.body.turn.turnId, uuid(1));
  assert.equal(again.body.turn.state, "done");
  await t.chat.idle();
  assert.equal(t.calls.length, 1);

  const turn = t.store.getTurn(uuid(1))!;
  assert.equal(turn.rows.length, 1);
  assert.equal(turn.rows[0]!.items, "eggs");
  assert.equal(turn.rows[0]!.date, "2026-11-26");
  assert.ok(turn.heartbeatAt);
  assert.equal(t.calls[0]!.hooks.env!.IVY_CHAT_MARKER, `via Ivy chat ${turnTag(uuid(1))}`);
  assert.equal(t.calls[0]!.hooks.env!.IVY_CHAT_DATE, "2026-11-26");

  const view = await t.request("GET", `/chats/${encodeURIComponent(DAY)}`);
  assert.equal(view.status, 200);
  assert.deepEqual(
    view.body.entries.map((e: any) => [e.kind, e.text]),
    [
      ["message", "two eggs"],
      ["reply", "Logged eggs."],
    ],
  );
  await t.close();
});

test("a request without the secret, or with the wrong one, gets 401 and stores nothing", async () => {
  const t = await setup();
  const body = { turnId: uuid(2), chat: DAY, text: "toast", photos: [] };
  const none = await t.request("POST", "/turns", body, null);
  const wrong = await t.request("POST", "/turns", body, "nope");
  const health = await t.request("GET", "/health", undefined, null);
  assert.equal(none.status, 401);
  assert.deepEqual(none.body, { error: "unauthorized" });
  assert.equal(wrong.status, 401);
  assert.equal(health.status, 401);
  await t.chat.idle();
  assert.equal(t.store.getTurn(uuid(2)), undefined);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(await readdir(t.dataDir), []);
  assert.equal((await t.request("GET", "/health")).status, 200);
  await t.close();
});

test("a bad chat key or turn ID gets 400 and stores nothing", async () => {
  const t = await setup();
  const badKey = await t.request("POST", "/turns", { turnId: uuid(3), chat: "day:2026-02-30", text: "x", photos: [] });
  const badId = await t.request("POST", "/turns", { turnId: "not-a-uuid", chat: DAY, text: "x", photos: [] });
  const badRead = await t.request("GET", `/chats/${encodeURIComponent("day:nope")}`);
  assert.equal(badKey.status, 400);
  assert.equal(badId.status, 400);
  assert.equal(badRead.status, 400);
  assert.deepEqual(await readdir(t.dataDir), []);
  await t.close();
});

test("two turns in one chat run in order; the second shows queued until the first is done", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const order: string[] = [];
  const t = await setup({
    behavior: async (call) => {
      const name = call.prompt.includes("first") ? "first" : "second";
      order.push(`${name} start`);
      if (name === "first") await gate;
      order.push(`${name} end`);
      return { text: name, sessionId: "sess-1" };
    },
  });
  await t.request("POST", "/turns", { turnId: uuid(10), chat: DAY, text: "first", photos: [] });
  await t.request("POST", "/turns", { turnId: uuid(11), chat: DAY, text: "second", photos: [] });
  await new Promise((r) => setTimeout(r, 30));
  const mid = await t.request("GET", `/chats/${encodeURIComponent(DAY)}`);
  const states = Object.fromEntries(mid.body.turns.map((x: any) => [x.turnId, x.state]));
  assert.equal(states[uuid(10)], "running");
  assert.equal(states[uuid(11)], "queued");
  release();
  await t.chat.idle();
  assert.deepEqual(order, ["first start", "first end", "second start", "second end"]);
  assert.equal(t.store.getTurn(uuid(11))!.state, "done");
  await t.close();
});

test("a turn's record lists only rows carrying its own marker", async () => {
  const otherTag = turnTag(uuid(21));
  const t = await setup({
    behavior: async (call) => {
      writeRow(t.sheet, call, "eggs", 1);
      t.sheet.add("2026-11-26", "coffee", `via Ivy chat ${otherTag}-1 12:31:00`);
      t.sheet.add("2026-11-26", "banana", "via Ivy 12:32:00");
      writeRow(t.sheet, call, "toast", 2);
      return { text: "Logged.", sessionId: "sess-1" };
    },
  });
  await t.request("POST", "/turns", { turnId: uuid(20), chat: DAY, text: "eggs and toast", photos: [] });
  await t.chat.idle();
  const turn = t.store.getTurn(uuid(20))!;
  assert.deepEqual(
    turn.rows.map((r) => r.items),
    ["eggs", "toast"],
  );
  assert.equal(turn.state, "done");
  await t.close();
});

test("a turn where Ivy throws after one write ends partial with that row", async () => {
  const t = await setup({
    behavior: async (call) => {
      writeRow(t.sheet, call, "eggs");
      throw new Error("subprocess died");
    },
  });
  await t.request("POST", "/turns", { turnId: uuid(30), chat: DAY, text: "eggs", photos: [] });
  await t.chat.idle();
  const turn = t.store.getTurn(uuid(30))!;
  assert.equal(turn.state, "partial");
  assert.match(turn.error!, /subprocess died/);
  assert.deepEqual(
    turn.rows.map((r) => r.items),
    ["eggs"],
  );
  await t.close();
});

test("a run with an error and no rows ends failed", async () => {
  const t = await setup({ behavior: async () => ({ text: "", sessionId: null, error: "no luck" }) });
  await t.request("POST", "/turns", { turnId: uuid(31), chat: DAY, text: "eggs", photos: [] });
  await t.chat.idle();
  const turn = t.store.getTurn(uuid(31))!;
  assert.equal(turn.state, "failed");
  assert.equal(turn.error, "no luck");
  await t.close();
});

test("a turn past the ceiling is aborted, keeps the row written as the abort lands, and holds the queue until it settles", async () => {
  const order: string[] = [];
  const t = await setup({
    ceilingMs: 40,
    behavior: async (call) => {
      if (call.prompt.includes("second")) {
        order.push("second start");
        return { text: "ok", sessionId: "sess-1" };
      }
      const signal = call.hooks.signal!;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      order.push("first abort seen");
      await new Promise((r) => setTimeout(r, 30));
      writeRow(t.sheet, call, "late row");
      order.push("first settled");
      return { text: "", sessionId: null, error: "aborted" };
    },
  });
  await t.request("POST", "/turns", { turnId: uuid(40), chat: DAY, text: "first", photos: [] });
  await t.request("POST", "/turns", { turnId: uuid(41), chat: DAY, text: "second", photos: [] });
  await t.chat.idle();
  assert.deepEqual(order, ["first abort seen", "first settled", "second start"]);
  const turn = t.store.getTurn(uuid(40))!;
  assert.equal(turn.state, "partial");
  assert.match(turn.error!, /ceiling/);
  assert.deepEqual(
    turn.rows.map((r) => r.items),
    ["late row"],
  );
  await t.close();
});

test("two Slack-timestamp turns 10 seconds apart get different markers and only their own rows", async () => {
  const t = await setup({
    behavior: async (call) => {
      writeRow(t.sheet, call, call.prompt.includes("one") ? "apple" : "pear");
      return { text: "ok", sessionId: "sess-1" };
    },
  });
  const a = "1764100000.000100";
  const b = "1764100010.000100";
  await t.chat.submit({ turnId: a, chat: DAY, origin: "slack", text: "one", photos: [] });
  await t.chat.submit({ turnId: b, chat: DAY, origin: "slack", text: "two", photos: [] });
  await t.chat.idle();
  const ta = t.store.getTurn(a)!;
  const tb = t.store.getTurn(b)!;
  assert.notEqual(ta.tag, tb.tag);
  assert.deepEqual(
    ta.rows.map((r) => r.items),
    ["apple"],
  );
  assert.deepEqual(
    tb.rows.map((r) => r.items),
    ["pear"],
  );
  await t.close();
});

test("a failed root post leaves the turn done with its session stored; the next turn retries the post and resumes", async () => {
  const t = await setup();
  t.slack.failRoot = true;
  await t.request("POST", "/turns", { turnId: uuid(50), chat: DAY, text: "eggs", photos: [] });
  await t.chat.idle();
  const first = t.store.getTurn(uuid(50))!;
  assert.equal(first.state, "done");
  assert.equal(first.mirrored, false);
  assert.equal(t.store.getSession(DAY), "sess-1");
  assert.equal(t.store.getThreadTs(DAY), null);

  t.slack.failRoot = false;
  await t.request("POST", "/turns", { turnId: uuid(51), chat: DAY, text: "toast", photos: [] });
  await t.chat.idle();
  assert.equal(t.calls[1]!.resume, "sess-1");
  const root = t.slack.posts.find((p) => !p.thread_ts)!;
  assert.equal(root.channel, CHANNEL);
  const threadTs = t.store.getThreadTs(DAY)!;
  assert.equal(threadTs, root.ts);
  assert.equal(t.store.chatForThread(threadTs), DAY);
  assert.ok(t.slack.posts.some((p) => p.thread_ts === threadTs && p.text.includes("toast")));
  assert.ok(t.slack.posts.some((p) => p.thread_ts === threadTs && p.text.includes("Logged it.")));
  assert.equal(t.store.getTurn(uuid(51))!.mirrored, true);
  await t.close();
});

test("a body over the limit gets 413 and no turn is recorded", async () => {
  const t = await setup();
  const data = Buffer.alloc(MAX_BODY_BYTES).toString("base64");
  const res = await t.request("POST", "/turns", {
    turnId: uuid(60),
    chat: DAY,
    text: "label",
    photos: [{ name: "label.jpg", mime: "image/jpeg", data }],
  });
  assert.equal(res.status, 413);
  assert.deepEqual(res.body, { error: "too large" });
  assert.equal(t.store.getTurn(uuid(60)), undefined);
  assert.equal(t.calls.length, 0);
  await t.close();
});

test("a photo turn saves each photo under the Ivy working dir and lists it in the prompt", async () => {
  const t = await setup();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  await t.request("POST", "/turns", {
    turnId: uuid(61),
    chat: DAY,
    text: "",
    photos: [{ name: "../nutrition label.jpg", mime: "image/jpeg", data: jpeg.toString("base64") }],
  });
  await t.chat.idle();
  const dir = join(t.ivyDir, ".slack-uploads", `food-chat-day-2026-11-26-${turnTag(uuid(61))}`);
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(dir, files[0]!)), jpeg);
  assert.ok(t.calls[0]!.prompt.includes(join(dir, files[0]!)));
  assert.equal(t.calls[0]!.workingDir, t.ivyDir);
  await t.close();
});

test("a past day's prompt names the date and says it is not today, whatever the clock says", async () => {
  const t = await setup({ now: new Date("2026-11-26T18:30:00Z") });
  t.sheet.add("2026-11-25", "oatmeal", "via Ivy 08:00:00");
  await t.request("POST", "/turns", { turnId: uuid(70), chat: "day:2026-11-25", text: "a shake as a snack", photos: [] });
  await t.chat.idle();
  const prompt = t.calls[0]!.prompt;
  assert.match(prompt, /2026-11-25/);
  assert.match(prompt, /not today/);
  assert.match(prompt, /Today is 2026-11-26/);
  assert.match(prompt, new RegExp(`via Ivy chat ${turnTag(uuid(70))}`));
  assert.match(prompt, /oatmeal/);
  assert.match(prompt, /Egg Bake/);
  assert.match(prompt, /not instructions/);
  assert.match(prompt, /a shake as a snack/);

  const t2 = await setup({ now: new Date("2026-11-26T05:30:00Z") });
  await t2.request("POST", "/turns", { turnId: uuid(71), chat: "day:2026-11-25", text: "x", photos: [] });
  await t2.chat.idle();
  // 05:30 UTC on Nov 26 is still Nov 25 in Chicago.
  assert.match(t2.calls[0]!.prompt, /This date is today/);
  await t.close();
  await t2.close();
});

test("a Slack post that throws still ends the turn done, marked not mirrored", async () => {
  const t = await setup();
  t.slack.failAll = true;
  await t.request("POST", "/turns", { turnId: uuid(80), chat: DAY, text: "eggs", photos: [] });
  await t.chat.idle();
  const turn = t.store.getTurn(uuid(80))!;
  assert.equal(turn.state, "done");
  assert.equal(turn.mirrored, false);
  await t.close();
});

test("an event ID already seen is stored once and starts no turn", async () => {
  const t = await setup();
  const event = {
    eventId: uuid(90),
    chat: DAY,
    kind: "log",
    entries: [
      {
        date: "2026-11-26",
        meal: "Lunch",
        items: "Egg Bake",
        calories: 400,
        protein: 30,
        carbs: 10,
        fiber: 2,
        fat: 25,
        sodium: 700,
        notes: "via Ivy 12:00:00",
      },
    ],
  };
  const first = await t.request("POST", "/events", event);
  const again = await t.request("POST", "/events", event);
  assert.equal(first.status, 202);
  assert.deepEqual(first.body, { ok: true });
  assert.equal(again.status, 200);
  await t.chat.idle();
  const view = await t.request("GET", `/chats/${encodeURIComponent(DAY)}`);
  assert.equal(view.body.entries.length, 1);
  assert.equal(view.body.entries[0].event.kind, "log");
  assert.equal(t.calls.length, 0);
  assert.ok(t.slack.posts.some((p) => p.thread_ts && p.text.includes("Egg Bake")));
  await t.close();
});

test("events since the last turn reach the next prompt as data", async () => {
  const t = await setup();
  await t.request("POST", "/events", {
    eventId: uuid(91),
    chat: DAY,
    kind: "delete",
    entries: [{ date: "2026-11-26", meal: "Lunch", items: "Old Toast", calories: 90, protein: 3, carbs: 15, fiber: 1, fat: 1, sodium: 150, notes: "" }],
  });
  await t.request("POST", "/turns", { turnId: uuid(92), chat: DAY, text: "eggs", photos: [] });
  await t.chat.idle();
  assert.match(t.calls[0]!.prompt, /delete.*Old Toast/);
  await t.close();
});

test("an Undo result moves the turn to partly undone; an unknown turn gets 404", async () => {
  const t = await setup({
    behavior: async (call) => {
      writeRow(t.sheet, call, "eggs", 1);
      writeRow(t.sheet, call, "toast", 2);
      return { text: "ok", sessionId: "sess-1" };
    },
  });
  await t.request("POST", "/turns", { turnId: uuid(95), chat: DAY, text: "eggs", photos: [] });
  await t.chat.idle();
  const res = await t.request("POST", `/turns/${uuid(95)}/undo`, { removed: 1, total: 2, alreadyGone: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.turn.state, "partly_undone");
  const missing = await t.request("POST", `/turns/${uuid(96)}/undo`, { removed: 0, total: 0, alreadyGone: 0 });
  assert.equal(missing.status, 404);
  await t.close();
});

test("after a restart a turn left running becomes interrupted and its rows are found by marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "food-chat-data-"));
  const before = new ChatStore(dir);
  await before.load();
  await before.acceptTurn({ turnId: uuid(100), chat: DAY, origin: "app", text: "eggs", photoCount: 0 });
  await before.updateTurn(uuid(100), { state: "running" });

  const t = await setup({ dir });
  assert.equal(t.interrupted.length, 1);
  t.sheet.add("2026-11-26", "eggs", `via Ivy chat ${turnTag(uuid(100))}-1 08:00:00`);
  t.sheet.add("2026-11-26", "toast", "via Ivy 08:01:00");
  await t.chat.recover(t.interrupted);
  const turn = t.store.getTurn(uuid(100))!;
  assert.equal(turn.state, "interrupted");
  assert.deepEqual(
    turn.rows.map((r) => r.items),
    ["eggs"],
  );
  assert.equal(t.calls.length, 0);
  await t.close();
});

test("the Recipes chat prompt says not to log food, and a recipes turn marks recipes as changed", async () => {
  const t = await setup({
    behavior: async (call) => {
      assert.equal(call.hooks.env!.IVY_CHAT_DATE, undefined);
      t.sheet.recipes[0] = { ...t.sheet.recipes[0]!, protein: 38 };
      return { text: "Updated Egg Bake.", sessionId: "sess-r" };
    },
  });
  await t.request("POST", "/turns", { turnId: uuid(110), chat: "recipes", text: "egg bake is 38 g protein now", photos: [] });
  await t.chat.idle();
  const prompt = t.calls[0]!.prompt;
  assert.match(prompt, /must not log food/i);
  assert.match(prompt, /foodlog upsert-recipe/);
  assert.match(prompt, /Egg Bake/);
  const turn = t.store.getTurn(uuid(110))!;
  assert.equal(turn.state, "done");
  assert.equal(turn.recipe!.action, "updated");
  assert.equal(turn.recipe!.name, "Egg Bake");
  assert.equal(turn.recipe!.before!.protein, 30);
  assert.equal(turn.recipe!.after.protein, 38);
  const view = await t.request("GET", "/chats/recipes");
  assert.ok(view.body.recipesChangedAt);
  await t.close();
});

test("after a restart a queued turn runs to done in order, and the running one is interrupted with its rows read back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "food-chat-data-"));
  const ivyDir = await mkdtemp(join(tmpdir(), "food-chat-ivy-"));
  const before = new ChatStore(dir);
  await before.load();
  await before.acceptTurn({ turnId: uuid(120), chat: DAY, origin: "app", text: "eggs", photoCount: 0 });
  await before.updateTurn(uuid(120), { state: "running" });
  await before.acceptTurn({ turnId: uuid(121), chat: DAY, origin: "app", text: "toast please", photoCount: 1 });
  await before.acceptTurn({ turnId: uuid(122), chat: DAY, origin: "app", text: "and coffee", photoCount: 0 });
  // The queued turn's photo, saved before the restart the way submit() saves it.
  const photoDir = join(ivyDir, ".slack-uploads", `food-chat-day-2026-11-26-${turnTag(uuid(121))}`);
  await mkdir(photoDir, { recursive: true });
  await writeFile(join(photoDir, "1-toast.jpg"), Buffer.from([0xff, 0xd8, 0xff]));

  const order: string[] = [];
  const t = await setup({
    dir,
    ivyDir,
    behavior: async (call) => {
      order.push(call.prompt.includes("toast please") ? "toast" : call.prompt.includes("and coffee") ? "coffee" : "other");
      writeRow(t.sheet, call, call.prompt.includes("toast please") ? "toast" : "coffee");
      return { text: "Logged.", sessionId: "sess-1" };
    },
  });
  assert.deepEqual(t.interrupted.map((x) => x.turnId), [uuid(120)]);
  assert.deepEqual(t.queued.map((x) => x.turnId), [uuid(121), uuid(122)]);
  t.sheet.add("2026-11-26", "eggs", `via Ivy chat ${turnTag(uuid(120))}-1 08:00:00`);

  await t.chat.resumeAfterRestart({ interrupted: t.interrupted, queued: t.queued });
  await t.chat.idle();

  const running = t.store.getTurn(uuid(120))!;
  assert.equal(running.state, "interrupted");
  assert.deepEqual(running.rows.map((r) => r.items), ["eggs"]);

  assert.deepEqual(order, ["toast", "coffee"]);
  const toast = t.store.getTurn(uuid(121))!;
  assert.equal(toast.state, "done");
  assert.deepEqual(toast.rows.map((r) => r.items), ["toast"]);
  assert.ok(t.calls[0]!.prompt.includes(join(photoDir, "1-toast.jpg")));
  assert.equal(t.store.getTurn(uuid(122))!.state, "done");
  await t.close();
});

test("when the post-run Food Log read fails, the turn ends interrupted with the read-back error", async () => {
  const t = await setup({
    behavior: async (call) => {
      writeRow(t.sheet, call, "eggs");
      t.sheet.failActions.add("foodlog");
      return { text: "Logged eggs.", sessionId: "sess-1" };
    },
  });
  await t.request("POST", "/turns", { turnId: uuid(130), chat: DAY, text: "eggs", photos: [] });
  await t.chat.idle();
  const turn = t.store.getTurn(uuid(130))!;
  assert.equal(turn.state, "interrupted");
  assert.match(turn.error!, /^Could not read the Food Log back: /);
  await t.close();
});

test("when the Recipes chat's post-run read fails, the turn ends interrupted with the read-back error", async () => {
  const t = await setup({
    behavior: async () => {
      t.sheet.failActions.add("recipes");
      return { text: "Updated.", sessionId: "sess-r" };
    },
  });
  await t.request("POST", "/turns", { turnId: uuid(131), chat: "recipes", text: "egg bake is 38 g", photos: [] });
  await t.chat.idle();
  const turn = t.store.getTurn(uuid(131))!;
  assert.equal(turn.state, "interrupted");
  assert.match(turn.error!, /^Could not read the Food Log back: /);
  await t.close();
});

test("when recover's read-back fails, the turn stays interrupted with the error set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "food-chat-data-"));
  const before = new ChatStore(dir);
  await before.load();
  await before.acceptTurn({ turnId: uuid(132), chat: DAY, origin: "app", text: "eggs", photoCount: 0 });
  await before.updateTurn(uuid(132), { state: "running" });
  const t = await setup({ dir });
  t.sheet.failActions.add("foodlog");
  await t.chat.recover(t.interrupted);
  const turn = t.store.getTurn(uuid(132))!;
  assert.equal(turn.state, "interrupted");
  assert.match(turn.error!, /^Could not read the Food Log back: /);
  await t.close();
});

test("a Slack root post that never settles times out: the turn ends done, not mirrored, and the next turn starts", async () => {
  const t = await setup({ slackTimeoutMs: 50 });
  t.slack.hangAll = true;
  await t.request("POST", "/turns", { turnId: uuid(140), chat: DAY, text: "first", photos: [] });
  await t.request("POST", "/turns", { turnId: uuid(141), chat: DAY, text: "second", photos: [] });
  await t.chat.idle();
  for (const id of [uuid(140), uuid(141)]) {
    const turn = t.store.getTurn(id)!;
    assert.equal(turn.state, "done");
    assert.equal(turn.mirrored, false);
  }
  assert.equal(t.calls.length, 2);
  await t.close();
});

test("a Slack thread post that never settles times out: the turn ends done, not mirrored, and the next turn starts", async () => {
  const t = await setup({ slackTimeoutMs: 50 });
  t.slack.hangReplies = true;
  await t.request("POST", "/turns", { turnId: uuid(142), chat: DAY, text: "first", photos: [] });
  await t.request("POST", "/turns", { turnId: uuid(143), chat: DAY, text: "second", photos: [] });
  await t.chat.idle();
  for (const id of [uuid(142), uuid(143)]) {
    const turn = t.store.getTurn(id)!;
    assert.equal(turn.state, "done");
    assert.equal(turn.mirrored, false);
  }
  assert.equal(t.calls.length, 2);
  // One root thread only: the root post landed and the replies timed out.
  assert.equal(t.slack.posts.filter((p) => !p.thread_ts).length, 1);
  await t.close();
});

test("an app event posted while a turn is running reaches the next turn's prompt", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const t = await setup({
    behavior: async (call) => {
      if (call.prompt.includes("first")) {
        started();
        await gate;
      }
      return { text: "ok", sessionId: "sess-1" };
    },
  });
  await t.request("POST", "/turns", { turnId: uuid(150), chat: DAY, text: "first", photos: [] });
  await running;
  await t.request("POST", "/events", {
    eventId: uuid(151),
    chat: DAY,
    kind: "delete",
    entries: [{ date: "2026-11-26", meal: "Lunch", items: "Mid Run Toast", calories: 90, protein: 3, carbs: 15, fiber: 1, fat: 1, sodium: 150, notes: "" }],
  });
  release();
  await t.chat.idle();
  assert.doesNotMatch(t.calls[0]!.prompt, /Mid Run Toast/);
  await t.request("POST", "/turns", { turnId: uuid(152), chat: DAY, text: "second", photos: [] });
  await t.chat.idle();
  assert.match(t.calls[1]!.prompt, /delete.*Mid Run Toast/);
  // Delivered once: a third turn does not list it again.
  await t.request("POST", "/turns", { turnId: uuid(153), chat: DAY, text: "third", photos: [] });
  await t.chat.idle();
  assert.doesNotMatch(t.calls[2]!.prompt, /Mid Run Toast/);
  await t.close();
});

test("an undo path with a malformed percent sequence gets 400", async () => {
  const t = await setup();
  const res = await t.request("POST", "/turns/%E0%A4%A/undo", { removed: 0, total: 0, alreadyGone: 0 });
  assert.equal(res.status, 400);
  await t.close();
});

test("a turn stopped at the ceiling with no rows found ends interrupted, not failed, so it is never offered for resend", async () => {
  const t = await setup({
    ceilingMs: 40,
    behavior: async (call) => {
      const signal = call.hooks.signal!;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { text: "", sessionId: null, error: "Stopped by the caller.", stopped: "caller" };
    },
  });
  await t.request("POST", "/turns", { turnId: uuid(160), chat: DAY, text: "eggs", photos: [] });
  await t.chat.idle();
  const turn = t.store.getTurn(uuid(160))!;
  assert.equal(turn.state, "interrupted");
  assert.match(turn.error!, /Stopped at the time limit; nothing was found in the Food Log yet/);
  await t.close();
});

test("a run killed for going quiet with no rows found ends interrupted, not failed", async () => {
  const t = await setup({
    behavior: async () => ({ text: "", sessionId: null, error: "Went quiet for 5 minutes with no output.", stopped: "idle" }),
  });
  await t.request("POST", "/turns", { turnId: uuid(161), chat: DAY, text: "eggs", photos: [] });
  await t.chat.idle();
  const turn = t.store.getTurn(uuid(161))!;
  assert.equal(turn.state, "interrupted");
  assert.match(turn.error!, /nothing was found in the Food Log yet/);
  await t.close();
});

test("a run that ends with an ordinary error and no rows still ends failed with that error", async () => {
  const t = await setup({ behavior: async () => ({ text: "", sessionId: null, error: "API overloaded" }) });
  await t.request("POST", "/turns", { turnId: uuid(162), chat: DAY, text: "eggs", photos: [] });
  await t.chat.idle();
  const turn = t.store.getTurn(uuid(162))!;
  assert.equal(turn.state, "failed");
  assert.equal(turn.error, "API overloaded");
  await t.close();
});
