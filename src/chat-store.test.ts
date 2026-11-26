import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore, chatFileName, isChatKey, isUuid, turnTag, type Row } from "./chat-store.js";

const TURN_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const TURN_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const EVENT_1 = "16fd2706-8baf-433b-82eb-8c7fada847da";
const DAY = "day:2026-11-26";

const ROW: Row = {
  date: "2026-11-26",
  meal: "Breakfast",
  items: "2 eggs",
  calories: 140,
  protein: 12,
  carbs: 1,
  fiber: 0,
  fat: 10,
  sodium: 140,
  notes: "via Ivy chat 1a2b3c4d-1 08:00:00",
};

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "chat-store-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function openStore(dir: string) {
  const store = new ChatStore(dir);
  const interrupted = await store.load();
  return { store, interrupted };
}

test("chat keys: recipes and real calendar days only", () => {
  assert.equal(isChatKey("recipes"), true);
  assert.equal(isChatKey("day:2026-11-26"), true);
  assert.equal(isChatKey("day:2024-02-29"), true);
  assert.equal(isChatKey("day:2026-02-30"), false);
  assert.equal(isChatKey("day:2026-13-01"), false);
  assert.equal(isChatKey("day:../../etc"), false);
  assert.equal(isChatKey("Recipes"), false);
  assert.equal(chatFileName("day:2026-11-26"), "day-2026-11-26.json");
  assert.equal(chatFileName("recipes"), "recipes.json");
  assert.throws(() => chatFileName("day:../x"));
});

test("turn and event IDs must be lowercase UUIDs", () => {
  assert.equal(isUuid(TURN_A), true);
  assert.equal(isUuid(TURN_A.toUpperCase()), false);
  assert.equal(isUuid("1764172800.123456"), false);
});

test("the tag is the first 8 hex of SHA-256 of the turn ID", () => {
  // sha256("abc") = ba7816bf...
  assert.equal(turnTag("abc"), "ba7816bf");
});

test("accepting a turn ID twice returns the first record and creates nothing", async () => {
  await withDir(async (dir) => {
    const { store } = await openStore(dir);
    const first = await store.acceptTurn({ turnId: TURN_A, chat: DAY, origin: "app", text: "eggs", photoCount: 0 });
    assert.equal(first.created, true);
    assert.equal(first.turn.state, "queued");
    assert.equal(first.turn.tag, turnTag(TURN_A));
    const second = await store.acceptTurn({ turnId: TURN_A, chat: DAY, origin: "app", text: "eggs again", photoCount: 0 });
    assert.equal(second.created, false);
    assert.deepEqual(second.turn, first.turn);
    const chat = store.read(DAY);
    assert.equal(chat.turns.length, 1);
    assert.equal(chat.entries.length, 1);
    assert.equal(chat.entries[0].text, "eggs");
  });
});

test("a store reloaded from disk still reports an accepted turn ID as known", async () => {
  await withDir(async (dir) => {
    const { store } = await openStore(dir);
    await store.acceptTurn({ turnId: TURN_A, chat: DAY, origin: "app", text: "eggs", photoCount: 0 });
    await store.updateTurn(TURN_A, { state: "done", rows: [ROW] });

    const { store: reloaded } = await openStore(dir);
    assert.equal(reloaded.getTurn(TURN_A)?.state, "done");
    const again = await reloaded.acceptTurn({ turnId: TURN_A, chat: DAY, origin: "app", text: "eggs", photoCount: 0 });
    assert.equal(again.created, false);
    assert.deepEqual(again.turn.rows, [ROW]);
    assert.equal(reloaded.read(DAY).entries.length, 1);
  });
});

