// pqdoctor Chat UI. Plain DOM, no framework. Every server string goes in through textContent.

const $ = (s) => document.querySelector(s);
const log = $("#log");
const input = $("#input");
const send = $("#send");
let lastId = 0;
let domains = [];
let pollTimer = null;
let busy = false;

const TONES = { pq: "good", pqWithWarning: "warn", mixed: "warn", notPq: "bad", noTls13: "bad", broken: "bad", unreachable: "info", "cloudflare-edge": "good" };

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

/** Tiny, safe Markdown: ``` fences, paragraphs, `code` and **bold**. */
function rich(text) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      frag.append(el("pre", {}, el("code", {}, part.replace(/\n$/, ""))));
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      const t = para.trim();
      if (!t) continue;
      const p = el("p");
      for (const [j, seg] of t.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).entries()) {
        if (j % 2 === 0) {
          seg.split("\n").forEach((line, k) => {
            if (k) p.append(el("br"));
            p.append(line);
          });
        } else if (seg.startsWith("`")) p.append(el("code", {}, seg.slice(1, -1)));
        else p.append(el("strong", {}, seg.slice(2, -2)));
      }
      frag.append(p);
    }
  });
  return frag;
}

const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function card(msg) {
  const c = msg.card;
  const tone = TONES[c.verdict] ?? "info";
  const head = el(
    "div",
    { class: "card-head" },
    el("span", { class: "host" }, c.host),
    el("span", { class: `pill ${tone}` }, c.verdictLabel),
    c.recheck ? el("span", { class: "pill info" }, "re-check") : null,
    c.fromMemory ? el("span", { class: "pill info", title: "Answered from your Durable Object: no new check, no model call" }, "from memory") : null,
    c.cached && !c.fromMemory ? el("span", { class: "pill info", title: "pqdoctor checked this domain in the last 10 minutes, so its result was reused" }, "cached") : null,
    el("span", { class: "when" }, when(c.checkedAt)),
  );

  const facts = el("div", { class: "card-section engine-facts" }, el("div", { class: "label" }, "pqdoctor engine"), el("strong", {}, c.headline), c.cause ? el("div", {}, c.cause) : null);
  for (const w of c.warnings ?? []) facts.append(el("div", { class: "rejected" }, `Warning: ${w}`));
  if (c.certificate) facts.append(el("div", { class: "muted small" }, `Certificate: ${c.certificate}`));

  const explainedBy = c.explainedBy === "llm" ? "Llama 3.3, checked against the engine" : "engine's own words";
  const words = el("div", { class: "card-section" }, el("div", { class: "label" }, "In plain words", el("span", { class: "src" }, explainedBy)), rich(msg.text));
  if (c.rejected) words.append(el("div", { class: "rejected" }, `Llama's answer was not used: ${c.rejected}.`));

  const parts = [head, facts, words];
  if (c.fixes?.length || c.verify) {
    const det = el("details", {}, el("summary", {}, `pqdoctor's fixes (${c.fixes.length})${c.verify ? " and how to verify" : ""}`));
    for (const f of c.fixes) det.append(el("div", { class: "fix" }, el("div", { class: "fix-title" }, f.title), el("div", {}, f.detail), f.snippet ? el("pre", {}, el("code", {}, f.snippet)) : null));
    if (c.verify) det.append(el("div", { class: "fix" }, el("div", { class: "fix-title" }, "Verify it yourself"), el("pre", {}, el("code", {}, c.verify))));
    parts.push(el("div", { class: "card-section" }, det));
  }
  return el("div", { class: "msg assistant", "data-id": msg.id }, el("div", { class: "bubble card" }, ...parts));
}

function render(msg) {
  if (msg.card) return card(msg);
  const pending = /^Checking (\S+) with pqdoctor/.exec(msg.text);
  const bubble = el("div", { class: "bubble" }, rich(msg.text));
  if (msg.sources?.length) bubble.append(sourceList(msg.sources));
  const node = el("div", { class: `msg ${msg.role}`, "data-id": msg.id }, bubble);
  if (pending) node.dataset.pending = pending[1];
  return node;
}

/** "Sources: [1] How it works: The seven probes" with links, only ever to pqdoctor.com. */
function sourceList(sources) {
  const list = el("ol");
  for (const s of sources) {
    const label = `${s.page}: ${s.section}`;
    const safe = typeof s.url === "string" && s.url.startsWith("https://pqdoctor.com/");
    const item = el("li", { value: String(s.n) }, safe ? el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, label) : label);
    list.append(item);
  }
  return el("div", { class: "sources" }, el("div", { class: "label" }, "From the pqdoctor docs"), list);
}

function scrollDown() {
  log.scrollTop = log.scrollHeight;
}

