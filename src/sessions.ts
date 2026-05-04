import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

type Store = Record<string, string>;

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

  async get(threadId: string): Promise<string | undefined> {
    const store = await this.load();
    return store[threadId];
  }

  async set(threadId: string, sessionId: string): Promise<void> {
    const store = await this.load();
    store[threadId] = sessionId;
    this.writing = this.writing.then(() => this.flush(store));
    await this.writing;
  }

  private async flush(store: Store): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(store, null, 2), "utf8");
  }
}
