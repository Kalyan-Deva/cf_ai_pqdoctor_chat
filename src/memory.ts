// UserMemory: one Durable Object per user, SQLite inside. This is the app's memory:
//   messages  the chat history (with the engine's result card on check answers)
//   results   every check and re-check, with the full engine JSON and a timestamp
//   domains   each domain the user asked about: last verdict, when, and its re-check workflow
//   profile   the user's stack ("nginx", "Go", ...) and their id
//   hits      timestamps for the per-user rate limits

import { DurableObject } from "cloudflare:workers";
import { checkHostname, checkResolves } from "./guard";
import { findHostCandidates, findStack } from "./parse";
import { verdictLabel, type EngineResult } from "./engine";
import { MODEL, type Explanation } from "./explain";
import type { CheckParams } from "./workflow";

export const MAX_MESSAGE = 600;
const CHAT_PER_10_MIN = 30;

export interface Card {
  host: string;
  verdict: string;
  verdictLabel: string;
  headline: string;
  cause: string;
  fixes: EngineResult["fixes"];
  warnings: string[];
  verify: string | null;
  certificate: string | null;
  checkedAt: number;
  explainedBy: Explanation["source"];
  rejected?: string;
  recheck?: { from: string; to: string };
}

export interface Message {
  id: number;
  role: "user" | "assistant" | "notice";
  text: string;
  card: Card | null;
  createdAt: number;
}

export interface DomainRow {
  host: string;
  /** checking = first check running; watching = re-check scheduled; checked = re-check done; error = couldn't check. */
  status: "checking" | "watching" | "checked" | "error";
  lastVerdict: string | null;
  lastHeadline: string | null;
  lastChecked: number | null;
  recheckAt: number | null;
}

export interface State {
  messages: Message[];
  stack: string[];
  domains: DomainRow[];
  limits: { checksPerHour: number; checksLeft: number };
}

type Row = Record<string, SqlStorageValue>;

