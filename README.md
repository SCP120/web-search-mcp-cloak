# web-search-mcp-cloak

> Stealth web-search MCP server for local LLMs. **CloakBrowser** + **Webshare proxy rotation** = no more Bing/Brave CAPTCHA walls.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Forked from mrkrsl/web-search-mcp](https://img.shields.io/badge/forked%20from-mrkrsl%2Fweb--search--mcp-green)](https://github.com/mrkrsl/web-search-mcp)

## Why this fork exists

The upstream [`mrkrsl/web-search-mcp`](https://github.com/mrkrsl/web-search-mcp) is a great idea, but in practice it returns **0 results** after a handful of queries. The cause is **Bing's bot detection serving a CAPTCHA page** instead of search results. This isn't a bug in mrkrsl's parser — Bing's HTML literally contains `class="captcha"` instead of the usual `.b_algo` result elements.

This fork fixes the root causes of detection:

| Problem | Upstream | This fork |
|---------|----------|-----------|
| Browser fingerprint screams "bot" | Raw Playwright | **CloakBrowser** — 48 source-level C++ patches (canvas, WebGL, audio, fonts, GPU, WebRTC, automation signals) |
| Single home IP gets flagged | Always your home IP | **Webshare proxy rotation** — random proxy per query |
| Timezone/locale mismatch with proxy | N/A | **`geoip: true`** — auto-syncs to proxy IP |
| Firefox dependency | Required | **Dropped** — Chromium-only via CloakBrowser |

Everything else (the MCP tools, content extraction, fallback chain) is preserved from upstream.

## What you get

Three MCP tools, identical names and APIs to upstream:

| Tool | Purpose |
|------|---------|
| `full-web-search` | Search + fetch full page content for top results |
| `get-web-search-summaries` | Lightweight: just titles, URLs, descriptions |
| `get-single-web-page-content` | Read one URL deeply |

## Install

### 1. Clone and build

```bash
git clone https://github.com/SCP120/web-search-mcp-cloak.git
cd web-search-mcp-cloak
npm install
npm run build
```

CloakBrowser auto-downloads its stealth Chromium binary (~200 MB) on first launch and caches it in `~/.cloakbrowser/`.

### 2. Get a Webshare token (optional but strongly recommended)

1. Sign up at <https://www.webshare.io/> (free tier: 10 datacenter proxies)
2. Go to **API Keys** in the dashboard
3. Copy your token

### 3. Configure your MCP host

#### LM Studio

Edit `~/.lmstudio/mcp.json`:

```json
{
  "mcpServers": {
    "web-search-cloak": {
      "command": "node",
      "args": ["/absolute/path/to/web-search-mcp-cloak/dist/index.js"],
      "env": {
        "WEBSHARE_API_TOKEN": "<your-token-here>",
        "MAX_BROWSERS": "2",
        "FORCE_MULTI_ENGINE_SEARCH": "true"
      }
    }
  }
}
```

Restart LM Studio. The new MCP appears in **Program → Integrations** and as a chip in the chat input bar.

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "web-search-cloak": {
      "command": "node",
      "args": ["/absolute/path/to/web-search-mcp-cloak/dist/index.js"],
      "env": {
        "WEBSHARE_API_TOKEN": "<your-token-here>"
      }
    }
  }
}
```

## Configuration

All env vars are optional. Without `WEBSHARE_API_TOKEN`, the server runs in passthrough mode (no proxy — equivalent to upstream behavior, still benefits from CloakBrowser stealth).

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEBSHARE_API_TOKEN` | _(unset)_ | Enables proxy rotation. Strongly recommended. |
| `PROXY_REFRESH_HOURS` | `6` | How often to re-fetch proxy list from Webshare. |
| `PROXY_COUNTRY_FILTER` | _(unset)_ | Comma-separated ISO codes (e.g. `US,SG,JP`). Empty = any. |
| `MAX_BROWSERS` | `3` | Concurrent CloakBrowser instances kept warm. |
| `BROWSER_HEADLESS` | `true` | Set `false` to see browser windows (debugging). |
| `MAX_CONTENT_LENGTH` | `10000` | Per-result content cap (chars). |
| `DEFAULT_TIMEOUT` | `10000` | Per-request timeout (ms). |
| `FORCE_MULTI_ENGINE_SEARCH` | `false` | Try all engines, return best mix. |
| `ENABLE_RELEVANCE_CHECKING` | `true` | Drop low-relevance results. |
| `RELEVANCE_THRESHOLD` | `0.3` | Min relevance score (0.0–1.0). |
| `DEBUG_BING_SEARCH` | `false` | Verbose Bing logs. |

