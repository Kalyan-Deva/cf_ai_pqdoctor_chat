// The pqdoctor engine, behind one interface.
//
// Today `httpEngine` calls pqdoctor.com/api/check, which runs the pqdoctor Rust engine (compiled to
// WebAssembly) on Cloudflare's network. The rest of the app only sees `Engine.check()` and the
// normalised `EngineResult`, so swapping in the WASM engine locally (raw `cloudflare:sockets` +
// the same .wasm) means writing one more `Engine`, not touching the workflow or the chat.

export interface Fix {
  title: string;
  detail: string;
  snippet: string | null;
}

/** What the rest of the app knows about a check. Every field comes from the engine's JSON. */
export interface EngineResult {
  host: string;
  port: number;
  ip: string;
  /** "report" = the engine probed the server; "cloudflare" = the name is on Cloudflare's edge. */
  kind: "report" | "cloudflare";
  /** The engine's verdict code: "pq", "notPq", "noTls13", ... or "cloudflare-edge". */
  verdict: string;
  headline: string;
  cause: string;
  causeCode: string | null;
  group: string | null;
  fixes: Fix[];
  warnings: string[];
  /** The engine's one-line openssl command to confirm the result yourself. */
  verify: string | null;
  /** The ML-DSA certificate headline, when the engine checked it. */
  certificate: string | null;
  checkedAt: number;
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** false for answers that won't change on retry (bad name, private address, no DNS). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface Engine {
  check(host: string): Promise<EngineResult>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function httpEngine(endpoint: string, fetcher: FetchLike = fetch): Engine {
  return {
    async check(host) {
      const url = `${endpoint}?host=${encodeURIComponent(host)}`;
      let res: Response;
      try {
        res = await fetcher(url, {
          headers: { accept: "application/json", "user-agent": "cf-ai-pqdoctor-chat/0.1" },
          signal: AbortSignal.timeout(45_000),
        });
      } catch (e) {
        throw new EngineError(`pqdoctor didn't answer (${(e as Error).message}).`, 503, true);
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // fall through: normalise() reports it
      }
      return normalise(body, res.status);
    },
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function warningText(w: unknown): string | null {
  if (typeof w === "string") return w;
  if (w && typeof w === "object") {
    const o = w as Record<string, unknown>;
    return str(o.message) ?? str(o.title) ?? str(o.detail) ?? str(o.code);
  }
  return null;
}

/** Turn the engine's HTTP answer into an EngineResult, or throw an EngineError. */
export function normalise(body: unknown, status: number): EngineResult {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  if (status >= 400 || !("kind" in o)) {
    const message = str(o.error) ?? str(o.message) ?? `pqdoctor answered HTTP ${status}.`;
    // 429 and 5xx can pass; 4xx (bad name, private address, no records) won't.
    const retryable = status === 429 || status >= 500 || status < 400;
    throw new EngineError(message, status, retryable);
  }

  if (o.kind === "cloudflare") {
    return {
      host: String(o.host ?? ""),
      port: Number(o.port ?? 443),
      ip: String(o.ip ?? ""),
      kind: "cloudflare",
      verdict: "cloudflare-edge",
      headline: "Served by Cloudflare: the edge already negotiates X25519MLKEM768",
      cause: str(o.message) ?? "",
      causeCode: null,
      group: "X25519MLKEM768",
      fixes: [],
      warnings: [],
      verify: null,
      certificate: null,
      checkedAt: Date.now(),
    };
  }

  if (o.kind === "report" && o.report && typeof o.report === "object") {
    const r = o.report as Record<string, unknown>;
    const fixes = Array.isArray(r.fixes)
      ? r.fixes
          .map((f) => f as Record<string, unknown>)
          .filter((f) => str(f.title))
          .map((f) => ({ title: String(f.title), detail: str(f.detail) ?? "", snippet: str(f.snippet) }))
      : [];
    const auth = r.auth && typeof r.auth === "object" ? (r.auth as Record<string, unknown>) : null;
    return {
      host: String(r.host ?? ""),
      port: Number(r.port ?? 443),
      ip: String(r.ip ?? ""),
      kind: "report",
      verdict: str(r.verdict) ?? "unknown",
      headline: str(r.headline) ?? "",
      cause: str(r.cause) ?? "",
      causeCode: str(r.causeCode),
      group: str(r.group),
      fixes,
      warnings: Array.isArray(r.warnings) ? r.warnings.map(warningText).filter((w): w is string => !!w) : [],
      verify: str(r.verify),
      certificate: auth ? str(auth.headline) : null,
      checkedAt: typeof r.checkedAt === "number" ? r.checkedAt : Date.now(),
    };
  }

  throw new EngineError("pqdoctor sent an answer this app doesn't understand.", 502, false);
}

/** Short, human label for a verdict code (for the UI and the change notice). */
export function verdictLabel(verdict: string): string {
  return VERDICTS[verdict]?.label ?? verdict;
}

/** The engine's seven verdicts (pqdoctor::Verdict) plus this app's "on Cloudflare's edge". */
export const VERDICTS: Record<string, { label: string; tone: "good" | "warn" | "bad" | "info" }> = {
  pq: { label: "post-quantum", tone: "good" },
  pqWithWarning: { label: "post-quantum, with a warning", tone: "warn" },
  mixed: { label: "mixed (post-quantum on some connections)", tone: "warn" },
  notPq: { label: "not post-quantum", tone: "bad" },
  noTls13: { label: "not post-quantum (no TLS 1.3)", tone: "bad" },
  broken: { label: "breaks on post-quantum", tone: "bad" },
  unreachable: { label: "unreachable", tone: "info" },
  "cloudflare-edge": { label: "post-quantum at Cloudflare's edge", tone: "good" },
};

/** True when the engine says the connection is post-quantum (fully or with a caveat). */
export const isPqVerdict = (v: string) => v === "pq" || v === "pqWithWarning" || v === "cloudflare-edge";
