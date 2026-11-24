"use strict";

const { Plugin, PluginSettingTab, Setting, ItemView, SuggestModal, Notice, setIcon } = require("obsidian");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

let rules;

function loadRules(plugin) {
  const dir = String(plugin.manifest.dir || "");
  const named = path.join(dir, "proxy-rules.js");
  const rel = dir.replace(/\\/g, "/").replace(/\/$/, "") + "/proxy-rules.js";
  const adapter = plugin.app.vault.adapter;
  const viaVault =
    typeof adapter.getFullPath === "function"
      ? adapter.getFullPath(rel)
      : path.join(adapter.basePath || "", rel);
  const candidates = path.isAbsolute(dir) ? [named, viaVault] : [viaVault, named];
  const nodeRequire = window.require;
  for (const full of candidates) {
    if (!full || !fs.existsSync(full)) continue;
    try {
      delete nodeRequire.cache[nodeRequire.resolve(full)];
    } catch (error) {
      // Node require cache is optional.
    }
    return nodeRequire(full);
  }
  throw new Error("proxy-rules.js not found (" + candidates.join(", ") + ")");
}

const VIEW = "foxidian-container";
const PANEL = "foxidian-panel";
const BLANK = "about:blank";

const DEFAULTS = {
  enabled: false,
  interceptCerts: true,
  burpHost: "127.0.0.1",
  burpPort: 8081,
  bypass: ["localhost", "127.0.0.1", "::1"],
  defaultProfile: "burp",
  extras: [],
  rules: [],
  containers: [],
};

function sessionApi() {
  const electron = require("electron");
  if (!electron.remote) electron.remote = require("@electron/remote");
  return electron.remote.session;
}

function withUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
  return "https://" + value;
}

function normalizeContainers(list) {
  return (list || []).map((item) => {
    const id = item.id || rules.slug(item.name);
    return {
      id,
      name: item.name || id,
      profileId: item.profileId || "burp",
      color: rules.validColor(item.color) ? item.color : rules.colorFor(id),
      userAgent: typeof item.userAgent === "string" ? item.userAgent : "",
    };
  });
}

function navigateWebview(webview, url) {
  if (!webview || !url) return;
  if (typeof webview.setAttribute === "function") webview.setAttribute("src", url);
  webview.src = url;
}

function captureDefaultUserAgent(webview) {
  if (!webview || webview.__foxDefaultUa) return;
  try {
    if (typeof webview.getUserAgent === "function") webview.__foxDefaultUa = webview.getUserAgent();
  } catch (error) {
    console.error(error);
  }
}

function applyUserAgent(webview, userAgent) {
  if (!webview || typeof webview.setUserAgent !== "function") return;
  captureDefaultUserAgent(webview);
  const value = String(userAgent || "").trim();
  const next = value || webview.__foxDefaultUa;
  if (!next) return;
  try {
    webview.setUserAgent(next);
  } catch (error) {
    console.error(error);
  }
}

class ContainerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.containerId = "";
    this.webview = null;
    this.address = null;
    this.mountedId = "";
  }

  getViewType() {
    return VIEW;
  }

  getDisplayText() {
    const found = this.plugin.settings.containers.find((c) => c.id === this.containerId);
    return found ? found.name : "Container";
  }

  getIcon() {
    return "globe-2";
  }

  getState() {
    return { containerId: this.containerId };
  }

  async setState(state, result) {
    this.containerId = state?.containerId || "";
    await super.setState(state, result);
    await this.mount();
  }

  async onOpen() {}

  async onClose() {
    this.webview = null;
    this.address = null;
    this.mountedId = "";
    this.contentEl.empty();
  }

  paintChrome(found) {
    const color = found.color || rules.colorFor(found.id);
    this.containerEl.style.setProperty("--fox-color", color);
    this.containerEl.toggleClass("fox-leaf", true);
    if (this.leaf?.tabHeaderEl) {
      this.leaf.tabHeaderEl.style.setProperty("--fox-color", color);
      this.leaf.tabHeaderEl.toggleClass("fox-tab", true);
    }
    const chrome = this.contentEl.querySelector(".fox-chrome");
    if (chrome) chrome.style.setProperty("--fox-color", color);
  }

  async mount() {
    if (!this.containerId) {
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: "Opening container…" });
      return;
    }
    if (this.mountedId === this.containerId && this.webview) {
      const found = this.plugin.settings.containers.find((c) => c.id === this.containerId);
      if (found) this.paintChrome(found);
      return;
    }

    this.contentEl.empty();
    this.contentEl.addClass("fox-ctr");
    this.webview = null;
    this.address = null;

    const found = this.plugin.settings.containers.find((c) => c.id === this.containerId);
    if (!found) {
      this.contentEl.createEl("p", { text: "This container no longer exists." });
      return;
    }
    if (!rules.profileById(this.plugin.settings, found.profileId)) {
      this.contentEl.createEl("p", { text: "Unknown profile: " + found.profileId });
      return;
    }

    this.paintChrome(found);
    const profile = rules.profileById(this.plugin.settings, found.profileId);
    const color = found.color || rules.colorFor(found.id);

    const chrome = this.contentEl.createDiv("fox-chrome");
    chrome.style.setProperty("--fox-color", color);

    const banner = chrome.createDiv("fox-banner");
    banner.createSpan({ cls: "fox-banner-name", text: found.name });
    banner.createSpan({ cls: "fox-banner-meta", text: profile.name });
    const status = banner.createSpan({ cls: "fox-status", text: "Ready" });

    const bar = chrome.createDiv("fox-bar");
    const iconBtn = (parent, icon, title) => {
      const btn = parent.createEl("button", { cls: "clickable-icon fox-icon-btn", attr: { "aria-label": title, title } });
      setIcon(btn, icon);
      return btn;
    };

    const back = iconBtn(bar, "arrow-left", "Back");
    const reload = iconBtn(bar, "rotate-cw", "Reload");
    const input = bar.createEl("input", { type: "text", placeholder: "Search or enter address", cls: "fox-address" });
    input.spellcheck = false;
    this.address = input;
    const go = iconBtn(bar, "arrow-right", "Go");
    const more = iconBtn(bar, "ellipsis", "Tools");

    const tools = chrome.createDiv("fox-tools");
    tools.hide();
    const ua = tools.createEl("input", {
      type: "text",
      placeholder: "User-Agent (empty = default)",
      value: found.userAgent || "",
      cls: "fox-ua",
    });
    ua.spellcheck = false;
    const saveUa = iconBtn(tools, "check", "Save User-Agent");
    const clear = iconBtn(tools, "trash-2", "Clear cookies");
    const devtools = iconBtn(tools, "bug", "DevTools");

    more.addEventListener("click", () => {
      if (tools.hasClass("is-open")) {
        tools.removeClass("is-open");
        tools.hide();
        more.removeClass("is-active");
      } else {
        tools.addClass("is-open");
        tools.show();
        more.addClass("is-active");
        ua.focus();
      }
    });

    const host = this.contentEl.createDiv("fox-frame");
    const doc = this.contentEl.doc || document;
    const webview = doc.createElement("webview");
    webview.className = "fox-wv";
    webview.style.backgroundColor = "white";
    webview.partition = rules.partitionOf(found.id);
    webview.allowpopups = true;
    webview.setAttribute("allowpopups", "");
    host.appendChild(webview);
    this.webview = webview;
    this.mountedId = found.id;

    try {
      await this.plugin.applyProfile(rules.partitionOf(found.id), found.profileId);
    } catch (error) {
      status.setText("Proxy : " + error.message);
      new Notice("Foxidian : " + error.message);
    }

    navigateWebview(webview, BLANK);

    const syncUrl = (url) => {
      if (!url || url === BLANK) return;
      input.value = url;
    };

    webview.addEventListener("dom-ready", () => {
      captureDefaultUserAgent(webview);
      applyUserAgent(webview, found.userAgent);
    });
    webview.addEventListener("did-start-loading", () => {
      status.setText("Loading");
      this.contentEl.toggleClass("is-loading", true);
      reload.toggleClass("is-spinning", true);
    });
    webview.addEventListener("did-stop-loading", () => {
      this.contentEl.toggleClass("is-loading", false);
      reload.toggleClass("is-spinning", false);
      try {
        syncUrl(webview.getURL());
        status.setText(profile.name);
      } catch (error) {
        status.setText(profile.name);
      }
    });
    webview.addEventListener("did-navigate", (event) => syncUrl(event.url));
    webview.addEventListener("did-navigate-in-page", (event) => syncUrl(event.url));
    webview.addEventListener("page-title-updated", (event) => {
      if (event.title) this.leaf.tabHeaderInnerTitleEl?.setText(found.name + " - " + event.title);
    });
    webview.addEventListener("did-fail-load", (event) => {
      if (!event.isMainFrame || event.errorCode === -3) return;
      status.setText("Failed " + event.errorCode + " - " + (event.errorDescription || ""));
      new Notice("Navigation: " + (event.errorDescription || event.errorCode));
    });

    const load = () => {
      const url = withUrl(input.value);
      if (!url) {
        new Notice("Enter a URL");
        return;
      }
      input.value = url;
      status.setText("Opening…");
      try {
        navigateWebview(webview, url);
      } catch (error) {
        status.setText(error.message);
        new Notice("Navigation: " + error.message);
      }
    };

    go.addEventListener("click", (event) => {
      event.preventDefault();
      load();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        load();
      }
    });
    back.addEventListener("click", () => {
      try {
        if (webview.canGoBack && webview.canGoBack()) webview.goBack();
      } catch (error) {
        new Notice(error.message);
      }
    });
    reload.addEventListener("click", () => {
      try {
        if (webview.isLoading && webview.isLoading()) webview.stop();
        else if (typeof webview.reload === "function") webview.reload();
        else if (input.value) navigateWebview(webview, withUrl(input.value));
      } catch (error) {
        new Notice(error.message);
      }
    });

    saveUa.addEventListener("click", async () => {
      found.userAgent = ua.value.trim();
      await this.plugin.saveSettings(false, { quiet: true });
      applyUserAgent(webview, found.userAgent);
      new Notice(found.userAgent ? "User-Agent saved" : "User-Agent reset to default");
      try {
        const url = webview.getURL && webview.getURL();
        if (url && url !== BLANK) webview.reload();
      } catch (error) {
        console.error(error);
      }
    });
    ua.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveUa.click();
      }
    });

    clear.addEventListener("click", async () => {
      try {
        const session = sessionApi().fromPartition(rules.partitionOf(found.id));
        await session.clearStorageData();
        new Notice("Cookies / storage cleared for " + found.name);
        navigateWebview(webview, BLANK);
        input.value = "";
        status.setText("Empty session - " + profile.name);
      } catch (error) {
        new Notice("Cookies : " + error.message);
      }
    });

    devtools.addEventListener("click", () => {
      try {
        if (typeof webview.openDevTools === "function") webview.openDevTools();
        else new Notice("DevTools unavailable for this webview");
      } catch (error) {
        new Notice("DevTools : " + error.message);
      }
    });

    input.focus();
  }

  async reloadIfOpen() {
    if (!this.webview) return;
    try {
      const url = this.webview.getURL && this.webview.getURL();
      if (url && url !== BLANK) this.webview.reload();
    } catch (error) {
      console.error(error);
    }
  }
}

