// Re-index the pqdoctor docs into Vectorize. Run after the docs change:
//
//   npm run reindex             fetch pages, chunk, embed, upsert, delete stale chunks
//   npm run reindex -- --dry    fetch and chunk only (writes docs/chunks.json, touches nothing remote)
//
// Reads the PUBLISHED pages listed in docs/sources.json from pqdoctor.com, so only public text can
// end up in the index. Embeddings come from Workers AI (@cf/baai/bge-base-en-v1.5, 768 dimensions)
// using your current `wrangler login`; nothing is written to disk but the chunks and the manifest.
//
// First time only: npx wrangler vectorize create pqdoctor-docs --dimensions=768 --metric=cosine

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkPage, type DocChunk } from "../src/chunk.ts";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const root = new URL("..", import.meta.url);
const file = (p: string) => new URL(p, root);
const sources = JSON.parse(readFileSync(file("docs/sources.json"), "utf8")) as { origin: string; index: string; pages: string[] };
const dry = process.argv.includes("--dry");

function wrangler(args: string[], input?: string): string {
  // shell: true so Windows finds npx.cmd; arguments here are fixed or come from our own files.
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", shell: process.platform === "win32", input, stdio: ["pipe", "pipe", "inherit"] });
}

async function main() {
  // 1. Fetch and chunk.
  const chunks: DocChunk[] = [];
  for (const path of sources.pages) {
    const res = await fetch(`${sources.origin}${path}`, { headers: { "user-agent": "cf-ai-pqdoctor-chat-reindex" } });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const page = chunkPage(await res.text(), path, sources.origin);
    if (page.length === 0) throw new Error(`${path}: no content found (has the page layout changed?)`);
    chunks.push(...page);
    console.log(`${String(page.length).padStart(3)} chunks  ${path}`);
  }
  const ids = new Set<string>();
  for (const c of chunks) {
    if (ids.has(c.id)) throw new Error(`duplicate chunk id ${c.id}`);
    ids.add(c.id);
  }
  writeFileSync(file("docs/chunks.json"), JSON.stringify(chunks, null, 2) + "\n");
  console.log(`${chunks.length} chunks from ${sources.pages.length} pages -> docs/chunks.json`);
  if (dry) return;

  // 2. Embed with Workers AI, as the logged-in wrangler user.
  const { token } = JSON.parse(wrangler(["auth", "token", "--json"])) as { token: string };
  const who = JSON.parse(wrangler(["whoami", "--json"])) as { accounts: Array<{ id: string }> };
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? who.accounts[0]?.id;
  if (!account) throw new Error("no Cloudflare account: run `npx wrangler login`, or set CLOUDFLARE_ACCOUNT_ID");
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += 50) {
    const batch = chunks.slice(i, i + 50);
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${EMBED_MODEL}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: batch.map((c) => c.text) }),
    });
    const body = (await res.json()) as { success: boolean; result?: { data: number[][] }; errors?: unknown };
    if (!res.ok || !body.success || !body.result) throw new Error(`embedding failed: HTTP ${res.status} ${JSON.stringify(body.errors)}`);
    vectors.push(...body.result.data);
    console.log(`embedded ${Math.min(i + 50, chunks.length)}/${chunks.length}`);
  }

  // 3. Upsert (text and titles travel as metadata, so a query returns everything the answer needs).
  const dir = mkdtempSync(join(tmpdir(), "pqdoctor-reindex-"));
  try {
    const ndjson = chunks.map((c, i) => JSON.stringify({ id: c.id, values: vectors[i], metadata: { page: c.page, section: c.section, url: c.url, text: c.text } })).join("\n");
    const path = join(dir, "vectors.ndjson");
    writeFileSync(path, ndjson + "\n");
    console.log(wrangler(["vectorize", "upsert", sources.index, "--file", path]).trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 4. Delete chunks that no longer exist (a removed page or section).
  const manifest = file("docs/index-manifest.json");
  const before: string[] = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).ids : [];
  const stale = before.filter((id) => !ids.has(id));
  for (let i = 0; i < stale.length; i += 100) {
    console.log(wrangler(["vectorize", "delete-vectors", sources.index, "--ids", ...stale.slice(i, i + 100)]).trim());
  }
  writeFileSync(manifest, JSON.stringify({ index: sources.index, model: EMBED_MODEL, indexedAt: new Date().toISOString(), ids: [...ids].sort() }, null, 2) + "\n");
  console.log(`done: ${chunks.length} upserted, ${stale.length} stale deleted`);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
