// The LLM explains, the engine decides.
//
// Llama 3.3 gets the engine's result as JSON and turns it into plain language, adapting the
// engine's own fix to the user's stack. It never sees the raw server, and it never decides
// anything: after it answers, `checkExplanation` compares what it wrote against the engine JSON.
// If it contradicts the verdict or names a group, version or product the engine didn't, the
// explanation is thrown away and the user gets the engine's own words instead.

import { isPqVerdict, verdictLabel, type EngineResult } from "./engine";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface Explanation {
  text: string;
  /** "llm" = Llama's text passed the check; "engine" = the engine's own words (fallback). */
  source: "llm" | "engine";
  /** Why Llama's text was rejected, when it was. */
  rejected?: string;
}

/** The facts Llama is allowed to use. Nothing else about the host reaches the model. */
export function factsFor(result: EngineResult, stack: string[]) {
  return {
    host: result.host,
    verdict: result.verdict,
    verdictInWords: verdictLabel(result.verdict),
    headline: result.headline,
    cause: result.cause,
    negotiatedGroup: result.group,
    warnings: result.warnings,
    fixes: result.fixes,
    verifyCommand: result.verify,
    certificate: result.certificate,
    userStack: stack.length ? stack : null,
  };
}

export const EXPLAIN_SYSTEM = `You explain results from pqdoctor, a post-quantum TLS checker, to the person who asked.
The JSON you are given is pqdoctor's result. It is the only source of truth.

Rules:
1. First sentence: the verdict for the host, matching "headline" exactly in meaning. Never upgrade, soften or change it.
2. Second: why, in everyday words, from "cause" only. Do not add other reasons or guess about the server.
3. Then the fix. Only recommend fixes that are in "fixes", most relevant first.
   If "userStack" is set, adapt the fix to that stack: if a fix's snippet already has a line for their stack, use that line; otherwise write the same setting in their stack's own config syntax, keeping exactly the same values (same group names in the same order, same versions). For example an OpenSSL "Groups = A:B:C" list becomes nginx's "ssl_ecdh_curve A:B:C;" or Caddy's "curves" list. Say in one short clause that this is pqdoctor's fix written for their stack.
   Do not add steps, settings, products, versions or commands that no fix contains.
4. If you can't express the fix in their stack's syntax, give pqdoctor's snippet as is and say it's the general form.
5. If "fixes" is empty, say there is nothing to fix.
6. Under 130 words, written to the person ("your server"). No headings, at most one short list. Put config in one fenced code block.`;

export function explainMessages(result: EngineResult, stack: string[]) {
  return [
    { role: "system" as const, content: EXPLAIN_SYSTEM },
    { role: "user" as const, content: `pqdoctor result:\n${JSON.stringify(factsFor(result, stack), null, 2)}` },
  ];
}

// ---------- the check ----------

const GROUP_NAMES = /\b(x25519mlkem768|secp256r1mlkem768|secp384r1mlkem1024|x25519kyber768(?:draft00)?|x25519|x448|p-?256|p-?384|p-?521|prime256v1|secp256r1|secp384r1|ml-?kem-?\d*|kyber\d*|ml-?dsa-?\d*)\b/gi;
const VERSIONS = /\b\d+\.\d+(?:\.\d+)?\+?/g;
const PRODUCTS = [
  "openssl", "boringssl", "aws-lc", "libressl", "wolfssl", "gnutls", "rustls", "golang", "nginx", "apache", "caddy",
  "haproxy", "envoy", "traefik", "iis", "cloudflared", "cloudflare tunnel", "tomcat", "java", "node", "bouncy castle", "schannel",
];

const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");

/**
 * Is this explanation faithful to the engine? Returns null if so, or the reason it isn't.
 * Deliberately strict: a false rejection costs a less friendly sentence, a false pass costs trust.
 */
