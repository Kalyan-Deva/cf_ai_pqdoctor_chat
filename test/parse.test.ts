import { describe, expect, it } from "vitest";
import { findHostCandidates, findStack } from "../src/parse";

describe("findHostCandidates", () => {
  it("finds the domain in a question", () => {
    expect(findHostCandidates("is example.com post-quantum? we run nginx")).toEqual(["example.com"]);
  });
  it("finds URLs, several hosts, and dedupes", () => {
    expect(findHostCandidates("compare https://a.example.org/x and b.example.net, then a.example.org again")).toEqual(["a.example.org", "b.example.net"]);
  });
  it("keeps IPs and localhost so the guard can refuse them out loud", () => {
    expect(findHostCandidates("what about 10.0.0.1 or localhost:8080 or [::1]?")).toEqual(["10.0.0.1", "localhost:8080", "[::1]"]);
  });
  it("ignores file names, versions, emails and software names", () => {
    expect(findHostCandidates("I edited nginx.conf and site.yaml on openssl 3.5 with node.js, mail me@corp.example")).toEqual([]);
  });
  it("caps at three hosts", () => {
    expect(findHostCandidates("a.com b.com c.com d.com")).toHaveLength(3);
  });
});

describe("findStack", () => {
  it("canonicalises stacks", () => {
    expect(findStack("we run NGINX in front of express")).toEqual(["nginx", "Node.js"]);
    expect(findStack("our API is written in Go behind HAProxy")).toEqual(["HAProxy", "Go"]);
    expect(findStack("let's go check it")).toEqual([]);
  });
});
