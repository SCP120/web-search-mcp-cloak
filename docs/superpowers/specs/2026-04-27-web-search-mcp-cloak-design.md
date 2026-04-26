# web-search-mcp-cloak — Design Spec

**Date:** 2026-04-27
**Author:** SCP120 (with Claude)
**Status:** Approved (ready for plan)
**Upstream:** [mrkrsl/web-search-mcp@v0.3.2](https://github.com/mrkrsl/web-search-mcp)

## Problem

`mrkrsl/web-search-mcp` returns 0 results on Bing after a few queries. Root cause: **Bing's bot detection serves a CAPTCHA page** (HTML contains `class="captcha"`, no `.b_algo` results). mrkrsl uses raw Playwright with no fingerprint stealth and a single home IP, so detection is rapid and persistent. No upstream fix exists; 10+ forks have only made README changes.

## Goal

Fork mrkrsl and replace its scraping stack with one that bypasses bot detection durably:
1. Swap `playwright` → `cloakbrowser` (drop-in, source-level fingerprint patches)
2. Add Webshare proxy rotation (100 SG datacenter proxies available)
3. Live-test with real LM Studio queries
4. Publish to `SCP120/web-search-mcp-cloak` as a polished public fork

## Non-Goals

- Not maintaining feature parity with all mrkrsl tools at first (Firefox path is dropped — CloakBrowser is Chromium-only)
- Not solving residential-IP-needed cases (datacenter proxies suffice for Bing/Brave)
- Not publishing to npm registry (out of scope for B; see future work)
- Not PR-ing back upstream (out of scope for B; see future work)

## Architecture

```
┌─────────────────────────────────────────────────┐
│            web-search-mcp-cloak                 │
│  (forked from mrkrsl/web-search-mcp v0.3.2)     │
└───────────┬─────────────────────────────┬───────┘
            │                             │
            │ replace                     │ add
            ▼                             ▼
   ┌──────────────────┐          ┌──────────────────┐
   │  cloakbrowser    │          │  ProxyPool       │
   │  (npm package)   │◄─────────│  (new module)    │
   │                  │  proxy   │                  │
   │ - Stealth        │          │ - Webshare API   │
   │   Chromium       │          │ - In-memory list │
   │ - 48 C++ patches │          │ - Random rotate  │
   │ - Built-in proxy │          │ - 6h refresh     │
   │   support        │          │ - Failure skip   │
   └──────────────────┘          └──────────────────┘
            ▲
            │ launches per query (or per browser pool slot)
            │
   ┌────────┴─────────┐
   │  BrowserPool     │
   │  (modified)      │
   └──────────────────┘
            ▲
   ┌────────┴─────────┐
   │  SearchEngine    │
   │  (modified)      │
   └──────────────────┘
```

## Components

### 1. `src/proxy-pool.ts` (NEW)

**Purpose:** Single source of truth for current Webshare proxies.

**Public API:**
```typescript
class ProxyPool {
  constructor(opts: { token?: string; refreshHours?: number; countryFilter?: string[] });
  async init(): Promise<void>;
  async getRandomProxy(): Promise<ProxyConfig | null>; // null if no token / disabled
  markFailed(proxy: ProxyConfig): void;
  isEnabled(): boolean;
}
```

**Behavior:**
- If `WEBSHARE_API_TOKEN` env var is unset → `isEnabled()` returns `false`, all `getRandomProxy()` calls return `null` (passthrough mode = original mrkrsl behavior).
- On `init()`: fetch proxy list via Webshare REST API (`GET /api/v2/proxy/list/?mode=direct&page_size=100`), filter by `valid: true` and `PROXY_COUNTRY_FILTER` if set.
- On `getRandomProxy()`: pick uniformly random from healthy list; return as `{server: "http://ip:port", username, password}`.
- On `markFailed(proxy)`: temp-blacklist for 5 minutes (in-memory Map).
- Background timer refreshes list every `PROXY_REFRESH_HOURS` (default 6).
- Self-contained: no external dependencies beyond `node-fetch`/native fetch.

### 2. `src/browser-pool.ts` (MODIFIED)

**Changes:**
- Replace: `import { chromium, firefox } from 'playwright'` → `import { launch } from 'cloakbrowser'`
- Remove Firefox launch path (`firefox.launch(...)`) — CloakBrowser is Chromium-only.
- Inject a `ProxyPool` instance into the constructor.
- On each browser launch, call `proxyPool.getRandomProxy()` and pass to `launch()`:
  ```typescript
  const proxy = await this.proxyPool.getRandomProxy();
  const browser = await launch({
    headless: true,
    proxy: proxy ? { server: proxy.server, username: proxy.username, password: proxy.password } : undefined,
    geoip: !!proxy,  // auto-sync timezone/locale to proxy IP
  });
  ```
- On launch failure → call `proxyPool.markFailed(proxy)` and retry once with a different proxy.
- Browser pool size: respect existing `MAX_BROWSERS` env var (default 3).

### 3. `src/search-engine.ts` (MODIFIED)

**Changes:**
- Drop the `tryBrowserBraveSearch` Firefox-only path; merge into single Chromium path with proxy.
- Bing/Brave/DDG fallback chain stays the same — CloakBrowser handles all three on Chromium.
- Re-add original Bing selectors (`.b_algo`, `.b_result`, `.b_card`); they work fine when results aren't a CAPTCHA page.
- Behavior identical to original from caller's perspective.

### 4. `package.json` (MODIFIED)

- Rename: `web-search-mcp-server` → `web-search-mcp-cloak`
- Add deps: `cloakbrowser ^latest`, `playwright-core` (peer of cloakbrowser)
- Remove dep: `playwright` (replaced by `cloakbrowser` + `playwright-core`)
- Update `bin` and `homepage` URLs to new repo
- Bump version to `0.4.0` (signals breaking change from v0.3.x)

### 5. `README.md` (REWRITTEN)

Sections:
1. **Hero** — explains the fork: "What changed vs upstream"
2. **Why** — the CAPTCHA problem, the fix
3. **Install** — clone, `npm install`, `npm run build`
4. **LM Studio config** — exact `mcp.json` snippet
5. **Webshare setup** — how to get a token (with screenshots optional)
6. **Configuration** — all env vars
7. **Without Webshare** — note that it works without proxy too (just less reliable)
8. **Credits** — link to mrkrsl/web-search-mcp, MIT license preserved
9. **License** — MIT (unchanged)

### 6. `.env.example` (NEW)
```
# Optional — enables Webshare rotating proxy support
WEBSHARE_API_TOKEN=

# Optional — proxy refresh cadence (default 6 hours)
PROXY_REFRESH_HOURS=6

# Optional — comma-separated ISO country codes (e.g., "US,SG,JP")
PROXY_COUNTRY_FILTER=

# All original mrkrsl env vars still supported
MAX_CONTENT_LENGTH=10000
DEFAULT_TIMEOUT=10000
MAX_BROWSERS=3
FORCE_MULTI_ENGINE_SEARCH=false
ENABLE_RELEVANCE_CHECKING=true
RELEVANCE_THRESHOLD=0.3
```

### 7. `.gitignore` (MODIFIED)

Add: `.env`, `*.log`, plus existing entries (`dist/`, `node_modules/`, etc.)

## Data Flow

```
LM Studio → MCP request → SearchEngine.search(query)
                           ↓
                    BrowserPool.getBrowser()
                           ↓
                    ProxyPool.getRandomProxy() ─→ {server, user, pass}
                           ↓
                    cloakbrowser.launch({proxy, geoip:true})
                           ↓
                    page.goto("bing.com/search?q=...")
                           ↓
                    parse .b_algo selectors → results
                           ↓
                    return SearchResult[]
```

## Error Handling

| Failure | Handling |
|---------|----------|
| `WEBSHARE_API_TOKEN` missing | Run in passthrough mode (no proxy), log warning once |
| Webshare API unreachable on init | Log error, continue in passthrough mode, retry on next refresh interval |
| Single proxy times out | `markFailed()` it, retry once with another proxy |
| All proxies fail | Fall back to no-proxy mode for this query, log error |
| CloakBrowser binary download fails | Throw on first launch; user retries (auto-cached) |
| Bing still returns CAPTCHA despite stealth+proxy | Log a warning; existing Brave/DDG fallbacks kick in |

## Testing

**Unit-ish (manual smoke):**
- `npm run build` succeeds
- Launch server with no env vars → original behavior preserved (passthrough)
- Launch server with `WEBSHARE_API_TOKEN` → ProxyPool initializes, list non-empty
- ProxyPool returns different IPs across 5 calls

**Integration (live test):**
1. Wire into LM Studio `mcp.json` with `WEBSHARE_API_TOKEN`
2. Run 3 queries that previously returned 0 results
3. Verify each returns ≥3 actual results from Bing
4. Run 10 more queries in rapid succession (no CAPTCHA recurrence = success)
5. Inspect LM Studio logs: confirm proxy rotation, no `class="captcha"` in fetched HTML

**Pass criteria:**
- ≥80% of test queries return ≥3 results
- No CAPTCHA pages in logs across 10+ consecutive queries
- Proxy IP visibly rotates across requests

## Security

- `WEBSHARE_API_TOKEN` is **read from env only**, never logged, never written to source
- `.env` is gitignored
- Pre-push check: `git log --all -p | grep -E "WEBSHARE|peeq55"` must return zero matches
- README explicitly documents that users supply their own token; no real token in any commit

## Future Work (not in this scope)

- Publish to npm as `@scp120/web-search-mcp-cloak`
- PR upstream to mrkrsl
- Support residential proxy backends (Bright Data, Oxylabs)
- Add more search engines (Mojeek, Startpage, Kagi)
- Telemetry: per-engine success rate metrics
- Persistent profile mode for sites needing logged-in state

## Open Questions

None at design time. Will resurface during implementation if encountered.
