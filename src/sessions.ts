import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionRecord {
  sessionId: string;
  assistant: string;
}

type Store = Record<string, SessionRecord>;

export class SessionStore {
  private cache: Store | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<Store> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf8");
      this.cache = JSON.parse(raw) as Store;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = {};
      } else {
        throw err;
      }
    }
    return this.cache!;
  }

  async get(threadKey: string): Promise<SessionRecord | undefined> {
    const store = await this.load();
    return store[threadKey];
  }

  async set(threadKey: string, record: SessionRecord): Promise<void> {
    const store = await this.load();
    store[threadKey] = record;
    this.writing = this.writing.then(() => this.flush(store));
    await this.writing;
  }

  private async flush(store: Store): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(store, null, 2), "utf8");
  }
}