test("on reload, turns left queued or running become interrupted and are returned", async () => {
  await withDir(async (dir) => {
    const { store } = await openStore(dir);
    await store.acceptTurn({ turnId: TURN_A, chat: DAY, origin: "app", text: "eggs", photoCount: 0 });
    await store.updateTurn(TURN_A, { state: "running" });
    await store.acceptTurn({ turnId: TURN_B, chat: DAY, origin: "app", text: "toast", photoCount: 0 });

    const { store: reloaded, interrupted } = await openStore(dir);
    assert.deepEqual(interrupted.map((t) => t.turnId).sort(), [TURN_A, TURN_B].sort());
    assert.equal(reloaded.getTurn(TURN_A)?.state, "interrupted");
    assert.equal(reloaded.getTurn(TURN_B)?.state, "interrupted");

    const { interrupted: third } = await openStore(dir);
    assert.deepEqual(third, []);
  });
});

test("since returns only entries newer than the cursor, in order", async () => {
  await withDir(async (dir) => {
    const { store } = await openStore(dir);
    await store.acceptTurn({ turnId: TURN_A, chat: DAY, origin: "app", text: "eggs", photoCount: 1 });
    await store.appendEntry(DAY, { kind: "reply", origin: "bridge", turnId: TURN_A, text: "Logged eggs" });
    const first = store.read(DAY);
    assert.deepEqual(first.entries.map((e) => e.seq), [1, 2]);
    assert.equal(first.entries[0].photoCount, 1);
    assert.equal(first.entries[1].event, null);

    await store.appendEntry(DAY, { kind: "message", origin: "slack", turnId: TURN_B, text: "and toast" });
    await store.appendEntry(DAY, { kind: "reply", origin: "bridge", turnId: TURN_B, text: "Logged toast" });
    const next = store.read(DAY, first.cursor);
    assert.deepEqual(next.entries.map((e) => e.text), ["and toast", "Logged toast"]);
    assert.deepEqual(next.entries.map((e) => e.seq), [3, 4]);
    assert.equal(store.read(DAY, next.cursor).entries.length, 0);
    assert.equal(store.read(DAY, next.cursor).cursor, next.cursor);
  });
});

test("an unknown chat reads as empty", async () => {
  await withDir(async (dir) => {
    const { store } = await openStore(dir);
    const chat = store.read("recipes");
    assert.deepEqual(chat, { chat: "recipes", cursor: "0", entries: [], turns: [], recipesChangedAt: null });
  });
});

test("recording an Undo result moves the turn to undone or partly undone", async () => {
  await withDir(async (dir) => {
    const { store } = await openStore(dir);
    await store.acceptTurn({ turnId: TURN_A, chat: DAY, origin: "app", text: "eggs", photoCount: 0 });
    await store.acceptTurn({ turnId: TURN_B, chat: DAY, origin: "app", text: "toast", photoCount: 0 });

    const full = await store.recordUndo(TURN_A, { removed: 3, total: 3, alreadyGone: 0 });
    assert.equal(full?.state, "undone");
    assert.deepEqual(full?.undo, { removed: 3, total: 3, alreadyGone: 0 });

    const partly = await store.recordUndo(TURN_B, { removed: 2, total: 3, alreadyGone: 1 });
    assert.equal(partly?.state, "partly_undone");
    assert.deepEqual(partly?.undo, { removed: 2, total: 3, alreadyGone: 1 });

    const undoEntries = store.read(DAY).entries.filter((e) => e.event?.kind === "undo");
    assert.equal(undoEntries.length, 2);
    assert.deepEqual(undoEntries[1].event?.undo, { removed: 2, total: 3, alreadyGone: 1 });

    assert.equal(await store.recordUndo("11111111-1111-4111-8111-111111111111", { removed: 0, total: 0, alreadyGone: 0 }), undefined);
  });
});

