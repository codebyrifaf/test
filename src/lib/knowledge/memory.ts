import "server-only";
import { database } from "@/lib/server/database";
import { AppError } from "@/lib/server/errors";

// The memory is one private text object in the existing private bucket, so no
// schema migration is needed. Anonymous/authenticated clients are denied.
const BUCKET = "reference-documents";
const MEMORY_PATH = "relay-memory/memory.txt";
export const MAX_MEMORY_CHARACTERS = 100_000;

export type Knowledge = { memory: string };

export async function readMemory(): Promise<string> {
  const { data, error } = await database()
    .storage.from(BUCKET)
    .download(MEMORY_PATH);
  if (error) {
    const status = String(
      (error as { statusCode?: unknown }).statusCode ??
        (error as { status?: unknown }).status,
    );
    if (status === "404") return "";
    throw new AppError("STORAGE_UNAVAILABLE", 503);
  }
  return await data.text();
}

export async function saveMemory(memory: string) {
  const { error } = await database()
    .storage.from(BUCKET)
    .upload(MEMORY_PATH, Buffer.from(memory, "utf8"), {
      upsert: true,
      contentType: "text/plain; charset=utf-8",
      cacheControl: "0",
    });
  if (error) throw new AppError("STORAGE_UNAVAILABLE", 503);
  invalidateKnowledge();
}

// Shared through globalThis so every route bundle in this process uses one cache.
type CacheState = {
  knowledge: Knowledge | null;
  loadedAt: number;
  loading: Promise<Knowledge> | null;
  version: number;
};
const cache = ((globalThis as { __relayKnowledge?: CacheState })
  .__relayKnowledge ??= {
  knowledge: null,
  loadedAt: 0,
  loading: null,
  version: 0,
});
const FRESH_MS = 15_000;
const STALE_LIMIT_MS = 10 * 60_000;

function refresh(): Promise<Knowledge> {
  if (cache.loading) return cache.loading;
  const version = cache.version;
  const loading = readMemory()
    .then((memory) => {
      const knowledge: Knowledge = { memory };
      if (version === cache.version) {
        cache.knowledge = knowledge;
        cache.loadedAt = Date.now();
      }
      return knowledge;
    })
    .finally(() => {
      if (cache.loading === loading) cache.loading = null;
    });
  cache.loading = loading;
  return loading;
}

/**
 * Returns the memory without a storage round trip when possible. Slightly old
 * data is served while a refresh runs; saves in this process apply at once.
 */
export function knowledgeSnapshot(): Promise<Knowledge> {
  const age = Date.now() - cache.loadedAt;
  if (cache.knowledge && age < FRESH_MS) return Promise.resolve(cache.knowledge);
  const loading = refresh();
  if (cache.knowledge && age < STALE_LIMIT_MS) {
    loading.catch(() => {});
    return Promise.resolve(cache.knowledge);
  }
  return loading;
}

/** Keeps the cache warm so a new question never waits for loading. */
export function warmKnowledge() {
  knowledgeSnapshot().catch(() => {});
}

/** Call after every knowledge change made in this process. */
export function invalidateKnowledge() {
  cache.version++;
  cache.knowledge = null;
  cache.loadedAt = 0;
  cache.loading = null;
  warmKnowledge();
}
