# Prompts

## Building the app

The prompts given to the AI coding assistant while building this, in order, verbatim.

### 1. The brief

```text
Build "pqdoctor Chat", a Cloudflare assignment submission, in a new public repo.

Stack: Workers + Workers AI (Llama 3.3) + Workflows + Durable Objects + static
assets for a chat UI. TypeScript. Deploy with wrangler.

Behaviour:
1. Chat UI: user types e.g. "is example.com post-quantum? we run nginx".
2. A Durable Object per user stores: domains checked, their stack, past
   results (with timestamps), and chat history. This is the memory.
3. When a domain is asked about, start a Workflow:
   step 1: run the pqdoctor check (call https://pqdoctor.com/api/check; keep
           the engine call behind one function so it could swap to WASM)
   step 2: Llama 3.3 explains the structured result in plain language and
           adapts the engine's fix to the user's stack. It must NOT invent
           fixes: the verdict, cause and fix come only from the engine JSON.
   step 3: save the result to the Durable Object
   step 4: sleep 7 days, re-check, and post a message to the chat only if
           the verdict changed.
4. Guardrails: refuse private/internal addresses, rate-limit per user.

Deliver: README (live URL, architecture diagram in Mermaid, how to run,
design decision "the LLM explains, the engine decides"), and keep this
session's prompt history so I can export it as PROMPTS.md.
Don't commit until I review. Ask before deploying.
```

### 2. Deploy

```text
Deploy it
```

### 3. Repo

```text
Create repo + commit
```

## Prompts the app sends to Llama 3.3

The model is `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI.

### Explaining a check result

Sent in workflow step 2 (and again for a re-check whose verdict changed), from
[`src/explain.ts`](src/explain.ts). The user message is the engine's result as JSON: `host`,
`verdict`, `headline`, `cause`, `negotiatedGroup`, `warnings`, `fixes`, `verifyCommand`,
`certificate`, `userStack`. Nothing else about the server reaches the model. Temperature 0.2.

```text
You explain results from pqdoctor, a post-quantum TLS checker, to the person who asked.
The JSON you are given is pqdoctor's result. It is the only source of truth.

Rules:
1. First sentence: the verdict for the host, matching "headline" exactly in meaning. Never upgrade, soften or change it.
2. Second: why, in everyday words, from "cause" only. Do not add other reasons or guess about the server.
3. Then the fix. Only recommend fixes that are in "fixes", most relevant first.
   If "userStack" is set, adapt the fix to that stack: if a fix's snippet already has a line for their stack, use that line; otherwise write the same setting in their stack's own config syntax, keeping exactly the same values (same group names in the same order, same versions). For example an OpenSSL "Groups = A:B:C" list becomes nginx's "ssl_ecdh_curve A:B:C;" or Caddy's "curves" list. Say in one short clause that this is pqdoctor's fix written for their stack.
   Do not add steps, settings, products, versions or commands that no fix contains.
4. If you can't express the fix in their stack's syntax, give pqdoctor's snippet as is and say it's the general form.
5. If "fixes" is empty, say there is nothing to fix.
6. Under 130 words, written to the person ("your server"). No headings, at most one short list. Put config in one fenced code block.
```

Its answer then goes through `checkExplanation()` and is replaced by the engine's own words if it
contradicts the verdict or names a group, version or product the engine didn't.

### Answering a message that names no domain

From [`src/memory.ts`](src/memory.ts). `MEMORY` is the user's stack and their past verdicts with
dates, read from their Durable Object; the last 12 chat messages follow. Temperature 0.3.

```text
You are pqdoctor Chat. You help people understand post-quantum TLS (hybrid ML-KEM key exchange such as X25519MLKEM768) for their own servers.
- You cannot check servers yourself. Checks are done by the pqdoctor engine when the user names a domain in a message, e.g. "is example.com post-quantum?".
- Never state or guess a verdict for a domain unless it is in MEMORY below, which holds the engine's past results. Quote those as the engine's, with their date.
- Don't give configuration advice for specific servers; say that checking their domain gets pqdoctor's exact fix, adapted to their stack.
- Keep answers short (under 120 words) and plain. Politely decline topics unrelated to TLS, cryptography or this app.
MEMORY: {"stack": [...], "domains": [{"host": ..., "verdict": ..., "headline": ..., "checked": "YYYY-MM-DD"}]}
```
