/**
 * ProxyPool — Webshare API client with random rotation, in-memory cache,
 * failure blacklisting, and periodic refresh.
 *
 * Behavior:
 *   - If WEBSHARE_API_TOKEN is unset, isEnabled() returns false and
 *     getRandomProxy() always returns null (passthrough mode).
 *   - On init(), fetch up to 100 valid proxies from Webshare. Filter by
 *     PROXY_COUNTRY_FILTER if set (CSV ISO codes like "US,SG").
 *   - getRandomProxy() picks a uniformly random non-blacklisted proxy.
 *   - markFailed(proxy) blacklists it for FAILURE_TTL_MS.
 *   - Background timer refreshes the list every PROXY_REFRESH_HOURS.
 */

export interface ProxyConfig {
  server: string; // e.g., "http://1.2.3.4:7230"
  username: string;
  password: string;
  countryCode?: string;
}

interface WebshareProxyEntry {
  id: string;
  username: string;
  password: string;
  proxy_address: string;
  port: number;
  valid: boolean;
  country_code: string;
}

interface WebshareListResponse {
  count: number;
  results: WebshareProxyEntry[];
}

const FAILURE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class ProxyPool {
  private readonly token?: string;
  private readonly refreshHours: number;
  private readonly countryFilter?: string[];

  private proxies: ProxyConfig[] = [];
  private blacklist: Map<string, number> = new Map(); // server -> expiry
  private refreshTimer?: NodeJS.Timeout;
  private initialized = false;

  constructor(opts?: { token?: string; refreshHours?: number; countryFilter?: string[] }) {
    this.token = opts?.token ?? process.env.WEBSHARE_API_TOKEN;
    this.refreshHours = opts?.refreshHours ?? parseFloat(process.env.PROXY_REFRESH_HOURS || '6');
    const cf = opts?.countryFilter ?? (process.env.PROXY_COUNTRY_FILTER || '').trim();
    if (Array.isArray(cf)) {
      this.countryFilter = cf.length > 0 ? cf : undefined;
    } else if (cf) {
      this.countryFilter = cf.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    }
  }

  isEnabled(): boolean {
    return !!this.token;
  }

  async init(): Promise<void> {
    if (!this.isEnabled()) {
      console.error('[ProxyPool] WEBSHARE_API_TOKEN not set — running in passthrough mode (no proxy)');
      this.initialized = true;
      return;
    }

    try {
      await this.refresh();
      this.scheduleRefresh();
      this.initialized = true;
      console.error(`[ProxyPool] Initialized with ${this.proxies.length} proxies (refresh every ${this.refreshHours}h)`);
    } catch (err) {
      console.error('[ProxyPool] Init failed; will retry on next interval:', err);
      this.scheduleRefresh();
      this.initialized = true; // mark initialized so callers don't block
    }
  }

  async refresh(): Promise<void> {
    if (!this.token) return;
    const url = 'https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100';
    const res = await fetch(url, {
      headers: { Authorization: `Token ${this.token}` },
    });
    if (!res.ok) {
      throw new Error(`Webshare API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as WebshareListResponse;
    let entries = data.results.filter(p => p.valid);
    if (this.countryFilter && this.countryFilter.length > 0) {
      entries = entries.filter(p => this.countryFilter!.includes(p.country_code.toUpperCase()));
    }
    this.proxies = entries.map(p => ({
      server: `http://${p.proxy_address}:${p.port}`,
      username: p.username,
      password: p.password,
      countryCode: p.country_code,
    }));
    // Drop expired blacklist entries
    const now = Date.now();
    for (const [k, exp] of this.blacklist.entries()) {
      if (exp <= now) this.blacklist.delete(k);
    }
    console.error(`[ProxyPool] Refreshed: ${this.proxies.length} healthy proxies (${data.count} total reported by Webshare)`);
  }

  async getRandomProxy(): Promise<ProxyConfig | null> {
    if (!this.isEnabled()) return null;
    if (!this.initialized) await this.init();
    const now = Date.now();
    const healthy = this.proxies.filter(p => {
      const exp = this.blacklist.get(p.server);
      return !exp || exp <= now;
    });
    if (healthy.length === 0) {
      console.error('[ProxyPool] No healthy proxies available — falling back to passthrough for this request');
      return null;
    }
    return healthy[Math.floor(Math.random() * healthy.length)];
  }

  markFailed(proxy: ProxyConfig): void {
    this.blacklist.set(proxy.server, Date.now() + FAILURE_TTL_MS);
    console.error(`[ProxyPool] Marked ${proxy.server} as failed (blacklisted ${FAILURE_TTL_MS / 1000}s)`);
  }

  size(): number {
    return this.proxies.length;
  }

  async shutdown(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    const ms = this.refreshHours * 60 * 60 * 1000;
    this.refreshTimer = setInterval(() => {
      this.refresh().catch(err => console.error('[ProxyPool] Refresh failed:', err));
    }, ms);
    // Don't keep the process alive just for the refresh timer
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }
}
