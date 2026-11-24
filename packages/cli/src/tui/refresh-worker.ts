import { parentPort } from "node:worker_threads";
import { request } from "./service.js";

parentPort!.on("message", async ({ id, project, path }: { id: number; project: string; path: string }) => {
  try {
    const data = await request(project, "GET", path);
    parentPort!.postMessage({ id, data });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
