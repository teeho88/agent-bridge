import { Writable } from "node:stream";
import { open, rename, writeFile } from "node:fs/promises";

export type RunLogPolicy = { segmentBytes?: number; maxSegments?: number };

export function createRunLog(path: string, pressure: (paused: boolean) => void, failed: (error: Error) => void, policy: RunLogPolicy = {}) {
  const segmentBytes = policy.segmentBytes ?? 8388608;
  const maxSegments = policy.maxSegments ?? 16;
  if (!Number.isInteger(segmentBytes) || segmentBytes < 4 || !Number.isInteger(maxSegments) || maxSegments < 1) throw new Error("Invalid run log policy");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let size = 0;
  let segment = 1;
  let error: Error | undefined;
  const segments: string[] = [];
  const persistManifest = async () => {
    const target = `${path}.segments.json`;
    await writeFile(`${target}.tmp`, JSON.stringify({ schemaVersion: 1, segments: [...segments, path], segmentBytes, maxSegments }));
    await rename(`${target}.tmp`, target);
  };
  const append = async (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (size === segmentBytes) {
        if (segment >= maxSegments) throw new Error("log_capacity_exceeded: output retained; increase run log capacity before retrying");
        await handle?.close(); handle = undefined;
        const previous = `${path}.${segment++}`;
        await rename(path, previous);
        segments.push(previous);
        size = 0;
        await persistManifest();
      }
      handle ??= await open(path, "a");
      let end = Math.min(chunk.length, offset + segmentBytes - size);
      while (end < chunk.length && end > offset && (chunk[end] & 0xc0) === 0x80) end--;
      if (end === offset) { size = segmentBytes; continue; }
      await handle.writeFile(chunk.subarray(offset, end));
      size += end - offset;
      offset = end;
    }
  };
  const stream = new Writable({
    highWaterMark: 65536,
    write(chunk: Buffer, _encoding, done) { append(chunk).then(() => done(), (value: Error) => done(value)); },
    final(done) { (async () => { await handle?.close(); handle = undefined; if (segments.length) await persistManifest(); })().then(() => done(), done); },
    destroy(value, done) { (async () => { await handle?.close(); handle = undefined; })().then(() => done(value), done); },
  });
  stream.on("drain", () => pressure(false));
  stream.on("error", (value) => { error = value; failed(value); });
  return {
    write(text: string): void {
      if (!text || error || stream.destroyed) return;
      if (!stream.write(text, "utf8")) pressure(true);
    },
    async finish(): Promise<Error | undefined> {
      if (stream.destroyed) return error;
      await new Promise<void>((resolve) => {
        stream.once("finish", resolve);
        stream.once("error", () => resolve());
        stream.end();
      });
      return error;
    },
  };
}
