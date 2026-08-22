import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type JsonBody = Record<string, unknown>;

/** Port the UI binds to unless --port says otherwise. */
export const defaultUiPort = 4783;

// Transport for every route: read a JSON body, write a JSON/HTML reply, and
// serve the compiled dashboard client.

export async function readJson(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as JsonBody) : {};
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

export function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/**
 * The dashboard client lives in `src/ui-client` and is compiled to
 * `dist/ui-client`. Serve it from there rather than inlining it into the page:
 * a real module keeps the code type-checked and splittable.
 */
export function sendClientModule(res: ServerResponse, pathname: string): void {
  const relative = pathname.slice("/ui-client/".length);
  // Path traversal guard: only flat `.js` files from the compiled client.
  if (!/^[\w.-]+\.js$/.test(relative) || relative.includes("..")) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const file = join(uiClientDir(), relative);
  if (!existsSync(file)) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(readFileSync(file));
}

export function uiClientDir(packageRoot = cliPackageRoot()): string {
  return join(packageRoot, "dist", "ui-client");
}

export function cliPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
