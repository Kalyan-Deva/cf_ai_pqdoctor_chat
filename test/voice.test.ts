import { describe, expect, it } from "vitest";
import { MAX_AUDIO_BYTES, STT_MODEL, checkAudio, normalizeTranscript, transcribe } from "../src/voice";

describe("checkAudio", () => {
  it("accepts the formats browsers record", () => {
    for (const t of ["audio/webm", "audio/webm;codecs=opus", "audio/ogg", "audio/mp4", "audio/wav"]) expect(checkAudio(t, 1000)).toBeNull();
  });
  it("refuses anything else, empty bodies and long recordings", () => {
    expect(checkAudio("text/plain", 1000)?.status).toBe(415);
    expect(checkAudio("application/json", 1000)?.status).toBe(415);
    expect(checkAudio(null, 1000)?.status).toBe(415);
    expect(checkAudio("audio/webmx", 1000)?.status).toBe(415);
    expect(checkAudio("audio/webm", 0)?.status).toBe(400);
    expect(checkAudio("audio/webm", MAX_AUDIO_BYTES + 1)?.status).toBe(413);
  });
});

describe("normalizeTranscript", () => {
  it("turns spoken domains into domains", () => {
    expect(normalizeTranscript("is github dot com post-quantum?")).toBe("is github.com post-quantum?");
    expect(normalizeTranscript("check www dot example dot org please")).toBe("check www.example.org please");
    expect(normalizeTranscript("Is github. com post-quantum?")).toBe("Is github.com post-quantum?");
  });
  it("leaves ordinary sentences alone and caps the length", () => {
    expect(normalizeTranscript("  How many   ClientHellos does pqdoctor send? ")).toBe("How many ClientHellos does pqdoctor send?");
    expect(normalizeTranscript("a".repeat(900))).toHaveLength(600);
  });
});

describe("transcribe", () => {
  it("sends base64 audio to Whisper with the app's vocabulary, and cleans the text", async () => {
    const seen: Array<{ model: string; input: Record<string, unknown> }> = [];
    const ai = {
      run: async (model: string, input: Record<string, unknown>) => {
        seen.push({ model, input });
        return { text: " Is github dot com post quantum? We run nginx. " };
      },
    };
    const audio = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(await transcribe(ai, audio)).toBe("Is github.com post quantum? We run nginx.");
    expect(seen[0].model).toBe(STT_MODEL);
    expect(seen[0].input.audio).toBe(btoa(String.fromCharCode(...audio)));
    expect(seen[0].input).toMatchObject({ task: "transcribe", language: "en", vad_filter: true });
    expect(String(seen[0].input.initial_prompt)).toContain("pqdoctor");
  });

  it("encodes large recordings without overflowing the call stack", async () => {
    const big = new Uint8Array(1_500_000).map((_, i) => i % 256);
    let sent = "";
    await transcribe({ run: async (_m, input) => ((sent = String(input.audio)), { text: "ok" }) }, big);
    expect(sent.length).toBe(Math.ceil(big.length / 3) * 4);
  });

  it("returns empty text when nothing was said", async () => {
    expect(await transcribe({ run: async () => ({ text: "" }) }, new Uint8Array([1]))).toBe("");
    expect(await transcribe({ run: async () => ({}) }, new Uint8Array([1]))).toBe("");
  });
});