function applyState(s) {
  if (s.messages.length) $("#empty")?.remove();
  for (const m of s.messages) {
    if (m.id <= lastId) continue;
    log.append(render(m));
    lastId = m.id;
  }
  domains = s.domains;
  const checking = new Set(domains.filter((d) => d.status === "checking").map((d) => d.host));
  for (const n of log.querySelectorAll("[data-pending]")) n.classList.toggle("pending", checking.has(n.dataset.pending));

  const stack = $("#stack");
  stack.replaceChildren();
  if (s.stack.length) s.stack.forEach((t) => stack.append(el("span", { class: "tag" }, t)));
  else stack.append("Not set. Mention it (\"we run nginx\").");

  const list = $("#domains");
  list.replaceChildren();
  if (!domains.length) list.append(el("li", { class: "muted" }, "None yet."));
  for (const d of domains) {
    const label = d.status === "checking" ? "checking…" : d.status === "error" ? "couldn't check" : (d.lastVerdict ?? "");
    const tone = d.status === "watching" || d.status === "checked" ? (TONES[d.lastVerdict] ?? "info") : d.status === "error" ? "bad" : "info";
    const meta = [];
    if (d.lastChecked) meta.push(`checked ${day(d.lastChecked)}`);
    if (d.recheckAt) meta.push(`re-check ${day(d.recheckAt)}`);
    list.append(el("li", {}, el("div", { class: "d-host" }, d.host, el("span", { class: `pill ${tone}` }, prettyVerdict(label))), meta.length ? el("div", { class: "d-meta" }, meta.join(" · ")) : null));
  }
  $("#limits").textContent = `${s.limits.checksLeft} of ${s.limits.checksPerHour} checks left this hour.`;
  scrollDown();
  schedule(checking.size > 0);
}

function prettyVerdict(v) {
  return { pq: "PQ", pqWithWarning: "PQ, warning", mixed: "mixed", notPq: "not PQ", noTls13: "no TLS 1.3", broken: "broken", unreachable: "unreachable", "cloudflare-edge": "PQ edge" }[v] ?? v;
}

function schedule(fast) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, fast ? 1500 : 20000);
}

async function refresh() {
  try {
    const res = await fetch(`/api/state?since=${lastId}`);
    if (res.ok) return applyState(await res.json());
  } catch {
    // offline: try again later
  }
  schedule(false);
}

async function say(text) {
  if (busy || !text.trim()) return;
  busy = true;
  send.disabled = true;
  $("#empty")?.remove();
  const temp = el("div", { class: "msg user" }, el("div", { class: "bubble" }, text));
  log.append(temp);
  scrollDown();
  input.value = "";
  autosize();
  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text }) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      temp.remove();
      log.append(render({ id: -1, role: "notice", text: body.error ?? `Error ${res.status}` }));
      scrollDown();
      return;
    }
    // NDJSON: {"type":"state"} snapshots, {"type":"delta"} streamed reply text, {"type":"replace"}.
    let live = null;
    let liveText = "";
    const showLive = () => {
      if (!live) {
        live = el("div", { class: "msg assistant streaming" }, el("div", { class: "bubble" }));
        log.append(live);
      }
      live.firstChild.replaceChildren(rich(liveText));
      scrollDown();
    };
    const handle = (ev) => {
      if (ev.type === "state") {
        temp.remove();
        if (live && ev.state.messages.some((m) => m.role === "assistant" || m.role === "notice")) {
          live.remove();
          live = null;
        }
        applyState(ev.state);
      } else if (ev.type === "delta") {
        liveText += ev.text;
        showLive();
      } else if (ev.type === "replace") {
        liveText = ev.text;
        showLive();
      }
    };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handle(JSON.parse(line));
      }
    }
    temp.remove();
    live?.remove();
  } catch {
    temp.remove();
    log.append(render({ id: -1, role: "notice", text: "Couldn't reach the server. Check your connection and try again." }));
  } finally {
    busy = false;
    send.disabled = false;
    input.focus();
  }
}

function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  say(input.value);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    say(input.value);
  }
});
input.addEventListener("input", autosize);
log.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-say]");
  if (chip) say(chip.dataset.say);
});
$("#memory-toggle").addEventListener("click", () => {
  const open = $("#memory").classList.toggle("open");
  $("#memory-toggle").setAttribute("aria-expanded", String(open));
});
$("#forget").addEventListener("click", async () => {
  if (!confirm("Delete your chat history, stack and all checked domains? Pending re-checks are cancelled.")) return;
  await fetch("/api/forget", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  location.reload();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

// Shareable prompts: /?q=check+google.com sends that message once the history has loaded, then
// drops ?q from the address bar so a reload doesn't send it again.
const linked = new URLSearchParams(location.search).get("q");
if (linked) history.replaceState(null, "", location.pathname);
refresh().then(() => {
  if (linked && linked.trim()) say(linked.trim().slice(0, 600));
});
