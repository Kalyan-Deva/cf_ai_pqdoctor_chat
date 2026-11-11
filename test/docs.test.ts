// Docs RAG: retrieval + reranking, routing, the docs fact check, and the chunker. Uses the real
// chunks the index was built from (docs/chunks.json) and vector/rerank scores measured against the
// real Vectorize index and reranker on 2026-11-10, with Workers AI and Vectorize replaced by fakes.

import { describe, expect, it } from "vitest";
import chunks from "../docs/chunks.json";
import { chunkPage, type DocChunk } from "../src/chunk";
import { CANDIDATES, EMBED_MODEL, IDK, RERANK_MODEL, checkDocsAnswer, citedSources, docsMessages, numbersIn, retrieve, route } from "../src/docs";

const all = chunks as DocChunk[];
const byId = (id: string) => {
  const c = all.find((x) => x.id === id);
  if (!c) throw new Error(`no chunk ${id}`);
  return c;
};

/**
 * Fakes for Workers AI + Vectorize. `hits` = [chunk id, vector score, rerank score], in the order
 * Vectorize returns them; the fake reranker returns those rerank scores (or fails if rerank is null).
 */
function fakes(hits: Array<[string, number, number | null]>) {
  const calls: string[] = [];
  const ai = {
    run: async (model: string, input: Record<string, unknown>) => {
      calls.push(model);
      if (model === EMBED_MODEL) return { data: [new Array(768).fill(0.01)] };
      if (model === RERANK_MODEL) {
        if (hits.some(([, , r]) => r === null)) throw new Error("reranker down");
        expect((input.contexts as unknown[]).length).toBe(hits.length);
        return { response: hits.map(([, , r], id) => ({ id, score: r })) };
      }
      throw new Error(`unexpected model ${model}`);
    },
  };
  const index = {
    query: async (_v: number[], opts: { topK: number }) => {
      expect(opts.topK).toBe(CANDIDATES);
      return { matches: hits.map(([id, score]) => ({ id, score, metadata: { ...byId(id) } as Record<string, unknown> })) };
    },
  };
  return { ai, index, calls };
}

