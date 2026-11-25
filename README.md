# Foxidian

Obsidian ships a built-in browser. It does not ship FoxyProxy. Foxidian fills that gap.

Flip the Web viewer through an HTTP interceptor (Burp, Caido, ZAP, mitmproxy, …) without leaving the vault, and open colored **containers** with their own cookies, session, and proxy. Handy when notes live on one side of the screen and intercept traffic on the other, without juggling three Chromes.

Desktop only. It leans on Obsidian’s Electron sessions, not a blessed public API: solid on 1.15, a big Obsidian upgrade might break an edge.

## What you get

- A compact right-sidebar panel with one-click profiles: Direct, Proxy, plus whatever you add
- A listener pill (with manual refresh) that shows whether the active proxy answers
- Isolated containers: color, User-Agent, clear cookies, DevTools, screenshots
- In-container proxy pill to cycle Direct / Proxy / extras without leaving the page
- Address bar that searches (DuckDuckGo) or opens URLs, same idea as Obsidian’s Web viewer
- Copy Cookie header (or full JSON) for Repeater / curl
- Clear HTTPS cert hints when the interceptor CA is missing
- Optional per-site rules in the settings tab if you want finer routing

Obsidian’s Web viewer (external links) and Foxidian containers do **not** share a session. On purpose.

## Install

Clone into the vault’s `.obsidian/plugins/` folder, enable **Foxidian**, reload if Obsidian does not see it yet.

```bash
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/0xbbuddha/Foxidian.git foxidian
```

Default proxy endpoint in the panel is `127.0.0.1:8080` (common for Burp / Caido). Change host/port if yours listens elsewhere.

## License

MIT. Do what you want with it.