class PickContainer extends SuggestModal {
  constructor(app, items, onChoose) {
    super(app);
    this.items = items;
    this.pick = onChoose;
    this.setPlaceholder("Container");
  }

  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.items.filter((item) => item.name.toLowerCase().includes(q));
  }

  renderSuggestion(item, el) {
    const row = el.createDiv({ cls: "fox-suggest" });
    const dot = row.createSpan({ cls: "fox-dot" });
    dot.style.background = item.color || rules.colorFor(item.id);
    row.createSpan({ text: item.name + " - " + item.profileId });
  }

  onChooseSuggestion(item) {
    this.pick(item);
  }
}

class FoxidianSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Route Web viewer through proxy")
      .setDesc("On: Obsidian's built-in browser follows the active profile and rules. Off: direct.")
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.enabled).onChange(async (value) => {
          plugin.settings.enabled = value;
          await plugin.saveSettings(true);
        })
      );

    new Setting(containerEl)
      .setName("Default profile")
      .setDesc("Used when no rule matches. Also selectable with one click in the panel.")
      .addDropdown((dropdown) => {
        for (const profile of rules.profilesOf(plugin.settings)) dropdown.addOption(profile.id, profile.name);
        dropdown.setValue(plugin.settings.defaultProfile).onChange(async (value) => {
          plugin.settings.defaultProfile = value;
          await plugin.saveSettings(false);
        });
      });

    new Setting(containerEl)
      .setName("Burp")
      .setDesc("Proxy listener. Default in the panel: 127.0.0.1:8081.")
      .addText((text) =>
        text.setValue(plugin.settings.burpHost).onChange(async (value) => {
          if (!rules.validHost(value.trim())) return;
          plugin.settings.burpHost = value.trim();
          await plugin.saveSettings(false);
        })
      )
      .addText((text) =>
        text.setValue(String(plugin.settings.burpPort)).onChange(async (value) => {
          if (!rules.validPort(value)) return;
          plugin.settings.burpPort = Number(value);
          await plugin.saveSettings(false);
        })
      );

    new Setting(containerEl)
      .setName("Trust interceptor certificate")
      .setDesc("For HTTP profiles (Burp). Any proxy on that port is trusted while this is on.")
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.interceptCerts).onChange(async (value) => {
          plugin.settings.interceptCerts = value;
          await plugin.saveSettings(false);
        })
      );

    this.block(containerEl, "Bypass", "One pattern per line. Stays direct.", plugin.settings.bypass.join("\n"), async (value) => {
      plugin.settings.bypass = rules.parseBypass(value);
    });

    this.block(
      containerEl,
      "Extra proxies",
      "One line: id type host port. type = http or socks5.",
      rules.formatExtras(plugin.settings.extras),
      async (value) => {
        plugin.settings.extras = rules.parseExtras(value);
        plugin.settings.rules = plugin.settings.rules.filter((rule) => rules.profileById(plugin.settings, rule.profile));
        plugin.settings.containers = plugin.settings.containers.filter((item) =>
          rules.profileById(plugin.settings, item.profileId)
        );
        if (!rules.profileById(plugin.settings, plugin.settings.defaultProfile)) plugin.settings.defaultProfile = "burp";
      }
    );

    this.block(
      containerEl,
      "Rules",
      "One line: pattern profile. *.site includes the bare domain. First match wins.",
      rules.formatRules(plugin.settings.rules),
      async (value) => {
        plugin.settings.rules = rules.parseRules(value, plugin.settings);
      }
    );
  }

  block(containerEl, name, desc, value, apply) {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addTextArea((text) => {
        text.setValue(value);
        text.inputEl.rows = 4;
        text.inputEl.addEventListener("blur", async () => {
          try {
            await apply(text.inputEl.value);
          } catch (error) {
            new Notice("Rejected line: " + error.message);
            return;
          }
          try {
            await this.plugin.saveSettings(false);
          } catch (error) {
            new Notice("Foxidian : " + error.message);
          }
        });
      });
  }
}

