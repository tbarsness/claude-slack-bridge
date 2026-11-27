import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Durable food-chat transcripts. One JSON file per chat key in a data
 * directory, written atomically (temp file, then rename). Holds every accepted
 * turn ID so a resend never runs twice, even after a restart, and each
 * chat's Claude session and Slack mirror thread.
 */

export interface Macros {
  calories: number;
  protein: number;
  carbs: number;
  fiber: number;
  fat: number;
  sodium: number;
}

export interface Row extends Macros {
  date: string;
  meal: string;
  items: string;
  notes: string;
}

export type TurnState =
  | "queued"
  | "running"
  | "done"
  | "partial"
  | "failed"
  | "interrupted"
  | "undone"
  | "partly_undone";

export type Origin = "app" | "slack";

export interface RecipeChange {
  action: "added" | "updated";
  name: string;
  before: Macros | null;
  after: Macros;
}

export interface UndoResult {
  removed: number;
  total: number;
  alreadyGone: number;
}

export interface Turn {
  turnId: string;
  chat: string;
  origin: Origin;
  state: TurnState;
  tag: string;
  rows: Row[];
  recipe: RecipeChange | null;
  error: string | null;
  undo: UndoResult | null;
  mirrored: boolean;
  heartbeatAt: string | null;
  /**
   * The chat's last entry seq when this turn's prompt was built. The next
   * turn's prompt lists app events after it, including any recorded while
   * this turn ran. Absent on turns stored before the field existed.
   */
  contextSeq?: number | null;
  createdAt: string;
  updatedAt: string;
}

