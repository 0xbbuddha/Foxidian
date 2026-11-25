"use strict";

const assert = require("assert");
const rules = require("./proxy-rules");

const base = {
  enabled: true,
  interceptCerts: true,
  proxyHost: "127.0.0.1",
  proxyPort: 8080,
  bypass: ["localhost", "127.0.0.1", "::1"],
  defaultProfile: "proxy",
  extras: [],
  rules: [],
};

{
  const hit = rules.resolveProfile("https://example.com/", "example.com", base);
  assert.equal(hit.id, "proxy");
  assert.equal(hit.name, "Proxy");
  assert.equal(rules.resolveProfile("http://127.0.0.1/", "127.0.0.1", base).id, "direct");
  const config = rules.chooseConfig(base);
  assert.equal(config.mode, "fixed_servers");
  assert.equal(config.proxyRules, "http=127.0.0.1:8080;https=127.0.0.1:8080");
}

{
  const mixed = {
    ...base,
    defaultProfile: "direct",
    extras: [{ id: "lab", name: "lab", type: "socks5", host: "10.0.0.2", port: 1080 }],
    rules: [
      { pattern: "*.lab", profile: "proxy" },
      { pattern: "*.sock", profile: "lab" },
    ],
  };
  assert.equal(rules.resolveProfile("https://a.lab/", "a.lab", mixed).id, "proxy");
  assert.equal(rules.chooseConfig(mixed).mode, "pac_script");
}

{
  const c = rules.makeContainer("Cible", "proxy");
  assert.equal(c.id, "cible");
  assert.equal(c.profileId, "proxy");
  assert.equal(c.userAgent, "");
  assert.ok(/^#[0-9a-fA-F]{6}$/.test(c.color));
  assert.equal(rules.partitionOf(c.id), "persist:web-proxy-cible");
  assert.deepEqual(rules.parseContainers("Cible\nmon conteneur", base).map((x) => x.id), [
    "cible",
    "mon-conteneur",
  ]);
  assert.throws(() => rules.parseExtras('x http 127.0.0.1 8080"; evil'));
}

{
  const legacy = rules.migrateSettings({
    burpHost: "10.0.0.1",
    burpPort: 8082,
    defaultProfile: "burp",
    containers: [{ id: "lab", name: "lab", profileId: "burp", color: "#16a34a" }],
    rules: [{ pattern: "*.corp", profile: "burp" }],
  });
  assert.equal(legacy.proxyHost, "10.0.0.1");
  assert.equal(legacy.proxyPort, 8082);
  assert.equal(legacy.burpHost, undefined);
  assert.equal(legacy.defaultProfile, "proxy");
  assert.equal(legacy.containers[0].profileId, "proxy");
  assert.equal(legacy.rules[0].profile, "proxy");
  assert.equal(rules.profileById(legacy, "burp").id, "proxy");
}

console.log("ok");