class PanelView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.listenEl = null;
  }

  getViewType() {
    return PANEL;
  }

  getDisplayText() {
    return "Foxidian";
  }

  getIcon() {
    return "globe";
  }

  async onOpen() {
    this.render();
    this.plugin.attachPanel(this);
  }

  async onClose() {
    this.plugin.detachPanel(this);
    this.contentEl.empty();
  }

  render() {
    const plugin = this.plugin;
    const root = this.contentEl;
    root.empty();
    root.addClass("fox-panel");

    const listen = root.createDiv({ cls: "fox-listen is-skip" });
    listen.createSpan({ cls: "fox-dot" });
    this.listenLabel = listen.createSpan({ text: "Listener…" });
    this.listenRow = listen;

    root.createDiv({ cls: "fox-label", text: "Web viewer profile" });
    const profiles = root.createDiv("fox-profiles");
    const activeId = plugin.settings.enabled ? plugin.settings.defaultProfile : "direct";
    for (const profile of rules.profilesOf(plugin.settings)) {
      const btn = profiles.createEl("button", {
        text: profile.name,
        cls: profile.id === activeId ? "is-active" : "",
      });
      btn.onclick = () => plugin.activateProfile(profile.id);
    }

    const endpoint = root.createDiv("fox-burp");
    const host = endpoint.createEl("input", { type: "text", value: plugin.settings.burpHost });
    const port = endpoint.createEl("input", { type: "text", value: String(plugin.settings.burpPort) });
    host.spellcheck = false;
    port.spellcheck = false;
    host.addEventListener("change", () => {
      const value = host.value.trim();
      if (!rules.validHost(value)) {
        new Notice("Invalid host");
        host.value = plugin.settings.burpHost;
        return;
      }
      plugin.settings.burpHost = value;
      plugin.saveSettings(false);
    });
    port.addEventListener("change", () => {
      if (!rules.validPort(port.value)) {
        new Notice("Invalid port");
        port.value = String(plugin.settings.burpPort);
        return;
      }
      plugin.settings.burpPort = Number(port.value);
      plugin.saveSettings(false);
    });

    if (plugin.settings.rules.length) {
      root.createEl("p", {
        cls: "fox-note",
        text: plugin.settings.rules.length + " active rule(s) - details in settings.",
      });
    }

    root.createDiv({ cls: "fox-label", text: "Containers" });
    const list = root.createDiv("fox-list");
    if (!plugin.settings.containers.length) {
      list.createEl("p", { cls: "fox-note", text: "No containers yet. Add one below." });
    }
    for (const container of plugin.settings.containers) {
      const row = list.createDiv("fox-row");
      const color = row.createEl("input");
      color.type = "color";
      color.value = container.color || rules.colorFor(container.id);
      color.title = "Container color";
      color.className = "fox-color";
      color.addEventListener("input", () => {
        if (!rules.validColor(color.value)) return;
        container.color = color.value;
        plugin.paintContainer(container);
      });
      color.addEventListener("change", async () => {
        if (!rules.validColor(color.value)) {
          color.value = container.color || rules.colorFor(container.id);
          return;
        }
        container.color = color.value;
        await plugin.saveSettings(false, { quiet: true });
        plugin.paintContainer(container);
      });
      row.createSpan({ cls: "fox-name", text: container.name });
      const select = row.createEl("select");
      for (const item of rules.profilesOf(plugin.settings)) {
        const option = select.createEl("option", { text: item.name });
        option.value = item.id;
      }
      select.value = container.profileId;
      select.onchange = async () => {
        container.profileId = select.value;
        await plugin.saveSettings(false);
        await plugin.refreshContainer(container);
      };
      row.createEl("button", { text: "Open" }).onclick = () => plugin.openContainer(container);
      row.createEl("button", { text: "×" }).onclick = () => {
        plugin.settings.containers = plugin.settings.containers.filter((item) => item.id !== container.id);
        plugin.saveSettings(false);
      };
    }

    const add = root.createDiv("fox-add");
    const name = add.createEl("input", { type: "text", placeholder: "Container name" });
    const addColor = add.createEl("input");
    addColor.type = "color";
    addColor.value = rules.colorFor("nouveau");
    addColor.title = "Color";
    addColor.className = "fox-color";
    const chosen = add.createEl("select");
    for (const item of rules.profilesOf(plugin.settings)) {
      const option = chosen.createEl("option", { text: item.name });
      option.value = item.id;
    }
    chosen.value = "burp";
    const submit = async () => {
      const raw = name.value.trim();
      if (!raw) return;
      let container;
      try {
        container = rules.makeContainer(raw, chosen.value, addColor.value);
      } catch (error) {
        new Notice(error.message);
        return;
      }
      if (plugin.settings.containers.some((item) => item.id === container.id)) {
        new Notice(container.id + ": already exists");
        return;
      }
      plugin.settings.containers.push(container);
      name.value = "";
      await plugin.saveSettings(false);
      await plugin.openContainer(container);
    };
    add.createEl("button", { text: "Create", cls: "mod-cta" }).onclick = submit;
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });

    this.refreshListener();
  }

  async refreshListener() {
    if (!this.listenRow || !this.listenLabel) return;
    const plugin = this.plugin;
    const profile = plugin.settings.enabled
      ? rules.profileById(plugin.settings, plugin.settings.defaultProfile)
      : rules.profileById(plugin.settings, "direct");
    const result = await rules.probeProfile(profile);
    this.listenRow.removeClass("is-up");
    this.listenRow.removeClass("is-down");
    this.listenRow.removeClass("is-skip");
    if (result.skip) {
      this.listenRow.addClass("is-skip");
      this.listenLabel.setText("Direct - no listener");
      return;
    }
    if (result.ok) {
      this.listenRow.addClass("is-up");
      this.listenLabel.setText((profile?.name || "Proxy") + " " + result.host + ":" + result.port + " - OK");
      return;
    }
    this.listenRow.addClass("is-down");
    this.listenLabel.setText((profile?.name || "Proxy") + " " + result.host + ":" + result.port + " - down");
  }
}

