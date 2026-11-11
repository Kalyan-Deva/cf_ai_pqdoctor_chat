// Worker entry: the chat API in front of each user's Durable Object. Static files (the chat UI)
// are served from public/ by the assets binding; only /api/* reaches this code.
//
//   GET  /api/state?since=<id>   messages after <id>, the user's stack and watched domains
//   POST /api/chat {message}     send a message; streams NDJSON events back
//   POST /api/transcribe <audio>  speech to text (Whisper); returns {text} for the message box
//   POST /api/forget             delete everything this app remembers about you

import { MAX_MESSAGE, type UserMemory } from "./memory";
import { checkAudio, transcribe } from "./voice";

export { UserMemory } from "./memory";
export { CheckWorkflow } from "./workflow";
export { DomainCache } from "./cache";

const COOKIE = "pqchat_uid";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/** The user is an anonymous random id in an HttpOnly cookie, made on first visit. */
function userFrom(req: Request): { id: string; fresh: boolean } {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{32})(?:;|$)`).exec(req.headers.get("cookie") ?? "");
  if (m) return { id: m[1], fresh: false };
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return { id: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""), fresh: true };
}

function cookieHeader(id: string, url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`;
}

/** Writes must be same-origin JSON (blocks form posts and cross-site requests). */
function sameOriginJson(req: Request, url: URL): boolean {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return false;
  const origin = req.headers.get("origin");
  return origin === null || origin === url.origin;
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    const user = userFrom(req);
    const extra: Record<string, string> = user.fresh ? { "set-cookie": cookieHeader(user.id, url) } : {};
    const memory = (env.USER as DurableObjectNamespace<UserMemory>).getByName(user.id);
    const ip = req.headers.get("cf-connecting-ip") ?? "local";

    if (url.pathname === "/api/state" && req.method === "GET") {
      // No cookie yet: nothing to remember, so don't create a Durable Object for a read.
      if (user.fresh) {
        const perHour = Number(env.CHECKS_PER_HOUR) || 10;
        return json({ messages: [], stack: [], domains: [], limits: { checksPerHour: perHour, checksLeft: perHour } }, 200, extra);
      }
      const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
      return json(await memory.state(since), 200, extra);
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      if (!sameOriginJson(req, url)) return json({ error: "Send JSON from this site." }, 403);
      const { success } = await env.IP_LIMIT.limit({ key: ip });
      if (!success) return json({ error: "Too many messages from your network. Try again in a minute." }, 429, { "retry-after": "60", ...extra });
      let body: { message?: unknown; since?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Body must be JSON." }, 400);
      }
      if (typeof body.message !== "string") return json({ error: "message must be a string." }, 400);
      if (body.message.length > MAX_MESSAGE * 4) return json({ error: "Message too long." }, 413);
      // Streamed: one JSON event per line (state snapshots, reply text as it's approved).
      return new Response(await memory.chat(user.id, body.message, ip), {
        headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
      });
    }

    if (url.pathname === "/api/transcribe" && req.method === "POST") {
      // Same origin only (an audio/* body can't be sent cross-site without a preflight we don't answer).
      const origin = req.headers.get("origin");
      if (origin !== null && origin !== url.origin) return json({ error: "Send audio from this site." }, 403);
      const declared = Number(req.headers.get("content-length") ?? 0);
      const early = checkAudio(req.headers.get("content-type"), declared || 1);
      if (early) return json({ error: early.error }, early.status);
      if (!(await env.IP_LIMIT.limit({ key: ip })).success) return json({ error: "Too many requests. Try again in a minute." }, 429, { "retry-after": "60" });
      const audio = new Uint8Array(await req.arrayBuffer());
      const bad = checkAudio(req.headers.get("content-type"), audio.byteLength);
      if (bad) return json({ error: bad.error }, bad.status);
      try {
        const text = await transcribe(env.AI, audio);
        return json(text ? { text } : { text: "", error: "I didn't catch anything. Try again a little closer to the mic." }, 200, extra);
      } catch {
        return json({ error: "Couldn't transcribe that. Try again, or type it." }, 502);
      }
    }

    if (url.pathname === "/api/forget" && req.method === "POST") {
      if (!sameOriginJson(req, url)) return json({ error: "Send JSON from this site." }, 403);
      if (user.fresh) return json({ ok: true }, 200, extra); // nothing stored for a new visitor
      if (!(await env.IP_LIMIT.limit({ key: ip })).success) return json({ error: "Too many requests. Try again in a minute." }, 429, { "retry-after": "60" });
      await memory.forget();
      return json({ ok: true }, 200, extra);
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
