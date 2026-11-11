// Voice input: speech to text on Workers AI (Whisper large-v3-turbo), so the audio stays on
// Cloudflare. The transcript goes back to the page and into the message box; it is NOT sent as a
// message, because a misheard domain would start a real check. The user reads it and sends it.
// Audio is never stored.

export const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
/** About a minute of Opus; the page stops recording at 30 s. */
export const MAX_AUDIO_BYTES = 2_000_000;
const AUDIO_TYPES = /^audio\/(?:webm|ogg|mp4|mpeg|mp3|wav|x-wav|wave|aac|x-m4a|flac)(?:;|$)/i;

/** Words Whisper should expect, so "pqdoctor" and group names come out spelled right. */
const VOCABULARY =
  "pqdoctor, post-quantum, TLS 1.3, X25519MLKEM768, ML-KEM, ML-DSA, ClientHello, HelloRetryRequest, nginx, Apache, Caddy, HAProxy, Cloudflare, OpenSSL, github.com, example.com.";

/** Is this an acceptable upload? Returns null if so, or the reason (and HTTP status) if not. */
export function checkAudio(contentType: string | null, bytes: number): { status: number; error: string } | null {
  if (!contentType || !AUDIO_TYPES.test(contentType)) return { status: 415, error: "Send audio (webm, ogg, mp4, wav)." };
  if (bytes === 0) return { status: 400, error: "No audio." };
  if (bytes > MAX_AUDIO_BYTES) return { status: 413, error: "That recording is too long. Keep it under 30 seconds." };
  return null;
}

/**
 * Clean a transcript for the message box: spoken domains become domains ("github dot com" ->
 * github.com), whitespace collapses, and it's capped at the chat's 600-character limit.
 */
export function normalizeTranscript(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\b([a-z0-9][a-z0-9-]*)\s+dot\s+(?=[a-z])/gi, "$1.") // "github dot com", "www dot example dot org"
    .replace(/\b([a-z0-9-]+)\s*\.\s+(com|org|net|io|dev|edu|gov|app|co|uk|me|ai)\b/gi, "$1.$2") // "github. com"
    .trim()
    .slice(0, 600);
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

type AiLike = { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };

/** Audio bytes to cleaned text ("" when nothing was said). */
export async function transcribe(ai: AiLike, audio: Uint8Array): Promise<string> {
  const out = (await ai.run(STT_MODEL, {
    audio: base64(audio),
    task: "transcribe",
    language: "en",
    vad_filter: true,
    initial_prompt: VOCABULARY,
    condition_on_previous_text: false,
  })) as { text?: unknown };
  return typeof out?.text === "string" ? normalizeTranscript(out.text) : "";
}