class FoxidianPlugin extends Plugin {
  async onload() {
    rules = loadRules(this);
    const saved = (await this.loadData()) || {};
    this.settings = { ...DEFAULTS, ...saved };
    this.settings.containers = normalizeContainers(this.settings.containers);
    this.panels = new Set();
    this.probeTimer = null;

    this.status = this.addStatusBarItem();
    this.status.addClass("mod-clickable");
    this.status.setAttr("title", "Open Foxidian");
    this.status.onclick = () => this.openPanel();
    this.renderStatus();
    this.addRibbonIcon("globe", "Foxidian", () => this.openPanel());

    this.addCommand({
      id: "toggle",
      name: "Toggle Web viewer proxy",
      callback: () => this.toggle(),
    });
    this.addCommand({
      id: "open-panel",
      name: "Open panel",
      callback: () => this.openPanel(),
    });
    this.addCommand({
      id: "open-container",
      name: "Open a container",
      callback: () => this.openContainerPicker(),
    });

    this.registerView(VIEW, (leaf) => new ContainerView(leaf, this));
    this.registerView(PANEL, (leaf) => new PanelView(leaf, this));
    this.addSettingTab(new FoxidianSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      this.applyViewer(false).catch((error) => new Notice("Foxidian : " + error.message));
      this.startProbe();
    });
  }

  onunload() {
    this.stopProbe();
  }

  attachPanel(view) {
    this.panels.add(view);
    this.startProbe();
  }

  detachPanel(view) {
    this.panels.delete(view);
    if (!this.panels.size) this.stopProbe();
  }

  startProbe() {
    if (this.probeTimer) return;
    this.probeTimer = window.setInterval(() => this.refreshPanelsListener(), 4000);
    this.refreshPanelsListener();
  }

  stopProbe() {
    if (!this.probeTimer) return;
    window.clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  refreshPanelsListener() {
    for (const panel of this.panels) {
      if (panel.refreshListener) panel.refreshListener();
    }
  }

  renderStatus() {
    if (!this.settings.enabled) {
      this.status.setText("fox direct");
      return;
    }
    if (this.settings.rules.length) {
      this.status.setText("fox rules");
      return;
    }
    const profile = rules.profileById(this.settings, this.settings.defaultProfile);
    this.status.setText(profile ? "fox " + profile.name : "fox direct");
  }

  async toggle() {
    if (this.settings.enabled) await this.activateProfile("direct");
    else await this.activateProfile(this.settings.defaultProfile === "direct" ? "burp" : this.settings.defaultProfile);
  }

  async activateProfile(profileId) {
    const profile = rules.profileById(this.settings, profileId);
    if (!profile) {
      new Notice("Unknown profile");
      return;
    }
    if (profile.id === "direct") {
      this.settings.enabled = false;
    } else {
      this.settings.enabled = true;
      this.settings.defaultProfile = profile.id;
    }
    await this.saveSettings(true);
  }

  async saveSettings(reload, opts = {}) {
    await this.saveData(this.settings);
    this.renderStatus();
    if (!opts.quiet) {
      for (const leaf of this.app.workspace.getLeavesOfType(PANEL)) {
        if (leaf.view?.render) leaf.view.render();
      }
    }
    this.refreshPanelsListener();
    try {
      await this.applyViewer(reload);
    } catch (error) {
      new Notice("Foxidian : " + error.message);
    }
  }

  paintContainer(container) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) {
      if (leaf.view?.containerId !== container.id) continue;
      if (leaf.view.paintChrome) leaf.view.paintChrome(container);
    }
  }

  async openPanel() {
    let leaf = this.app.workspace.getLeavesOfType(PANEL)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(true);
      await leaf.setViewState({ type: PANEL, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  partition() {
    if (typeof this.app.getWebviewPartition === "function") return this.app.getWebviewPartition();
    return "persist:vault-" + this.app.appId;
  }

  async applyViewer(reload) {
    await this.applyRoute(this.partition(), this.settings);
    if (!reload) return;
    const partition = this.partition();
    for (const webview of document.querySelectorAll("webview")) {
      if (webview.getAttribute("partition") !== partition && webview.partition !== partition) continue;
      try {
        if (webview.getURL && webview.getURL()) webview.reload();
      } catch (error) {
        console.error(error);
      }
    }
  }

  async applyProfile(partition, profileId) {
    await this.applyRoute(partition, rules.routeForProfile(this.settings, profileId));
  }

  async applyRoute(partition, route) {
    const session = sessionApi().fromPartition(partition);
    const config = rules.chooseConfig(route);
    await this.setProxy(session, config);
    try {
      this.bindCerts(session, route);
    } catch (error) {
      new Notice("Certificate bypass failed (" + error.message + "). Import the Burp CA if HTTPS breaks.");
    }
    if (typeof session.closeAllConnections === "function") await session.closeAllConnections();
  }

  async setProxy(session, config) {
    const pacText = config.pacText;
    const clean = { mode: config.mode };
    if (config.proxyRules) clean.proxyRules = config.proxyRules;
    if (config.proxyBypassRules) clean.proxyBypassRules = config.proxyBypassRules;
    if (config.pacScript) clean.pacScript = config.pacScript;
    try {
      await session.setProxy(clean);
    } catch (error) {
      if (!pacText) throw error;
      // shortcut: data-URL PAC rejected by this Electron, fall back to a local file
      const dir = String(this.manifest.dir || "");
      const file = path.isAbsolute(dir)
        ? path.join(dir, "proxy.pac")
        : this.app.vault.adapter.getFullPath(dir.replace(/\\/g, "/").replace(/\/$/, "") + "/proxy.pac");
      fs.writeFileSync(file, pacText);
      await session.setProxy({ mode: "pac_script", pacScript: pathToFileURL(file).href });
    }
  }

  bindCerts(session, route) {
    if (typeof session.setCertificateVerifyProc !== "function") return;
    const intercept = route.enabled && route.interceptCerts;
    if (!intercept) {
      session.setCertificateVerifyProc(null);
      return;
    }
    session.setCertificateVerifyProc((request, callback) => {
      try {
        const host = request.hostname || "";
        const url = request.url || "https://" + host + "/";
        const profile = rules.resolveProfile(url, host, route);
        callback(profile && profile.type === "http" ? 0 : -3);
      } catch (error) {
        console.error(error);
        callback(-3);
      }
    });
  }

  openContainerPicker() {
    const items = this.settings.containers;
    if (!items.length) {
      new Notice("Add a container in the Foxidian panel.");
      return;
    }
    new PickContainer(this.app, items, (item) => this.openContainer(item)).open();
  }

  async openContainer(item) {
    const existing = this.app.workspace.getLeavesOfType(VIEW).find((leaf) => leaf.view?.containerId === item.id);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW, active: true, state: { containerId: item.id } });
    this.app.workspace.revealLeaf(leaf);
  }

  async refreshContainer(container) {
    const leaf = this.app.workspace.getLeavesOfType(VIEW).find((item) => item.view?.containerId === container.id);
    if (!leaf) return;
    await this.applyProfile(rules.partitionOf(container.id), container.profileId);
    if (leaf.view?.reloadIfOpen) await leaf.view.reloadIfOpen();
  }
}

module.exports = FoxidianPlugin;