describe('"how many ClientHellos does pqdoctor send?" (the docs say seven)', () => {
  const question = "how many ClientHellos does pqdoctor send?";
  // Measured: Vectorize's order and the reranker's scores for this question.
  const hits: Array<[string, number, number]> = [
    ["pqdoctor-how-it-works#_top~0", 0.819, 1.0],
    ["pqdoctor-reference-probes#group-survey~0", 0.797, 0.98],
    ["resources-faq#scanning-safely~0", 0.78, 0.984],
    ["pqdoctor-reference-probes#the-seven-clienthellos~0", 0.79, 0.998],
    ["pqdoctor-reference-probes#the-seven-clienthellos~1", 0.78, 0.996],
    ["pqdoctor#_top~0", 0.773, 0.994],
  ];

  it("retrieves, reranks and keeps the top 4, each with its page and section title", async () => {
    const { ai, index, calls } = fakes(hits);
    const docs = await retrieve(ai, index, question);
    expect(calls).toEqual([EMBED_MODEL, RERANK_MODEL]);
    expect(docs.map((d) => [d.n, `${d.page}: ${d.section}`])).toEqual([
      [1, "How it works: Overview"],
      [2, "Probes and wire format: The seven ClientHellos"],
      [3, "Probes and wire format: The seven ClientHellos"],
      [4, "pqdoctor: Overview"],
    ]);
    expect(docs[0].url).toBe("https://pqdoctor.com/pqdoctor/how-it-works/");
    expect(docs[0].text).toMatch(/sends seven ClientHellos/);
    expect(route(question, docs)).toBe("docs");
  });

  it("accepts the right answer, in words or digits, and cites the section", async () => {
    const { ai, index } = fakes(hits);
    const docs = await retrieve(ai, index, question);
    expect(checkDocsAnswer("pqdoctor sends seven hand-built ClientHellos and reads only the first reply to each [1].", docs, question)).toBeNull();
    expect(checkDocsAnswer("It sends 7 ClientHellos [2].", docs, question)).toBeNull();
    expect(citedSources("It sends 7 ClientHellos [2].", docs).map((s) => s.section)).toEqual(["The seven ClientHellos"]);
  });

  it("rejects a wrong count, an uncited answer, and a citation to a section that wasn't retrieved", async () => {
    const { ai, index } = fakes(hits);
    const docs = await retrieve(ai, index, question);
    expect(checkDocsAnswer("pqdoctor sends nine ClientHellos [1].", docs, question)).toMatch(/number 9/);
    expect(checkDocsAnswer("pqdoctor sends 12 ClientHellos [1].", docs, question)).toMatch(/number 12/);
    expect(checkDocsAnswer("pqdoctor sends seven ClientHellos.", docs, question)).toMatch(/didn't cite/);
    expect(checkDocsAnswer("pqdoctor sends seven ClientHellos [6].", docs, question)).toMatch(/wasn't retrieved/);
  });

  it("puts the sections in a quoted <docs> block and tells the model to answer only from them", async () => {
    const { ai, index } = fakes(hits);
    const docs = await retrieve(ai, index, question);
    const msgs = docsMessages(question, docs);
    const system = msgs[0];
    const user = msgs[msgs.length - 1];
    expect(system.content).toMatch(/using only its documentation/);
    expect(system.content).toContain(IDK);
    expect(user.content.match(/<docs>/g)).toHaveLength(1);
    expect(user.content).toContain('"section": "How it works: Overview"');
    expect(user.content.trimEnd().endsWith(`Question: ${question}`)).toBe(true);
  });

  it("falls back to Vectorize's order if the reranker fails", async () => {
    const { ai, index } = fakes(hits.map(([id, v]) => [id, v, null]));
    const docs = await retrieve(ai, index, question);
    expect(docs[0]).toMatchObject({ section: "Overview", rerank: null });
    expect(route(question, docs)).toBe("docs"); // vector 0.819 >= MIN_SCORE
  });
});

describe("questions the docs don't cover", () => {
  it('"what is pqdoctor\'s enterprise pricing?" is "I don\'t know" without a model call', async () => {
    const question = "what is pqdoctor's enterprise pricing?";
    // Measured: high vector scores ("pqdoctor" matches) but the reranker sees no answer (best 0.045).
    const { ai, index } = fakes([
      ["resources-faq#for-organizations~0", 0.744, 0.033],
      ["resources-faq#for-organizations~2", 0.728, 0.045],
      ["resources-faq#for-organizations~1", 0.725, 0.025],
      ["resources-faq#licence-and-support~0", 0.718, 0.04],
    ]);
    const docs = await retrieve(ai, index, question);
    expect(route(question, docs)).toBe("idk");
    expect(docs.map((d) => d.text).join(" ")).not.toMatch(/\$\d|pricing/i);
  });

  it("if a model is asked anyway, an invented price or product is rejected", async () => {
    const question = "what is pqdoctor's enterprise pricing?";
    const { ai, index } = fakes([["resources-faq#for-organizations~0", 0.744, 0.033], ["resources-faq#licence-and-support~0", 0.718, 0.04]]);
    const docs = await retrieve(ai, index, question);
    expect(checkDocsAnswer(IDK, docs, question)).toBeNull();
    expect(checkDocsAnswer("Enterprise plans cost $499 a year [1].", docs, question)).toMatch(/number 499/);
    expect(checkDocsAnswer("Enterprise support is included with Chrome deployments [1].", docs, question)).toMatch(/chrome/);
  });

  it('"who is the CEO of pqdoctor?" (measured best rerank 0.048) is "I don\'t know"', async () => {
    const { ai, index } = fakes([["resources-faq#for-organizations~1", 0.719, 0.048], ["pqdoctor-reference-cli#_top~0", 0.713, 0.01]]);
    expect(route("who is the CEO of pqdoctor?", await retrieve(ai, index, "who is the CEO of pqdoctor?"))).toBe("idk");
  });

  it("an unrelated question goes to the general answer, not the docs", async () => {
    const { ai, index } = fakes([["resources-glossary#_top~0", 0.441, 0.001], ["pqdoctor#guides~0", 0.44, 0.001]]);
    expect(route("what is the capital of France?", await retrieve(ai, index, "what is the capital of France?"))).toBe("general");
  });
});

describe("numbersIn", () => {
  it("reads digits, words and hex, and ignores citations and digits inside names", () => {
    expect([...numbersIn("seven probes, 120 ms apart [2], codepoint 0x11EC, over TLS 1.3")].sort()).toEqual(["1.3", "120", "4588", "7"]);
    expect([...numbersIn("X25519MLKEM768 and ML-KEM-768")]).toEqual([]);
    // Found live: "TLS 1.2-only" was read as "1" and a correct answer was rejected.
    expect([...numbersIn("a TLS 1.2-only server")]).toEqual(["1.2"]);
    expect([...numbersIn("nginx 1.25.3, then 2,048 bits")].sort()).toEqual(["1.25.3", "2048"]);
  });
});

describe("chunkPage", () => {
  const html = `<html><head><meta name="description" content="Seven hand-made ClientHellos."><style>.sl-markdown-content{color:red}</style></head><body>
    <h1 id="_top">How it works</h1>
    <div class="sl-markdown-content"><p>pqdoctor sends seven ClientHellos it builds by hand and reads only the first reply.</p>
    <div class="sl-heading-wrapper level-h2"><h2 id="the-seven-probes">The seven probes</h2><a class="sl-anchor-link" href="#the-seven-probes"><span>Section titled</span></a></div>
    <table><tr><th>#</th><th>Probe</th></tr><tr><td>1</td><td>TLS 1.3 with classical groups</td></tr><tr><td>2</td><td>Offer only an X25519MLKEM768 key share</td></tr></table>
    <h2 id="empty">Empty</h2>
    </div><footer>Edit page</footer></body></html>`;
  const out = chunkPage(html, "/pqdoctor/how-it-works/");

  it("makes one chunk per section: page and section title, the page summary, then the text", () => {
    expect(out.map((c) => [c.id, c.section, c.url])).toEqual([
      ["pqdoctor-how-it-works#_top~0", "Overview", "https://pqdoctor.com/pqdoctor/how-it-works/"],
      ["pqdoctor-how-it-works#the-seven-probes~0", "The seven probes", "https://pqdoctor.com/pqdoctor/how-it-works/#the-seven-probes"],
    ]);
    expect(out[1].text).toBe("How it works: The seven probes\n(Seven hand-made ClientHellos.)\n# | Probe\n1 | TLS 1.3 with classical groups\n2 | Offer only an X25519MLKEM768 key share");
  });

  it("skips CSS, anchor links, footers and empty sections", () => {
    const text = out.map((c) => c.text).join("\n");
    expect(text).not.toMatch(/color:red|Section titled|Edit page|Empty/);
  });

  it("the real index: every chunk has a title line and a pqdoctor.com link, and none is too long", () => {
    expect(all.length).toBeGreaterThan(100);
    for (const c of all) {
      expect(c.text.startsWith(`${c.page}: ${c.section}\n`)).toBe(true);
      expect(c.url.startsWith("https://pqdoctor.com/")).toBe(true);
      expect(c.text.length).toBeLessThanOrEqual(1900); // MAX_CHUNK_CHARS plus the title and summary lines
    }
  });
});
