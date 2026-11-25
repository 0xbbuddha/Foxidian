"use strict";

const RESERVED = new Set(["direct", "proxy"]);

const COLORS = [
  "#e11d48",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#0d9488",
  "#4f46e5",
];

function validId(id) {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) && !RESERVED.has(id);
}

function validHost(host) {
  return (
    typeof host === "string" &&
    host.length > 0 &&
    host.length <= 253 &&
    /^[a-zA-Z0-9._:-]+$/.test(host) &&
    !host.includes("..")
  );
}

function validPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function validPattern(pattern) {
  return (
    typeof pattern === "string" &&
    pattern.length > 0 &&
    pattern.length <= 200 &&
    /^[a-zA-Z0-9.*:?/_~%=&+-]+$/.test(pattern) &&
    !pattern.includes("..")
  );
}

function validColor(color) {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
}

function colorFor(id) {
  let hash = 0;
  for (const ch of String(id || "")) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function proxyEndpoint(settings) {
  const host = settings.proxyHost || settings.burpHost || "127.0.0.1";
  const port = Number(settings.proxyPort != null ? settings.proxyPort : settings.burpPort != null ? settings.burpPort : 8080);
  return { host, port };
}

function profilesOf(settings) {
  const endpoint = proxyEndpoint(settings);
  const proxy = {
    id: "proxy",
    name: "Proxy",
    type: "http",
    host: endpoint.host,
    port: endpoint.port,
  };
  return [{ id: "direct", name: "Direct", type: "direct" }, proxy, ...(settings.extras || [])];
}

function normalizeProfileId(id) {
  const key = String(id || "").toLowerCase();
  // Legacy built-in id from earlier Foxidian versions.
  return key === "burp" ? "proxy" : key;
}

function profileById(settings, id) {
  const key = normalizeProfileId(id);
  return profilesOf(settings).find((p) => p.id === key) || null;
}

// Map old burp* settings / profile ids onto the generic proxy profile.
function migrateSettings(saved) {
  if (!saved || typeof saved !== "object") return {};
  const next = { ...saved };
  if (next.proxyHost == null && next.burpHost != null) next.proxyHost = next.burpHost;
  if (next.proxyPort == null && next.burpPort != null) next.proxyPort = next.burpPort;
  delete next.burpHost;
  delete next.burpPort;
  if (normalizeProfileId(next.defaultProfile) === "proxy") next.defaultProfile = "proxy";
  next.containers = (next.containers || []).map((item) => ({
    ...item,
    profileId: normalizeProfileId(item.profileId) || "proxy",
  }));
  next.rules = (next.rules || []).map((rule) => ({
    ...rule,
    profile: normalizeProfileId(rule.profile),
  }));
  return next;
}

function slug(raw) {
  const id = String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return /^[a-z0-9]/.test(id) ? id : "";
}

function globToRegExp(glob) {
  let src = "";
  for (const c of glob) {
    if (c === "*") src += ".*";
    else if (c === "?") src += ".";
    else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + src + "$", "i");
}

function hostMatches(host, pattern) {
  const h = String(host || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const p = String(pattern || "").toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const rest = p.slice(2);
    return h === rest || h.endsWith("." + rest);
  }
  return globToRegExp(p).test(h);
}

function ruleMatches(url, host, pattern) {
  const p = pattern.toLowerCase();
  if (p.includes("://") || p.includes("/")) return globToRegExp(p).test(String(url || "").toLowerCase());
  return hostMatches(host, p);
}

function resolveProfile(url, host, settings) {
  const profiles = profilesOf(settings);
  const direct = profiles[0];
  for (const pattern of settings.bypass || []) {
    if (hostMatches(host, pattern)) return direct;
  }
  for (const rule of settings.rules || []) {
    if (!ruleMatches(url, host, rule.pattern)) continue;
    const picked = profileById(settings, rule.profile);
    if (picked) return picked;
  }
  return profileById(settings, settings.defaultProfile) || direct;
}

function proxyToken(profile) {
  if (!profile || profile.type === "direct") return "DIRECT";
  if (profile.type === "socks5") return "SOCKS5 " + profile.host + ":" + profile.port;
  return "PROXY " + profile.host + ":" + profile.port;
}

function pacEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function pacCondition(pattern) {
  const p = pattern.toLowerCase();
  if (!p.includes("://") && !p.includes("/") && p.startsWith("*.")) {
    const domain = pacEscape(p.slice(2));
    return `(host === "${domain}" || shExpMatch(host, "${pacEscape(p)}"))`;
  }
  if (!p.includes("://") && !p.includes("/")) return `shExpMatch(host, "${pacEscape(p)}")`;
  return `shExpMatch(url, "${pacEscape(p)}")`;
}

function buildPac(settings) {
  const lines = [];
  for (const pattern of settings.bypass || []) {
    if (!validPattern(pattern)) continue;
    lines.push(`  if (${pacCondition(pattern)}) return "DIRECT";`);
  }
  for (const rule of settings.rules || []) {
    const profile = profileById(settings, rule.profile);
    if (!profile || !validPattern(rule.pattern)) continue;
    lines.push(`  if (${pacCondition(rule.pattern)}) return "${proxyToken(profile)}";`);
  }
  const fallback = proxyToken(profileById(settings, settings.defaultProfile));
  return (
    "function FindProxyForURL(url, host) {\n" +
    "  host = host.toLowerCase();\n" +
    "  url = url.toLowerCase();\n" +
    lines.join("\n") +
    (lines.length ? "\n" : "") +
    `  return "${fallback}";\n}\n`
  );
}

function chooseConfig(settings) {
  if (!settings.enabled) return { mode: "direct" };
  const tokens = new Set([proxyToken(profileById(settings, settings.defaultProfile))]);
  for (const rule of settings.rules || []) {
    const profile = profileById(settings, rule.profile);
    if (profile) tokens.add(proxyToken(profile));
  }
  if (tokens.size > 1) {
    const pacText = buildPac(settings);
    return {
      mode: "pac_script",
      pacScript: "data:application/x-ns-proxy-autoconfig;base64," + Buffer.from(pacText).toString("base64"),
      pacText,
    };
  }
  const only = [...tokens][0];
  if (only === "DIRECT") return { mode: "direct" };
  const [, addr] = only.split(" ");
  const kind = only.startsWith("SOCKS5 ") ? "socks5" : "http";
  const proxyRules =
    kind === "socks5" ? "socks5://" + addr : "http=" + addr + ";https=" + addr;
  return {
    mode: "fixed_servers",
    proxyRules,
    proxyBypassRules: (settings.bypass || []).filter(validPattern).join(","),
  };
}

function parseLines(text) {
  return String(text || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function parseExtras(text) {
  const extras = [];
  const seen = new Set();
  for (const line of parseLines(text)) {
    const parts = line.split(/\s+/);
    if (parts.length !== 4) throw new Error(line);
    const [id, type, host, port] = parts;
    if (!validId(id) || (type !== "http" && type !== "socks5") || !validHost(host) || !validPort(port)) {
      throw new Error(line);
    }
    if (seen.has(id)) throw new Error(line);
    seen.add(id);
    extras.push({ id, name: id, type, host, port: Number(port) });
  }
  return extras;
}

function knownIds(settings) {
  return new Set(profilesOf(settings).map((p) => p.id));
}

function parseRules(text, settings) {
  const ids = knownIds(settings);
  const rules = [];
  for (const line of parseLines(text)) {
    const parts = line.split(/\s+/);
    if (parts.length !== 2) throw new Error(line);
    const [pattern, profile] = parts;
    if (!validPattern(pattern) || !ids.has(profile)) throw new Error(line);
    rules.push({ pattern, profile });
  }
  return rules;
}

function parseBypass(text) {
  const bypass = [];
  for (const line of parseLines(text)) {
    if (!validPattern(line)) throw new Error(line);
    bypass.push(line);
  }
  return bypass;
}

function makeContainer(name, profileId, color, userAgent) {
  const id = slug(name);
  if (!id) throw new Error(String(name) + ": name must contain a letter or digit");
  return {
    id,
    name: id,
    profileId: normalizeProfileId(profileId) || "proxy",
    color: validColor(color) ? color : colorFor(id),
    userAgent: typeof userAgent === "string" ? userAgent : "",
  };
}

function probeTcp(host, port, timeoutMs) {
  const net = require("net");
  const wait = Number(timeoutMs) > 0 ? Number(timeoutMs) : 800;
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(wait);
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function probeProfile(profile) {
  if (!profile || profile.type === "direct") return { ok: true, skip: true };
  if (!validHost(profile.host) || !validPort(profile.port)) return { ok: false, skip: false };
  const ok = await probeTcp(profile.host, profile.port);
  return { ok, skip: false, host: profile.host, port: profile.port };
}

function parseContainers(text, settings) {
  const containers = [];
  const seen = new Set();
  for (const line of parseLines(text)) {
    const parts = line.split(/\s+/);
    const last = profileById(settings, parts[parts.length - 1]);
    const named = parts.length > 1 && last ? parts.slice(0, -1).join(" ") : line;
    const profile = parts.length > 1 && last ? last : profileById(settings, "proxy");
    if (!profile) throw new Error(line + ": unknown profile");
    const container = makeContainer(named, profile.id);
    if (seen.has(container.id)) throw new Error(container.id + ": already exists");
    seen.add(container.id);
    containers.push(container);
  }
  return containers;
}

function formatExtras(extras) {
  return (extras || []).map((p) => `${p.id} ${p.type} ${p.host} ${p.port}`).join("\n");
}

function formatRules(rules) {
  return (rules || []).map((r) => `${r.pattern} ${r.profile}`).join("\n");
}

function formatContainers(containers) {
  return (containers || []).map((c) => `${c.name} ${c.profileId}`).join("\n");
}

function routeForProfile(settings, profileId) {
  const endpoint = proxyEndpoint(settings);
  return {
    enabled: normalizeProfileId(profileId) !== "direct",
    interceptCerts: settings.interceptCerts,
    proxyHost: endpoint.host,
    proxyPort: endpoint.port,
    bypass: settings.bypass,
    defaultProfile: normalizeProfileId(profileId),
    extras: settings.extras,
    rules: [],
  };
}

function partitionOf(containerId) {
  // shortcut: keep historical web-proxy partition prefix so existing cookies survive
  return "persist:web-proxy-" + containerId;
}

module.exports = {
  COLORS,
  RESERVED,
  validHost,
  validPort,
  validColor,
  colorFor,
  profilesOf,
  profileById,
  normalizeProfileId,
  migrateSettings,
  proxyEndpoint,
  slug,
  resolveProfile,
  proxyToken,
  buildPac,
  chooseConfig,
  parseExtras,
  parseRules,
  parseBypass,
  makeContainer,
  parseContainers,
  probeTcp,
  probeProfile,
  formatExtras,
  formatRules,
  formatContainers,
  routeForProfile,
  partitionOf,
};
