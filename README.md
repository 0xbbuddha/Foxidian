# Foxidian

Obsidian ships a built-in browser. It does not ship FoxyProxy. Foxidian fills that gap.

Flip the Web viewer through Burp (or another proxy) without leaving the vault, and open colored **containers** with their own cookies, session, and proxy. Handy when notes live on one side of the screen and intercept traffic on the other, without juggling three Chromes.

Desktop only. It leans on Obsidian’s Electron sessions, not a blessed public API: solid on 1.15, a big Obsidian upgrade might break an edge.

## What you get

- A side panel with one-click profiles: Direct, Burp, plus whatever you add
- A listener pill that shows whether the active proxy answers (saves you from `ERR_TUNNEL_CONNECTION_FAILED` because Burp was on another port)
- Isolated containers: pick a color, set a User-Agent, clear cookies, open DevTools
- Optional per-site rules in the settings tab if you want finer routing

Obsidian’s Web viewer (external links) and Foxidian containers do **not** share a session. On purpose.

## Install

Clone into the vault’s `.obsidian/plugins/` folder, enable **Foxidian**, reload if Obsidian does not see it yet.

```bash
cd /path/to/vault/.obsidian/plugins
git clone <repo-url> foxidian
```

Default Burp endpoint in the panel is `127.0.0.1:8081`. Change it if yours listens elsewhere.

## License

MIT. Do what you want with it.
