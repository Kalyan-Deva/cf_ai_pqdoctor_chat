// DomainCache: one small Durable Object per domain, shared by every user, holding the last engine
// result for 10 minutes plus Llama's explanations of that exact result (one per stack).
//
// Why a Durable Object and not the Cache API: the Cache API is per data centre and does nothing on
// *.workers.dev, where this app runs. A Durable Object is global, needs no extra resource, and
// clears itself with an alarm when the entry expires.

import { DurableObject } from "cloudflare:workers";
import type { EngineResult } from "./engine";
import type { Explanation } from "./explain";

export const CACHE_MS = 10 * 60 * 1000;

interface Entry {
  result: EngineResult;
  storedAt: number;
}

export class DomainCache extends DurableObject<Env> {
  /** The cached engine result, if it's younger than maxAgeMs. */
  async get(maxAgeMs = CACHE_MS): Promise<EngineResult | null> {
    const e = await this.ctx.storage.get<Entry>("result");
    if (!e || Date.now() - e.storedAt > maxAgeMs) return null;
    return e.result;
  }

  async put(result: EngineResult): Promise<void> {
    const entry: Entry = { result, storedAt: Date.now() };
    // A new result invalidates explanations of the old one.
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("result", entry);
    await this.ctx.storage.setAlarm(Date.now() + CACHE_MS + 60_000);
  }

  /** Llama's explanation of this result for this stack (keyed by the result's checkedAt). */
  async getExplanation(checkedAt: number, stack: string[]): Promise<Explanation | null> {
    return (await this.ctx.storage.get<Explanation>(explanationKey(checkedAt, stack))) ?? null;
  }

  async putExplanation(checkedAt: number, stack: string[], e: Explanation): Promise<void> {
    if (await this.ctx.storage.get("result")) await this.ctx.storage.put(explanationKey(checkedAt, stack), e);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

function explanationKey(checkedAt: number, stack: string[]): string {
  return `explain:${checkedAt}:${[...stack].sort().join("+").toLowerCase()}`;
}