export class UserMemory extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.init();
  }

  private init() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL, card TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, verdict TEXT NOT NULL, headline TEXT NOT NULL, kind TEXT NOT NULL, engine TEXT NOT NULL, checked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS domains (host TEXT PRIMARY KEY, status TEXT NOT NULL, last_verdict TEXT, last_headline TEXT, last_checked INTEGER, workflow_id TEXT, recheck_at INTEGER, first_asked INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS profile (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hits (kind TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  }

  // ---------- reading ----------

  async state(since = 0): Promise<State> {
    const messages = this.sql
      .exec("SELECT * FROM messages WHERE id > ? ORDER BY id DESC LIMIT 200", since)
      .toArray()
      .reverse()
      .map(toMessage);
    const domains = this.sql
      .exec("SELECT * FROM domains ORDER BY COALESCE(last_checked, first_asked) DESC")
      .toArray()
      .map((r) => ({
        host: String(r.host),
        status: r.status as DomainRow["status"],
        lastVerdict: (r.last_verdict as string) ?? null,
        lastHeadline: (r.last_headline as string) ?? null,
        lastChecked: (r.last_checked as number) ?? null,
        recheckAt: (r.recheck_at as number) ?? null,
      }));
    const perHour = this.checksPerHour();
    return { messages, stack: this.stack(), domains, limits: { checksPerHour: perHour, checksLeft: Math.max(0, perHour - this.countHits("check", 3_600_000)) } };
  }

  // ---------- the chat ----------

  /** A user message: remember it, pick out stack + hosts, start checks or answer from memory. */
  async chat(userId: string, raw: string): Promise<State> {
    const since = this.lastId();
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return this.state(since);
    if (text.length > MAX_MESSAGE) {
      this.add("notice", `Messages are limited to ${MAX_MESSAGE} characters.`);
      return this.state(since);
    }
    if (this.countHits("chat", 600_000) >= CHAT_PER_10_MIN) {
      this.add("notice", "You're sending messages faster than this demo allows. Try again in a few minutes.");
      return this.state(since);
    }
    this.hit("chat");
    this.sql.exec("INSERT OR REPLACE INTO profile (key, value) VALUES ('userId', ?)", userId);
    this.add("user", text);

    const stack = findStack(text);
    if (stack.length) this.sql.exec("INSERT OR REPLACE INTO profile (key, value) VALUES ('stack', ?)", JSON.stringify(stack));

    const candidates = findHostCandidates(text);
    // "What did you find for x.com last time?" is a question about memory, not a new check.
    const aboutThePast = /\b(last time|previous(?:ly)?|before|earlier|history|what did (?:you|it) (?:find|say)|remember)\b/i.test(text) && !/\b(re-?check|check (?:it )?again|again now|right now)\b/i.test(text);
    const known = candidates.every((c) => this.sql.exec("SELECT 1 FROM domains WHERE host = ? AND last_verdict IS NOT NULL", c.toLowerCase()).toArray().length > 0);
    if (candidates.length === 0 || (aboutThePast && known)) {
      await this.reply(text, stack);
      return this.state(since);
    }

    for (const candidate of candidates) await this.startCheck(userId, candidate);
    return this.state(since);
  }

  private async startCheck(userId: string, candidate: string) {
    const name = checkHostname(candidate);
    if (!name.ok) return this.add("notice", `Not checking ${candidate}: ${name.reason}`);
    const host = name.host;

    const perHour = this.checksPerHour();
    if (this.countHits("check", 3_600_000) >= perHour) {
      return this.add("notice", `Not checking ${host}: you've used your ${perHour} checks for this hour. Try again later.`);
    }
    const resolved = await checkResolves(host);
    if (!resolved.ok) return this.add("notice", `Not checking ${host}: ${resolved.reason}`);
    this.hit("check");

    // One watch per domain: a new check replaces the old workflow (and its pending re-check).
    const old = this.sql.exec("SELECT workflow_id FROM domains WHERE host = ?", host).toArray()[0]?.workflow_id as string | undefined;
    if (old) {
      try {
        await (await this.env.CHECK.get(old)).terminate();
      } catch {
        // already finished or gone
      }
    }

    const params: CheckParams = { userId, host, stack: this.stack() };
    const instance = await this.env.CHECK.create({ params });
    this.sql.exec(
      `INSERT INTO domains (host, status, workflow_id, first_asked) VALUES (?, 'checking', ?, ?)
       ON CONFLICT(host) DO UPDATE SET status = 'checking', workflow_id = excluded.workflow_id, recheck_at = NULL`,
      host,
      instance.id,
      Date.now(),
    );
    const stackNote = params.stack.length ? ` I'll tailor pqdoctor's fix to ${params.stack.join(" + ")}.` : "";
    this.add("assistant", `Checking ${host} with pqdoctor…${stackNote}`);
  }

  /** No host in the message: Llama answers, from memory only, and never claims a verdict it wasn't given. */
  private async reply(text: string, stack: string[]) {
    const memory = {
      stack: this.stack(),
      domains: this.sql
        .exec("SELECT host, last_verdict, last_headline, last_checked FROM domains WHERE last_verdict IS NOT NULL ORDER BY last_checked DESC LIMIT 20")
        .toArray()
        .map((r) => ({ host: r.host, verdict: verdictLabel(String(r.last_verdict)), headline: r.last_headline, checked: new Date(Number(r.last_checked)).toISOString().slice(0, 10) })),
    };
    const history = this.sql
      .exec("SELECT role, text FROM messages WHERE role IN ('user', 'assistant') ORDER BY id DESC LIMIT 12")
      .toArray()
      .reverse()
      .map((r) => ({ role: r.role as "user" | "assistant", content: String(r.text).slice(0, 1200) }));

    const system = `You are pqdoctor Chat. You help people understand post-quantum TLS (hybrid ML-KEM key exchange such as X25519MLKEM768) for their own servers.
- You cannot check servers yourself. Checks are done by the pqdoctor engine when the user names a domain in a message, e.g. "is example.com post-quantum?".
- Never state or guess a verdict for a domain unless it is in MEMORY below, which holds the engine's past results. Quote those as the engine's, with their date.
- Don't give configuration advice for specific servers; say that checking their domain gets pqdoctor's exact fix, adapted to their stack.
- Keep answers short (under 120 words) and plain. Politely decline topics unrelated to TLS, cryptography or this app.
MEMORY: ${JSON.stringify(memory)}`;

    let answer = "";
    try {
      const out = (await this.env.AI.run(MODEL, { messages: [{ role: "system", content: system }, ...history], max_tokens: 350, temperature: 0.3 })) as { response?: unknown };
      answer = typeof out?.response === "string" ? out.response.trim() : "";
    } catch {
      // fall through to the canned answer
    }
    if (!answer) {
      answer = stack.length
        ? `Noted: you run ${stack.join(" + ")}. Name a domain ("is example.com post-quantum?") and I'll check it with pqdoctor.`
        : `Name a domain ("is example.com post-quantum?") and I'll check it with pqdoctor.`;
    } else if (stack.length && !/noted|got it/i.test(answer)) {
      answer = `Noted: you run ${stack.join(" + ")}.\n\n${answer}`;
    }
    this.add("assistant", answer);
  }

  // ---------- called by the workflow ----------

  /** Step 3: the first result for a check, with Llama's explanation. */
  async saveResult(host: string, result: EngineResult, explanation: Explanation, recheckAfterMs: number): Promise<void> {
    this.insertResult(host, result);
    this.sql.exec(
      "UPDATE domains SET status = 'watching', last_verdict = ?, last_headline = ?, last_checked = ?, recheck_at = ? WHERE host = ?",
      result.verdict,
      result.headline,
      result.checkedAt,
      Date.now() + recheckAfterMs,
      host,
    );
    this.add("assistant", explanation.text, cardFor(result, explanation));
  }

  /** A check that couldn't run (name refused by the engine, engine down after retries). */
  async saveFailure(host: string, message: string): Promise<void> {
    this.sql.exec("UPDATE domains SET status = 'error', recheck_at = NULL WHERE host = ?", host);
    this.add("notice", `Couldn't check ${host}: ${message}`);
  }

  /** The verdict to compare a re-check against: the latest stored one, or null if the domain was forgotten. */
  async latestVerdict(host: string, workflowId: string): Promise<string | null> {
    const row = this.sql.exec("SELECT last_verdict, workflow_id FROM domains WHERE host = ?", host).toArray()[0];
    if (!row || row.workflow_id !== workflowId) return null; // forgotten, or replaced by a newer check
    return (row.last_verdict as string) ?? null;
  }

  /** Step 4: store the re-check; post to the chat only if the verdict changed. */
  async saveRecheck(host: string, result: EngineResult, previous: string, explanation: Explanation | null): Promise<boolean> {
    this.insertResult(host, result);
    this.sql.exec("UPDATE domains SET status = 'checked', last_verdict = ?, last_headline = ?, last_checked = ?, recheck_at = NULL WHERE host = ?", result.verdict, result.headline, result.checkedAt, host);
    if (result.verdict === previous || !explanation) return false;
    const intro = `Re-check of ${host}: the verdict changed from ${verdictLabel(previous)} to ${verdictLabel(result.verdict)}.`;
    this.add("assistant", `${intro}\n\n${explanation.text}`, { ...cardFor(result, explanation), recheck: { from: previous, to: result.verdict } });
    return true;
  }

  /** Forget everything about this user. Pending re-checks find no domain and end quietly. */
  async forget(): Promise<void> {
    const ids = this.sql.exec("SELECT workflow_id FROM domains WHERE workflow_id IS NOT NULL").toArray();
    for (const r of ids) {
      try {
        await (await this.env.CHECK.get(String(r.workflow_id))).terminate();
      } catch {
        // already finished
      }
    }
    await this.ctx.storage.deleteAll();
    this.init();
  }

  // ---------- helpers ----------

  private insertResult(host: string, r: EngineResult) {
    this.sql.exec("INSERT INTO results (host, verdict, headline, kind, engine, checked_at) VALUES (?, ?, ?, ?, ?, ?)", host, r.verdict, r.headline, r.kind, JSON.stringify(r), r.checkedAt);
  }

  private add(role: Message["role"], text: string, card: Card | null = null) {
    this.sql.exec("INSERT INTO messages (role, text, card, created_at) VALUES (?, ?, ?, ?)", role, text, card ? JSON.stringify(card) : null, Date.now());
  }

  private lastId(): number {
    return Number(this.sql.exec("SELECT COALESCE(MAX(id), 0) AS id FROM messages").one().id);
  }

  private stack(): string[] {
    const row = this.sql.exec("SELECT value FROM profile WHERE key = 'stack'").toArray()[0];
    try {
      return row ? (JSON.parse(String(row.value)) as string[]) : [];
    } catch {
      return [];
    }
  }

  private checksPerHour(): number {
    const n = Number(this.env.CHECKS_PER_HOUR);
    return Number.isFinite(n) && n > 0 ? n : 10;
  }

  private hit(kind: string) {
    const now = Date.now();
    this.sql.exec("DELETE FROM hits WHERE at < ?", now - 3_600_000);
    this.sql.exec("INSERT INTO hits (kind, at) VALUES (?, ?)", kind, now);
  }

  private countHits(kind: string, windowMs: number): number {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM hits WHERE kind = ? AND at > ?", kind, Date.now() - windowMs).one().n);
  }
}

function cardFor(r: EngineResult, e: Explanation): Card {
  return {
    host: r.host,
    verdict: r.verdict,
    verdictLabel: verdictLabel(r.verdict),
    headline: r.headline,
    cause: r.cause,
    fixes: r.fixes,
    warnings: r.warnings,
    verify: r.verify,
    certificate: r.certificate,
    checkedAt: r.checkedAt,
    explainedBy: e.source,
    ...(e.rejected ? { rejected: e.rejected } : {}),
  };
}

function toMessage(r: Row): Message {
  return {
    id: Number(r.id),
    role: r.role as Message["role"],
    text: String(r.text),
    card: r.card ? (JSON.parse(String(r.card)) as Card) : null,
    createdAt: Number(r.created_at),
  };
}
