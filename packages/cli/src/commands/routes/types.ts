import type { IncomingMessage, ServerResponse } from "node:http";
import type { UrlWithParsedQuery } from "node:url";

/**
 * What a route handler is given. `cwd` is the workspace the UI server was
 * started against, resolved once per request so a handler never reaches for
 * module state.
 */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: UrlWithParsedQuery;
  method: string;
  cwd: string;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

/** Keyed by `"<METHOD> <pathname>"`, matched exactly. */
export type RouteTable = Record<string, RouteHandler>;
