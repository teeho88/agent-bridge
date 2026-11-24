import { Worker } from "node:worker_threads";
import { object, type Data } from "./service.js";

export class BackgroundRefresh {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (data: Data) => void; reject: (error: Error) => void }>();
  private failure?: Error;

  constructor(private project: string) {
    this.worker = import.meta.url.endsWith(".ts")
      ? new Worker(`import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(new URL("./refresh-worker.ts", import.meta.url).href)}, ${JSON.stringify(import.meta.url)}))`, { eval: true })
      : new Worker(new URL("./refresh-worker.js", import.meta.url));
    this.worker.on("message", ({ id, data, error }: { id: number; data?: unknown; error?: string }) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (error !== undefined) pending.reject(new Error(error));
      else pending.resolve(object(data));
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => this.fail(new Error(`Dashboard worker exited (${code})`)));
  }

  request(path: string): Promise<Data> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, project: this.project, path });
    });
  }

  close(): void {
    this.fail(new Error("Dashboard closed"));
    void this.worker.terminate();
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }
}