See [`.env.example`](.env.example) for a copy-paste template.

## Without Webshare

The server still works without a Webshare token — it just falls back to using your local IP. CloakBrowser's fingerprint patches still help, but Bing will eventually rate-limit you. For sustained use you'll want a Webshare token (or any HTTP proxy provider — see "Custom proxy" below).

## How proxy rotation works

1. On startup, `ProxyPool` fetches up to 100 valid proxies from `https://proxy.webshare.io/api/v2/proxy/list/`.
2. The list is filtered by `valid:true` and (optionally) `PROXY_COUNTRY_FILTER`.
3. Every browser launch picks a **uniformly random proxy** from the healthy list.
4. If a launch fails through proxy `X`, that proxy is **blacklisted for 5 minutes** and the launch retries with a different one.
5. The list is refreshed every `PROXY_REFRESH_HOURS` (default 6h) and on demand via the timer.
6. If `geoip: true`, CloakBrowser auto-aligns the browser's timezone and locale with the proxy IP — bot detection systems compare these and a mismatch is a red flag.

## Architecture

```
┌──────────────────────────────────────────┐
│        web-search-mcp-cloak              │
└────────┬─────────────────────────┬───────┘
         │                         │
   ┌─────▼──────┐         ┌────────▼─────────┐
   │  CloakBrwsr│◄────────│   ProxyPool      │
   │  (npm)     │  proxy  │   (Webshare API) │
   └─────┬──────┘         └──────────────────┘
         │
   ┌─────▼──────┐
   │BrowserPool │
   └─────┬──────┘
         │
   ┌─────▼──────┐
   │SearchEngine│ ─→  Bing  →  Brave  →  DuckDuckGo
   └────────────┘
```

## Differences from upstream

- ✅ **Replaced:** `playwright` → `cloakbrowser` + `playwright-core`
- ✅ **Added:** `src/proxy-pool.ts` — Webshare API client
- ✅ **Modified:** `src/browser-pool.ts` — accepts ProxyPool, drops Firefox/WebKit paths
- ✅ **Modified:** `src/search-engine.ts` — uses BrowserPool's `launchEphemeral()` for both Bing and Brave attempts
- ✅ **Updated:** `package.json` — bumped to v0.4.0, swapped deps, renamed package
- ⏸️ **Unchanged:** All MCP tool definitions, content extraction, rate limiting, error categorization

## Limitations

- CloakBrowser is **Chromium-only**. The original Firefox/WebKit fallback paths are removed. In practice this is fine because CloakBrowser's stealth is far stronger than vanilla Firefox.
- Webshare's **datacenter proxies** are sufficient for Bing/Brave but may be flagged by harder targets (Cloudflare-protected sites). For those, plug in a residential proxy provider (any HTTP proxy works — see "Custom proxy" below).
- The bot-detection cat-and-mouse never ends. If Bing eventually adapts and starts blocking CloakBrowser fingerprints, you'll need to update the `cloakbrowser` package.

## Custom proxy (non-Webshare)

`ProxyPool` is currently coded for Webshare's API shape. To use a different provider, you have two options:

1. **Quick:** Set a single fixed `HTTP_PROXY` env var and tweak `browser-pool.ts` to read it as the only proxy. Loses rotation but works.
2. **Proper:** Implement a new fetcher in `proxy-pool.ts` that talks to your provider's API. The `ProxyConfig` shape (`{server, username, password}`) is provider-agnostic.

Contributions welcome.

## Credits

This is a fork of [`mrkrsl/web-search-mcp`](https://github.com/mrkrsl/web-search-mcp) by Mark Russell. All the search logic, content extraction, and MCP scaffolding is theirs — credit where due. This fork only swaps the browser engine and adds proxy rotation.

Stealth Chromium provided by [`CloakHQ/CloakBrowser`](https://github.com/CloakHQ/CloakBrowser).

## License

MIT (preserved from upstream). See [LICENSE](LICENSE).

## Disclaimer

You are responsible for complying with the terms of service of the search engines and websites you query. Webshare datacenter proxies are intended for legitimate use cases. Don't use this to abuse, harass, or violate other people's rights.
