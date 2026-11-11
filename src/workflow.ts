// CheckWorkflow: one durable run per "is <domain> post-quantum?".
//
//   1. run the pqdoctor check            (retried on 429/5xx, not on a refused name)
//   2. Llama 3.3 explains the result     (checked against the engine JSON; engine words on failure)
//   3. save it to the user's Durable Object
//   4. sleep 7 days, re-check, and post to the chat only if the verdict changed
//
// Each step's return value is persisted by Workflows, so a crash or deploy mid-run resumes at the
// step it was on, and the 7-day sleep costs nothing while it waits.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { EngineError, httpEngine, type Engine, type EngineResult } from "./engine";
import { explain } from "./explain";
import type { UserMemory } from "./memory";

export interface CheckParams {
  userId: string;
  host: string;
  stack: string[];
}

/** The one place the engine is chosen. Swap for a WASM engine here. */
export function engineFor(env: Env): Engine {
  return httpEngine(env.ENGINE_URL);
}

/** "7 days", "30 seconds", ... to milliseconds (for showing "re-check on <date>"). */
export function durationMs(d: string): number {
  const m = /^(\d+)\s*(second|minute|hour|day|week)s?$/i.exec(d.trim());
  if (!m) return 7 * 86_400_000;
  const unit = { second: 1e3, minute: 6e4, hour: 3.6e6, day: 8.64e7, week: 6.048e8 }[m[2].toLowerCase() as "day"];
  return Number(m[1]) * unit;
}

const CHECK_STEP = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;

export class CheckWorkflow extends WorkflowEntrypoint<Env, CheckParams> {
  async run(event: WorkflowEvent<CheckParams>, step: WorkflowStep) {
    const { userId, host, stack } = event.payload;
    const user = () => (this.env.USER as DurableObjectNamespace<UserMemory>).getByName(userId);
    const engine = engineFor(this.env);
    const recheckAfter = (this.env.RECHECK_AFTER as string) || "7 days";

    const check = (): Promise<EngineResult> =>
      engine.check(host).catch((e) => {
        // A name the engine refuses won't get better on retry; an outage or a 429 might.
        if (e instanceof EngineError && !e.retryable) throw new NonRetryableError(e.message);
        throw e;
      });

    // 1. The engine decides.
    let result: EngineResult;
    try {
      result = await step.do("run pqdoctor check", CHECK_STEP, check);
    } catch (e) {
      await step.do("save failure", () => user().saveFailure(host, (e as Error).message));
      return { host, status: "failed" };
    }

    // 2. The LLM explains (explain() never throws: it falls back to the engine's own words).
    const explanation = await step.do("explain with Llama 3.3", () => explain(this.env.AI, result, stack));

    // 3. Remember it.
    await step.do("save to memory", () => user().saveResult(host, result, explanation, durationMs(recheckAfter)));

    // 4. Watch it.
    await step.sleep("wait before re-check", recheckAfter as WorkflowSleepDuration);

    const previous = await step.do("load last verdict", () => user().latestVerdict(host, event.instanceId));
    if (previous === null) return { host, status: "forgotten" };

    let again: EngineResult;
    try {
      again = await step.do("re-check", CHECK_STEP, check);
    } catch {
      return { host, status: "recheck-failed", verdict: result.verdict };
    }

    const changed = again.verdict !== previous;
    const changeExplanation = changed ? await step.do("explain the change", () => explain(this.env.AI, again, stack)) : null;
    const posted = await step.do("save re-check", () => user().saveRecheck(host, again, previous, changeExplanation));
    return { host, status: posted ? "changed" : "unchanged", from: previous, to: again.verdict };
  }
}
