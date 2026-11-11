// Guardrails: which names we're willing to check.
//
// Two layers, both before anything is sent to the engine:
//   1. The name itself: hostnames only, no IP literals, no single-label names, no reserved or
//      internal suffixes (localhost, .local, .internal, .home.arpa, ...).
//   2. What it resolves to: a DNS-over-HTTPS lookup, refused if any A/AAAA answer is private,
//      loopback, link-local, CGNAT, documentation, multicast or otherwise not public.
// The engine has the same rules on its side; this app doesn't rely on that.

export type HostCheck = { ok: true; host: string } | { ok: false; reason: string };

const RESERVED_SUFFIXES = [
  "localhost", "local", "localdomain", "internal", "intranet", "private", "corp", "home", "lan",
  "home.arpa", "arpa", "test", "invalid", "example", "onion", "alt",
];

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Clean up what a user typed ("https://Example.com/path", "example.com.") into a hostname, or refuse it. */
export function checkHostname(raw: string): HostCheck {
  let h = raw.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  h = h.replace(/[/?#].*$/, ""); // path, query, fragment
  h = h.replace(/^[^@]*@/, ""); // userinfo
  if (h.startsWith("[") || (h.match(/:/g) ?? []).length > 1) return { ok: false, reason: "IP addresses can't be checked here, only public hostnames." };
  const port = /:(\d+)$/.exec(h);
  if (port) {
    if (port[1] !== "443") return { ok: false, reason: "Only port 443 can be checked from chat." };
    h = h.slice(0, port.index);
  }
  h = h.replace(/\.$/, "");

  if (h.length === 0 || h.length > 253) return { ok: false, reason: "That isn't a hostname." };
  if (isIpv4Literal(h)) return { ok: false, reason: "IP addresses can't be checked here, only public hostnames." };
  const labels = h.split(".");
  if (labels.length < 2) return { ok: false, reason: `"${h}" is a single-label name, which only means something inside a private network.` };
  if (!labels.every((l) => LABEL.test(l))) return { ok: false, reason: `"${h}" isn't a valid hostname.` };
  const tld = labels[labels.length - 1];
  if (/^\d+$/.test(tld) || tld.startsWith("0x")) return { ok: false, reason: "IP addresses can't be checked here, only public hostnames." };
  for (const s of RESERVED_SUFFIXES) {
    if (h === s || h.endsWith(`.${s}`)) return { ok: false, reason: `"${h}" is a reserved or internal name (.${s}), not a public server.` };
  }
  return { ok: true, host: h };
}

function isIpv4Literal(h: string): boolean {
  // Dotted forms (1.2.3.4, 127.1) and integer/hex forms (2130706433, 0x7f000001).
  return /^[\d.]+$/.test(h) || /^0x[0-9a-f]+$/.test(h);
}

// ---------- address ranges ----------

/** IPv4 dotted quad to a 32-bit number, or null. */
export function parseIpv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** IPv6 text to eight 16-bit words, or null. Handles "::" and an embedded IPv4 tail. */
export function parseIpv6(s: string): number[] | null {
  let text = s.replace(/%.*$/, "");
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    // Rewrite the dotted tail as two hex words, then parse normally.
    const n = parseIpv4(v4[1]);
    if (n === null) return null;
    text = `${text.slice(0, v4.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const words = (p: string) => (p === "" ? [] : p.split(":").map((w) => (/^[0-9a-f]{1,4}$/i.test(w) ? parseInt(w, 16) : NaN)));
  const head = words(halves[0]);
  const rest = halves.length === 2 ? words(halves[1]) : [];
  const total = head.length + rest.length;
  if ([...head, ...rest].some(Number.isNaN)) return null;
  if (halves.length === 1 && total !== 8) return null;
  if (halves.length === 2 && total > 7) return null;
  return [...head, ...Array(8 - total).fill(0), ...rest];
}

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4Blocked(n: number): boolean {
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((parseIpv4(base)! & mask) >>> 0);
  });
}

/** True for any address that isn't a normal public unicast address. */
export function isNonPublicIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return v4Blocked(v4);
  const w = parseIpv6(ip);
  if (!w) return true; // unparseable: treat as unsafe
  const allZero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return true; // ::
  if (allZero(0, 7) && w[7] === 1) return true; // ::1
  if (allZero(0, 5) && w[5] === 0xffff) return v4Blocked(((w[6] << 16) | w[7]) >>> 0); // ::ffff:a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b && allZero(2, 6)) return v4Blocked(((w[6] << 16) | w[7]) >>> 0); // NAT64
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // documentation
  if (w[0] === 0x0100 && allZero(1, 4)) return true; // discard-only
  if (w[0] === 0x2002) return v4Blocked(((w[1] << 16) | w[2]) >>> 0); // 6to4
  return false;
}

// ---------- DNS ----------

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Resolve the name over DNS-over-HTTPS (1.1.1.1) and refuse it if any address isn't public.
 * A name that doesn't resolve is refused too (there's nothing to check).
 */
export async function checkResolves(host: string, fetcher: FetchLike = fetch): Promise<HostCheck> {
  const ask = async (type: "A" | "AAAA") => {
    const res = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`DNS lookup failed (HTTP ${res.status})`);
    const body = (await res.json()) as { Status: number; Answer?: Array<{ type: number; data: string }> };
    return { status: body.Status, ips: (body.Answer ?? []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data) };
  };
  let a, aaaa;
  try {
    [a, aaaa] = await Promise.all([ask("A"), ask("AAAA")]);
  } catch {
    return { ok: false, reason: `Couldn't look up ${host} right now. Try again in a moment.` };
  }
  if (a.status === 3) return { ok: false, reason: `${host} doesn't exist in DNS.` };
  const ips = [...a.ips, ...aaaa.ips];
  if (ips.length === 0) return { ok: false, reason: `${host} has no A or AAAA records, so there's no server to check.` };
  const bad = ips.find(isNonPublicIp);
  if (bad) return { ok: false, reason: `${host} points at a private or reserved address (${bad}). Only public servers can be checked.` };
  return { ok: true, host };
}
