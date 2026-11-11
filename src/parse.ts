// Reading a chat message: which hosts it names, and what stack the user says they run.
// Deterministic on purpose: the guardrails need to see every name before any model does.

const FILE_EXTENSIONS = new Set([
  "conf", "cfg", "ini", "yaml", "yml", "json", "toml", "txt", "log", "md", "sh", "ps1", "js", "ts",
  "mjs", "cjs", "py", "rs", "go", "java", "rb", "php", "html", "css", "xml", "pem", "crt", "key", "csr", "der", "lock", "exe", "dll", "so",
]);

/** Words that look like hosts but name software ("node.js", "next.js", "asp.net"). */
const NOT_HOSTS = new Set(["node.js", "next.js", "nuxt.js", "vue.js", "asp.net", "socket.io", "ssl.conf", "nginx.conf"]);

/** Everything in the message that looks like a host or an address, in order, deduplicated. */
export function findHostCandidates(text: string, max = 3): string[] {
  const out: string[] = [];
  const add = (h: string) => {
    const v = h.toLowerCase().replace(/\.$/, "");
    if (!out.includes(v)) out.push(v);
  };
  // URLs and bracketed IPv6 first, so their insides aren't matched twice.
  const re =
    /(?:https?:\/\/)?(\[[0-9a-f:.]+\](?::\d+)?|(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?|\blocalhost(?::\d+)?\b|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}(?::\d+)?)/gi;
  for (const m of text.matchAll(re)) {
    const token = m[1];
    const before = text[m.index! - 1];
    if (before === "@") continue; // an email address, not a server
    const bare = token.replace(/:\d+$/, "").toLowerCase();
    if (NOT_HOSTS.has(bare)) continue;
    const tld = bare.split(".").pop() ?? "";
    if (/^[a-z]/.test(tld) && FILE_EXTENSIONS.has(tld) && !/^https?:\/\//i.test(m[0])) continue;
    if (/^\d+(\.\d+){1,2}$/.test(bare)) continue; // a version number like 3.5 or 1.25.3
    add(token);
    if (out.length >= max) break;
  }
  return out;
}

const STACKS: Array<[string, RegExp]> = [
  ["nginx", /\bnginx\b/i],
  ["Apache httpd", /\bapache\b|\bhttpd\b/i],
  ["Caddy", /\bcaddy\b/i],
  ["HAProxy", /\bhaproxy\b/i],
  ["Envoy", /\benvoy\b/i],
  ["Traefik", /\btraefik\b/i],
  ["IIS", /\biis\b/i],
  ["Tomcat", /\btomcat\b/i],
  ["Node.js", /\bnode(?:\.js|js)?\b|\bexpress\b/i],
  ["Go", /\bgolang\b|\bgo\s?1\.\d+|\b(?:in|use|run|using)\s+go\b/i],
  ["Java", /\bjava\b|\bspring boot\b|\bjvm\b/i],
  ["rustls", /\brustls\b/i],
  ["OpenSSL", /\bopenssl\b/i],
  ["BoringSSL", /\bboringssl\b/i],
  ["AWS-LC", /\baws-?lc\b/i],
  ["AWS load balancer", /\b(?:alb|elb|nlb)\b|\bapplication load balancer\b/i],
  ["CloudFront", /\bcloudfront\b/i],
  ["Cloudflare Tunnel", /\bcloudflared\b|\bcloudflare tunnel\b/i],
  ["Kubernetes ingress", /\bingress(?:-nginx)?\b|\bkubernetes\b|\bk8s\b/i],
];

/** Stack names the message mentions, canonicalised ("we run NGINX + express" -> ["nginx", "Node.js"]). */
export function findStack(text: string): string[] {
  return STACKS.filter(([, re]) => re.test(text)).map(([name]) => name);
}
