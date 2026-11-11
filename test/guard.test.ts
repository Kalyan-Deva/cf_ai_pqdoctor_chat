import { describe, expect, it } from "vitest";
import { checkHostname, checkResolves, isNonPublicIp, parseIpv6 } from "../src/guard";

describe("checkHostname", () => {
  it.each([
    ["example.com", "example.com"],
    ["https://Example.COM/path?q=1", "example.com"],
    ["www.example.co.uk.", "www.example.co.uk"],
    ["example.com:443", "example.com"],
    ["user@example.com", "example.com"],
  ])("accepts %s", (raw, host) => {
    expect(checkHostname(raw)).toEqual({ ok: true, host });
  });

  it.each([
    "127.0.0.1", "10.0.0.5", "127.1", "0x7f000001", "[::1]", "::1", "fe80::1",
    "localhost", "intranet", "db.local", "api.internal", "printer.home.arpa", "nas.lan", "corp.corp",
    "foo.test", "x.invalid", "something.onion", "example.com:8443", "-bad-.com", "a..b.com",
  ])("refuses %s", (raw) => {
    expect(checkHostname(raw).ok).toBe(false);
  });
});

describe("isNonPublicIp", () => {
  it.each(["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::abcd", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "2002:0a00:0001::1", "ff02::1"])(
    "%s is not public",
    (ip) => expect(isNonPublicIp(ip)).toBe(true),
  );
  it.each(["1.1.1.1", "8.8.8.8", "140.82.112.3", "172.32.0.1", "2606:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8"])("%s is public", (ip) => expect(isNonPublicIp(ip)).toBe(false));

  it("parses IPv6 with an IPv4 tail", () => {
    expect(parseIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});

describe("checkResolves", () => {
  const doh = (answers: Record<string, Array<{ type: number; data: string }>>, status = 0) => async (url: string) => {
    const type = new URL(url).searchParams.get("type")!;
    return new Response(JSON.stringify({ Status: status, Answer: answers[type] ?? [] }));
  };

  it("accepts a public name", async () => {
    expect(await checkResolves("example.com", doh({ A: [{ type: 1, data: "93.184.215.14" }] }))).toEqual({ ok: true, host: "example.com" });
  });
  it("refuses a public name that points at a private address (DNS rebinding style)", async () => {
    const r = await checkResolves("evil.example", doh({ A: [{ type: 5, data: "x." }, { type: 1, data: "10.0.0.7" }] }));
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain("10.0.0.7");
  });
  it("refuses when any one AAAA answer is private", async () => {
    expect((await checkResolves("mixed.example", doh({ A: [{ type: 1, data: "1.1.1.1" }], AAAA: [{ type: 28, data: "fd00::1" }] }))).ok).toBe(false);
  });
  it("refuses NXDOMAIN and empty answers", async () => {
    expect((await checkResolves("nope.example", doh({}, 3))).ok).toBe(false);
    expect((await checkResolves("empty.example", doh({}))).ok).toBe(false);
  });
});