export const EVENT_KINDS = ["log", "delete", "restore"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EntryEvent {
  kind: EventKind | "undo";
  entries: Row[];
  undo: UndoResult | null;
}

export interface Entry {
  seq: number;
  at: string;
  kind: "message" | "reply" | "event";
  origin: Origin | "bridge";
  turnId: string | null;
  text: string | null;
  photoCount: number | null;
  event: EntryEvent | null;
}

export interface ChatView {
  chat: string;
  cursor: string;
  entries: Entry[];
  turns: Turn[];
  recipesChangedAt: string | null;
}

interface ChatFile {
  chat: string;
  sessionId: string | null;
  threadTs: string | null;
  /** Kept in the recipes chat's file only; every chat reads it from there. */
  recipesChangedAt: string | null;
  lastSeq: number;
  entries: Entry[];
  turns: Turn[];
  eventIds: string[];
}

const DAY_KEY = /^day:(\d{4})-(\d{2})-(\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `recipes`, or `day:YYYY-MM-DD` naming a real calendar date. */
export function isChatKey(key: unknown): key is string {
  if (key === "recipes") return true;
  if (typeof key !== "string") return false;
  const m = DAY_KEY.exec(key);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Lowercase UUID, as required for app turn IDs and event IDs. */
export function isUuid(id: unknown): id is string {
  return typeof id === "string" && UUID.test(id);
}

/** File name for a chat, derived only from a validated key. */
export function chatFileName(key: string): string {
  if (!isChatKey(key)) throw new Error(`invalid chat key: ${key}`);
  return key === "recipes" ? "recipes.json" : `day-${key.slice(4)}.json`;
}

/** First 8 hex characters of SHA-256 of the turn ID. */
export function turnTag(turnId: string): string {
  return createHash("sha256").update(turnId).digest("hex").slice(0, 8);
}

export type TurnPatch = Partial<
  Pick<Turn, "state" | "rows" | "recipe" | "error" | "heartbeatAt" | "mirrored">
>;

export interface NewEntry {
  kind: Entry["kind"];
  origin: Entry["origin"];
  turnId?: string | null;
  text?: string | null;
  photoCount?: number | null;
  event?: EntryEvent | null;
}

export class ChatStore {
  private chats = new Map<string, ChatFile>();
  private turnIndex = new Map<string, Turn>();
  private eventIds = new Set<string>();
  private threadIndex = new Map<string, string>();
  private writing = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  /**
   * Read every chat file. Turns left running by a previous process become
   * interrupted and are returned so the caller can read their rows back.
   * Turns still queued never started (nothing could have been written for
   * them), so they stay queued and are returned in acceptance order for the
   * caller to run again.
   */
  async load(): Promise<{ interrupted: Turn[]; queued: Turn[] }> {
    await mkdir(this.dir, { recursive: true });
    const interrupted: Turn[] = [];
    const queued: Turn[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const file = JSON.parse(await readFile(join(this.dir, name), "utf8")) as ChatFile;
      if (!isChatKey(file.chat) || chatFileName(file.chat) !== name) continue;
      this.chats.set(file.chat, file);
      for (const id of file.eventIds) this.eventIds.add(id);
      if (file.threadTs) this.threadIndex.set(file.threadTs, file.chat);
      let changed = false;
      for (const turn of file.turns) {
        this.turnIndex.set(turn.turnId, turn);
        if (turn.state === "queued") {
          queued.push(turn);
        } else if (turn.state === "running") {
          turn.state = "interrupted";
          turn.updatedAt = new Date().toISOString();
          interrupted.push(turn);
          changed = true;
        }
      }
      if (changed) await this.save(file.chat);
    }
    return { interrupted, queued };
  }

  getTurn(turnId: string): Turn | undefined {
    return this.turnIndex.get(turnId);
  }

  /** The text of the message entry that opened this turn, or null. */
  messageText(turnId: string): string | null {
    const turn = this.turnIndex.get(turnId);
    if (!turn) return null;
    const entry = this.chats.get(turn.chat)?.entries.find((e) => e.kind === "message" && e.turnId === turnId);
    return entry?.text ?? null;
  }

  /**
   * Record a new turn as queued, with its message entry. A turn ID already
   * accepted returns the existing record and changes nothing.
   */
  async acceptTurn(input: {
    turnId: string;
    chat: string;
    origin: Origin;
    text: string;
    photoCount: number;
  }): Promise<{ turn: Turn; created: boolean }> {
    const existing = this.turnIndex.get(input.turnId);
    if (existing) return { turn: existing, created: false };
    const file = this.chat(input.chat);
    const now = new Date().toISOString();
    const turn: Turn = {
      turnId: input.turnId,
      chat: input.chat,
      origin: input.origin,
      state: "queued",
      tag: turnTag(input.turnId),
      rows: [],
      recipe: null,
      error: null,
      undo: null,
      mirrored: false,
      heartbeatAt: null,
      contextSeq: null,
      createdAt: now,
      updatedAt: now,
    };
    file.turns.push(turn);
    this.turnIndex.set(turn.turnId, turn);
    this.push(file, {
      kind: "message",
      origin: input.origin,
      turnId: input.turnId,
      text: input.text,
      photoCount: input.photoCount,
    });
    await this.save(input.chat);
    return { turn, created: true };
  }

  async updateTurn(turnId: string, patch: TurnPatch): Promise<Turn> {
    const turn = this.turnIndex.get(turnId);
    if (!turn) throw new Error(`unknown turn: ${turnId}`);
    Object.assign(turn, patch, { updatedAt: new Date().toISOString() });
    await this.save(turn.chat);
    return turn;
  }

  /**
   * Record the app's Undo result and add it to the transcript as one event.
   * Returns undefined for an unknown turn.
   */
  async recordUndo(turnId: string, undo: UndoResult): Promise<Turn | undefined> {
    const turn = this.turnIndex.get(turnId);
    if (!turn) return undefined;
    const complete = undo.removed + undo.alreadyGone === undo.total && undo.alreadyGone === 0;
    turn.state = complete ? "undone" : "partly_undone";
    turn.undo = { removed: undo.removed, total: undo.total, alreadyGone: undo.alreadyGone };
    turn.updatedAt = new Date().toISOString();
    this.push(this.chat(turn.chat), {
      kind: "event",
      origin: "app",
      turnId,
      event: { kind: "undo", entries: turn.rows, undo: turn.undo },
    });
    await this.save(turn.chat);
    return turn;
  }

  /** Store an app event once. Returns false when the event ID was already seen. */
  async recordEvent(input: {
    eventId: string;
    chat: string;
    kind: EventKind;
    entries: Row[];
  }): Promise<boolean> {
    if (this.eventIds.has(input.eventId)) return false;
    const file = this.chat(input.chat);
    file.eventIds.push(input.eventId);
    this.eventIds.add(input.eventId);
    this.push(file, {
      kind: "event",
      origin: "app",
      event: { kind: input.kind, entries: input.entries, undo: null },
    });
    await this.save(input.chat);
    return true;
  }

  async appendEntry(chat: string, entry: NewEntry): Promise<Entry> {
    const added = this.push(this.chat(chat), entry);
    await this.save(chat);
    return added;
  }

  /** Entries after `since` (all when omitted), and every turn in the chat. */
  read(chat: string, since?: string): ChatView {
    const file = this.chats.get(chat);
    const after = Number(since) || 0;
    return {
      chat,
      cursor: String(file?.lastSeq ?? 0),
      entries: file ? file.entries.filter((e) => e.seq > after) : [],
      turns: file ? file.turns : [],
      recipesChangedAt: this.chats.get("recipes")?.recipesChangedAt ?? null,
    };
  }

  /** Event entries after the chat's last reply, oldest first. */
  eventsAfterLastReply(chat: string): Entry[] {
    const entries = this.chats.get(chat)?.entries ?? [];
    const out: Entry[] = [];
    for (let i = entries.length - 1; i >= 0 && entries[i]!.kind !== "reply"; i--) {
      if (entries[i]!.kind === "event") out.push(entries[i]!);
    }
    return out.reverse();
  }

  /**
   * App events for this turn's prompt: those after the latest point any
   * earlier turn in the chat built its prompt, so events recorded while that
   * turn ran are still delivered. Records this turn's own point. A chat whose
   * turns predate contextSeq falls back to events after the last reply.
   */
  async takeEventsForPrompt(turnId: string): Promise<Entry[]> {
    const turn = this.turnIndex.get(turnId);
    if (!turn) throw new Error(`unknown turn: ${turnId}`);
    const file = this.chat(turn.chat);
    let after: number | null = null;
    for (const t of file.turns) {
      if (t.turnId === turnId || typeof t.contextSeq !== "number") continue;
      after = Math.max(after ?? 0, t.contextSeq);
    }
    const events =
      after === null
        ? this.eventsAfterLastReply(turn.chat)
        : file.entries.filter((e) => e.kind === "event" && e.seq > after!);
    turn.contextSeq = file.lastSeq;
    turn.updatedAt = new Date().toISOString();
    await this.save(turn.chat);
    return events;
  }

  getSession(chat: string): string | null {
    return this.chats.get(chat)?.sessionId ?? null;
  }

  async setSession(chat: string, sessionId: string): Promise<void> {
    this.chat(chat).sessionId = sessionId;
    await this.save(chat);
  }

  getThreadTs(chat: string): string | null {
    return this.chats.get(chat)?.threadTs ?? null;
  }

  async setThreadTs(chat: string, threadTs: string): Promise<void> {
    this.chat(chat).threadTs = threadTs;
    this.threadIndex.set(threadTs, chat);
    await this.save(chat);
  }

  /** The chat whose Slack mirror thread has this root timestamp. */
  chatForThread(threadTs: string): string | undefined {
    return this.threadIndex.get(threadTs);
  }

  async setRecipesChangedAt(at: string): Promise<void> {
    this.chat("recipes").recipesChangedAt = at;
    await this.save("recipes");
  }

  private chat(key: string): ChatFile {
    let file = this.chats.get(key);
    if (!file) {
      chatFileName(key);
      file = {
        chat: key,
        sessionId: null,
        threadTs: null,
        recipesChangedAt: null,
        lastSeq: 0,
        entries: [],
        turns: [],
        eventIds: [],
      };
      this.chats.set(key, file);
    }
    return file;
  }

  private push(file: ChatFile, entry: NewEntry): Entry {
    file.lastSeq += 1;
    const added: Entry = {
      seq: file.lastSeq,
      at: new Date().toISOString(),
      kind: entry.kind,
      origin: entry.origin,
      turnId: entry.turnId ?? null,
      text: entry.text ?? null,
      photoCount: entry.photoCount ?? null,
      event: entry.event ?? null,
    };
    file.entries.push(added);
    return added;
  }

  /** Writes for one chat run one at a time, each as temp file then rename. */
  private save(chat: string): Promise<void> {
    const name = chatFileName(chat);
    const path = join(this.dir, name);
    const prev = this.writing.get(chat) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const tmp = `${path}.tmp`;
        await writeFile(tmp, JSON.stringify(this.chats.get(chat)), "utf8");
        await rename(tmp, path);
      });
    this.writing.set(chat, next);
    return next;
  }
}
