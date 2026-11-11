// "The LLM explains, the engine decides": what Llama writes is checked against the engine JSON.

import { describe, expect, it } from "vitest";
import github from "./fixtures/github.json";
import nginxOrg from "./fixtures/nginx-org.json";
import google from "./fixtures/google.json";
import cloudflare from "./fixtures/cloudflare.json";
import { normalise } from "../src/engine";
import { checkExplanation, engineWords, explain, explainMessages } from "../src/explain";

const FIXTURES: Record<string, unknown> = { github, "nginx-org": nginxOrg, google, cloudflare };
const fixture = (name: string) => normalise(FIXTURES[name], 200);
const githubR = fixture("github"); // notPq, no-mlkem
const googleR = fixture("google"); // pq
const nginxOrgR = fixture("nginx-org"); // noTls13

describe("checkExplanation", () => {
  it("passes a faithful explanation adapted to nginx", () => {
    const text = `github.com is not post-quantum yet. It supports TLS 1.3, but when offered X25519MLKEM768 it falls back to X25519, so its TLS library lacks ML-KEM.

On nginx, upgrade to OpenSSL 3.5+ and list the hybrid group first:
\`\`\`
ssl_ecdh_curve X25519MLKEM768:X25519:prime256v1;
\`\`\``;
    expect(checkExplanation(text, githubR, ["nginx"])).toBeNull();
  });

  it("rejects a flipped verdict", () => {
    expect(checkExplanation("Good news: github.com is post-quantum and needs nothing.", githubR, [])).toMatch(/engine says it isn't/);
    expect(checkExplanation("google.com is not post-quantum, you should upgrade.", googleR, [])).toMatch(/engine says it is/);
  });

  it("rejects an invented version", () => {
    expect(checkExplanation("github.com is not post-quantum. Upgrade nginx to 1.27 to fix it.", githubR, ["nginx"])).toMatch(/1\.27/);
  });

  it("rejects an invented group", () => {
    expect(checkExplanation("github.com is not post-quantum. Enable SecP384r1MLKEM1024 on the server.", githubR, [])).toMatch(/SecP384r1MLKEM1024/i);
  });

  it("rejects a product that's neither in the engine's fixes nor the user's stack", () => {
    expect(checkExplanation("github.com is not post-quantum. Switch to wolfSSL to get ML-KEM.", githubR, [])).toMatch(/wolfssl/);
    // ...but the user's own stack is fine to name.
    expect(checkExplanation("github.com is not post-quantum. On your Traefik setup, upgrade the TLS library (OpenSSL 3.5+).", githubR, ["Traefik"])).toBeNull();
  });

  it("allows the TLS protocol version even when the engine text doesn't spell it", () => {
    expect(checkExplanation("google.com is post-quantum: over TLS 1.3 it negotiates X25519MLKEM768. Nothing to fix.", googleR, [])).toBeNull();
  });
});

describe("explain()", () => {
  const ai = (response: unknown) => ({ run: async () => ({ response }) });

  it("uses Llama's text when it passes", async () => {
    const text = "nginx.org is not post-quantum: it only speaks TLS 1.2, and hybrid ML-KEM needs TLS 1.3. Turn on TLS 1.3:\n```\nssl_protocols TLSv1.2 TLSv1.3;\n```";
    expect(await explain(ai(text), nginxOrgR, ["nginx"])).toEqual({ text, source: "llm" });
  });

  it("falls back to the engine's words when Llama strays", async () => {
    const r = await explain(ai("nginx.org is post-quantum ready, nothing to do!"), nginxOrgR, []);
    expect(r.source).toBe("engine");
    expect(r.text).toBe(engineWords(nginxOrgR));
    expect(r.text).toContain("Not post-quantum: TLS 1.2 only");
    expect(r.rejected).toBeTruthy();
  });

  it("falls back when Workers AI errors", async () => {
    const r = await explain({ run: async () => { throw new Error("capacity"); } }, githubR, []);
    expect(r).toMatchObject({ source: "engine", rejected: expect.stringContaining("capacity") });
  });

  it("sends the model only the engine's facts", () => {
    const [system, user] = explainMessages(githubR, ["nginx"]);
    expect(system.content).toMatch(/only source of truth/);
    const facts = JSON.parse(user.content.slice(user.content.indexOf("{"), user.content.lastIndexOf("}") + 1));
    expect(Object.keys(facts).sort()).toEqual(["cause", "certificate", "fixes", "headline", "host", "negotiatedGroup", "userStack", "verdict", "verdictInWords", "verifyCommand", "warnings"]);
    expect(facts.userStack).toEqual(["nginx"]);
  });
});