export function checkExplanation(text: string, result: EngineResult, stack: string[]): string | null {
  const allowed = norm(JSON.stringify(factsFor(result, stack)) + " " + stack.join(" "));
  const lower = text.toLowerCase();

  // 1. The verdict. A non-PQ result must never be described as post-quantum, and vice versa.
  const claimsPq = /\b(?:is|are|it's|already|fully)\s+(?:already\s+|fully\s+)?(?:post-quantum|pq)(?:[\s-]+(?:ready|safe|secure|enabled))?\b/i.test(text) &&
    !/\b(?:not|isn't|aren't|no longer|never)\s+(?:yet\s+)?(?:post-quantum|pq)\b/i.test(text) &&
    !/\b(?:isn't|aren't|is not|are not)\b[^.]{0,30}\b(?:post-quantum|pq)\b/i.test(text);
  const deniesPq = /\b(?:not|isn't|aren't)\s+(?:yet\s+)?(?:post-quantum|pq)\b|\bis not\b[^.]{0,30}\bpost-quantum\b/i.test(text);
  if (!isPqVerdict(result.verdict) && result.verdict !== "mixed" && claimsPq) return "said the server is post-quantum, but the engine says it isn't";
  if (isPqVerdict(result.verdict) && deniesPq && !/\borigin\b/i.test(text)) return "said the server isn't post-quantum, but the engine says it is";

  // 2. Key-exchange groups: only the ones the engine mentioned.
  for (const m of text.matchAll(GROUP_NAMES)) {
    const g = norm(m[1]);
    const ok = allowed.includes(g) || (g === "p256" && allowed.includes("prime256v1")) || (g === "prime256v1" && allowed.includes("p256"));
    if (!ok) return `mentioned ${m[1]}, which isn't in the engine's result`;
  }

  // 3. Version numbers: only the engine's.
  for (const m of text.matchAll(VERSIONS)) {
    const v = m[0].replace(/\+$/, "");
    if (/tls\s?v?$/i.test(text.slice(Math.max(0, m.index! - 5), m.index))) continue; // "TLS 1.3" is a protocol, not advice
    if (!allowed.includes(v)) return `mentioned version ${m[0]}, which isn't in the engine's result`;
  }

  // 4. Products and libraries: only the engine's, or the user's own stack.
  for (const p of PRODUCTS) {
    const re = new RegExp(`\\b${p.replace(/[-]/g, "[- ]?")}\\b`, "i");
    if (re.test(lower) && !allowed.includes(norm(p))) return `recommended ${p}, which isn't in the engine's result or your stack`;
  }

  if (text.trim().length < 20) return "the answer was empty";
  return null;
}

/** The engine's own words, used when Llama is unavailable or its answer fails the check. */
export function engineWords(result: EngineResult): string {
  if (result.kind === "cloudflare") return `${result.headline}. ${result.cause}`;
  const lines = [`${result.headline}. ${result.cause}`];
  if (result.warnings.length) lines.push(`Warning: ${result.warnings.join(" ")}`);
  const fix = result.fixes[0];
  if (fix) {
    lines.push(`pqdoctor's fix: ${fix.title}. ${fix.detail}`);
    if (fix.snippet) lines.push("```\n" + fix.snippet + "\n```");
  } else {
    lines.push("Nothing to fix.");
  }
  return lines.join("\n\n");
}

type AiLike = { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };

/** Ask Llama 3.3 to explain the result; fall back to the engine's words if it fails or strays. */
export async function explain(ai: AiLike, result: EngineResult, stack: string[]): Promise<Explanation> {
  let text = "";
  try {
    const out = (await ai.run(MODEL, { messages: explainMessages(result, stack), max_tokens: 450, temperature: 0.2 })) as { response?: unknown };
    text = typeof out?.response === "string" ? out.response.trim() : "";
  } catch (e) {
    return { text: engineWords(result), source: "engine", rejected: `Workers AI didn't answer (${(e as Error).message})` };
  }
  const problem = checkExplanation(text, result, stack);
  if (problem) return { text: engineWords(result), source: "engine", rejected: `Llama ${problem}` };
  return { text, source: "llm" };
}
