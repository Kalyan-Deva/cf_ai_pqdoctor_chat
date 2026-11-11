import { describe, expect, it } from "vitest";
import { checkReply, lastSentenceEnd, sseTokens } from "../src/explain";

/** A Workers AI-style SSE stream, split into awkward chunks (mid-line, mid-JSON). */
function sse(tokens: string[], chunkSize = 7): ReadableStream<Uint8Array> {
  const text = tokens.map((t) => `data: ${JSON.stringify({ response: t })}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}

describe("sseTokens", () => {
  it("reassembles tokens across chunk boundaries and stops at [DONE]", async () => {
    const out: string[] = [];
    for await (const t of sseTokens(sse(["X25519", "MLKEM768 ", "is a hybrid", " group. ", "Done."]))) out.push(t);
    expect(out.join("")).toBe("X25519MLKEM768 is a hybrid group. Done.");
  });
});

describe("lastSentenceEnd", () => {
  it("cuts after the last finished sentence only", () => {
    expect(lastSentenceEnd("One. Two")).toBe(4);
    expect(lastSentenceEnd("Use OpenSSL 3.5 or")).toBe(0); // "3.5" isn't a sentence end
    expect(lastSentenceEnd("Line one\nline two")).toBe(9);
  });
});

describe("streaming never shows an unchecked verdict", () => {
  // Simulates the gate in UserMemory.reply(): release text only up to the last full sentence, and
  // only if checkReply approves everything released so far.
  async function gate(tokens: string[]) {
    const known = [{ host: "github.com", verdict: "notPq" }];
    let full = "";
    let shown = "";
    for await (const t of sseTokens(sse(tokens))) {
      full += t;
      const ready = full.slice(0, lastSentenceEnd(full));
      if (ready.length > shown.length) {
        if (checkReply(ready, known)) return { shown, blocked: true };
        shown = ready;
      }
    }
    return { shown, blocked: !!checkReply(full, known) };
  }

  it("stops before the sentence that invents a verdict", async () => {
    const r = await gate(["ML-KEM is a lattice KEM. ", "Also, evil", "corp.io is post", "-quantum. ", "Bye."]);
    expect(r).toEqual({ shown: "ML-KEM is a lattice KEM.", blocked: true });
  });

  it("streams a faithful answer through", async () => {
    const r = await gate(["pqdoctor found github.com is not ", "post-quantum. ", "Check it again any time."]);
    expect(r.blocked).toBe(false);
    expect(r.shown).toBe("pqdoctor found github.com is not post-quantum.");
  });
});
