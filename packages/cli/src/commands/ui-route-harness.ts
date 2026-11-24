import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export interface RouteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  json: <T = unknown>() => T;
}

export function makeRequest(
  method: string,
  path: string,
  body?: unknown,
): IncomingMessage {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const stream = Readable.from(payload ? [Buffer.from(payload, "utf8")] : []);
  return Object.assign(stream, {
    method,
    url: path,
    headers: { "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
}

export function makeResponse(): {
  res: ServerResponse;
  result: () => RouteResponse;
} {
  const chunks: Buffer[] = [];
  let status = 0;
  let headers: Record<string, string> = {};
  let ended = false;

  const push = (chunk: unknown): void => {
    if (chunk === undefined || chunk === null) return;
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"),
    );
  };

  const res = {
    writeHead(code: number, value?: Record<string, string>) {
      status = code;
      if (value) headers = value;
      return res;
    },
    write(chunk: unknown) {
      push(chunk);
      return true;
    },
    end(chunk?: unknown) {
      push(chunk);
      ended = true;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    get writableEnded() {
      return ended;
    },
  } as unknown as ServerResponse;

  return {
    res,
    result: () => {
      const body = Buffer.concat(chunks).toString("utf8");
      return {
        status,
        headers,
        body,
        json: <T,>() => JSON.parse(body) as T,
      };
    },
  };
}

export async function callRoute(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  method: string,
  path: string,
  body?: unknown,
): Promise<RouteResponse> {
  const { res, result } = makeResponse();
  await handler(makeRequest(method, path, body), res);
  return result();
}
