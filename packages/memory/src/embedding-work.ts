import type { EmbeddingProvider } from "./embeddings.js";

const pendingByProvider = new WeakMap<
  EmbeddingProvider,
  Set<Promise<number[]>>
>();
let activeCalls = 0;

function startEmbedding(
  provider: EmbeddingProvider,
  text: string,
  signal: AbortSignal,
): Promise<number[]> {
  const pending =
    pendingByProvider.get(provider) ?? new Set<Promise<number[]>>();
  if (pending.size >= 4 || activeCalls >= 16)
    throw new Error(
      "embedding_capacity_exceeded: wait for pending provider calls to settle",
    );
  const work = Promise.resolve().then(() => provider.embed(text, { signal }));
  pendingByProvider.set(provider, pending);
  pending.add(work);
  activeCalls++;
  const release = () => {
    pending.delete(work);
    activeCalls--;
  };
  void work.then(release, release);
  return work;
}

export async function embedWithPolicy(
  provider: EmbeddingProvider,
  text: string,
  options: { timeoutMs?: number; retries?: number } = {},
): Promise<number[]> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const retries = options.retries ?? 2;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(retries) ||
    retries < 0 ||
    retries > 5
  )
    throw new Error("Invalid embedding timeout/retry policy");
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        startEmbedding(provider, text, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`embedding_timeout: ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (
        attempt >= retries ||
        (error instanceof Error &&
          (error.message.startsWith("embedding_timeout") ||
            error.message.startsWith("embedding_capacity_exceeded")))
      )
        throw error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
  }
}