test("an event ID already seen is stored once, also after reload", async () => {
  await withDir(async (dir) => {
    const { store } = await openStore(dir);
    assert.equal(await store.recordEvent({ eventId: EVENT_1, chat: DAY, kind: "log", entries: [ROW] }), true);
    assert.equal(await store.recordEvent({ eventId: EVENT_1, chat: DAY, kind: "log", entries: [ROW] }), false);
    const { store: reloaded } = await openStore(dir);
    assert.equal(await reloaded.recordEvent({ eventId: EVENT_1, chat: DAY, kind: "log", entries: [ROW] }), false);
    const entries = reloaded.read(DAY).entries;
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].event, { kind: "log", entries: [ROW], undo: null });
    assert.equal(entries[0].origin, "app");
  });
});

test("session, thread and recipesChangedAt persist and threadTs maps back to the chat", async () => {
  await withDir(async (dir) => {
    const { store } = await openStore(dir);
    await store.setSession(DAY, "session-1");
    await store.setThreadTs(DAY, "1764172800.000100");
    await store.setRecipesChangedAt("2026-11-26T18:00:00.000Z");

    const { store: reloaded } = await openStore(dir);
    assert.equal(reloaded.getSession(DAY), "session-1");
    assert.equal(reloaded.getThreadTs(DAY), "1764172800.000100");
    assert.equal(reloaded.chatForThread("1764172800.000100"), DAY);
    assert.equal(reloaded.chatForThread("1764172800.999999"), undefined);
    assert.equal(reloaded.read(DAY).recipesChangedAt, "2026-11-26T18:00:00.000Z");
    assert.equal(reloaded.read("recipes").recipesChangedAt, "2026-11-26T18:00:00.000Z");
  });
});

test("turn fields update and persist", async () => {
  await withDir(async (dir) => {
    const { store } = await openStore(dir);
    await store.acceptTurn({ turnId: TURN_A, chat: "recipes", origin: "slack", text: "update egg bake", photoCount: 0 });
    const recipe = {
      action: "updated" as const,
      name: "Egg bake",
      before: { calories: 300, protein: 20, carbs: 5, fiber: 1, fat: 20, sodium: 400 },
      after: { calories: 320, protein: 22, carbs: 5, fiber: 1, fat: 21, sodium: 410 },
    };
    await store.updateTurn(TURN_A, {
      state: "failed",
      recipe,
      error: "boom",
      heartbeatAt: "2026-11-26T18:00:00.000Z",
      mirrored: true,
    });
    const { store: reloaded } = await openStore(dir);
    const turn = reloaded.getTurn(TURN_A)!;
    assert.equal(turn.origin, "slack");
    assert.equal(turn.state, "failed");
    assert.deepEqual(turn.recipe, recipe);
    assert.equal(turn.error, "boom");
    assert.equal(turn.heartbeatAt, "2026-11-26T18:00:00.000Z");
    assert.equal(turn.mirrored, true);
    assert.equal(reloaded.read("recipes").entries[0].origin, "slack");
  });
});

test("a crash mid-write leaves the previous file readable", async () => {
  await withDir(async (dir) => {
    const { store } = await openStore(dir);
    await store.acceptTurn({ turnId: TURN_A, chat: DAY, origin: "app", text: "eggs", photoCount: 0 });
    await store.updateTurn(TURN_A, { state: "done" });
    const good = await readFile(join(dir, "day-2026-11-26.json"), "utf8");
    // A write that died before its rename leaves only a partial temp file.
    await writeFile(join(dir, "day-2026-11-26.json.tmp"), good.slice(0, 20), "utf8");

    const { store: reloaded } = await openStore(dir);
    assert.equal(reloaded.getTurn(TURN_A)?.state, "done");
    assert.equal(await readFile(join(dir, "day-2026-11-26.json"), "utf8"), good);

    await reloaded.appendEntry(DAY, { kind: "reply", origin: "bridge", turnId: TURN_A, text: "ok" });
    assert.deepEqual((await readdir(dir)).sort(), ["day-2026-11-26.json"]);
    JSON.parse(await readFile(join(dir, "day-2026-11-26.json"), "utf8"));
  });
});
