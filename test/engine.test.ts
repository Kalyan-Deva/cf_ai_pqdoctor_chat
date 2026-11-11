import { describe, expect, it } from "vitest";
import github from "./fixtures/github.json";
import nginxOrg from "./fixtures/nginx-org.json";
import google from "./fixtures/google.json";
import cloudflare from "./fixtures/cloudflare.json";
import { EngineError, httpEngine, normalise } from "../src/engine";

const FIXTURES: Record<string, unknown> = { github, "nginx-org": nginxOrg, google, cloudflare };
const fixture = (name: string) => FIXTURES[name];

describe("normalise (real pqdoctor.com answers, saved 2026-11-10)", () => {
  it("not post-quantum: github.com", () => {
    const r = normalise(fixture("github"), 200);
    expect(r).toMatchObject({ kind: "report", host: "github.com", verdict: "notPq", causeCode: "no-mlkem", group: null });
    expect(r.fixes.map((f) => f.title)).toContain("Upgrade the TLS library under the server");
    expect(r.certificate).toBe("No ML-DSA certificate");
  });
  it("TLS 1.2 only: nginx.org", () => {
    expect(normalise(fixture("nginx-org"), 200)).toMatchObject({ verdict: "noTls13", causeCode: "tls12-only" });
  });
  it("post-quantum: google.com", () => {
    const r = normalise(fixture("google"), 200);
    expect(r).toMatchObject({ verdict: "pq", group: "X25519MLKEM768" });
  });
  it("on Cloudflare's edge: cloudflare.com", () => {
    expect(normalise(fixture("cloudflare"), 200)).toMatchObject({ kind: "cloudflare", verdict: "cloudflare-edge", fixes: [] });
  });
});

describe("errors", () => {
  it("4xx refusals aren't retryable, 429 and 5xx are", () => {
    const err = (body: unknown, status: number) => {
      try {
        normalise(body, status);
      } catch (e) {
        return e as EngineError;
      }
      throw new Error("expected a throw");
    };
    expect(err({ error: "Enter a public hostname" }, 400)).toMatchObject({ retryable: false, message: "Enter a public hostname" });
    expect(err({ error: "Too many" }, 429).retryable).toBe(true);
    expect(err(null, 502).retryable).toBe(true);
    expect(err({ kind: "mystery" }, 200).retryable).toBe(false);
  });

  it("httpEngine calls one URL and turns a network failure into a retryable error", async () => {
    const seen: string[] = [];
    const ok = httpEngine("https://engine.test/api/check", async (url) => {
      seen.push(url);
      return new Response(JSON.stringify(fixture("github")));
    });
    expect((await ok.check("github.com")).verdict).toBe("notPq");
    expect(seen).toEqual(["https://engine.test/api/check?host=github.com"]);

    const down = httpEngine("https://engine.test/api/check", async () => {
      throw new Error("connection reset");
    });
    await expect(down.check("github.com")).rejects.toMatchObject({ retryable: true });
  });
});
