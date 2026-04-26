import { launch } from 'cloakbrowser';
import type { Browser } from 'playwright-core';
import { ProxyPool, type ProxyConfig } from './proxy-pool.js';

/** Heuristic: was this launch failure caused by the proxy itself? */
function isProxyError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('proxy') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('tunnel') ||
    msg.includes('ssl') ||
    msg.includes('407') // proxy auth required
  );
}

/**
 * BrowserPool — wraps cloakbrowser launches with Webshare proxy rotation.
 *
 * Differences vs upstream mrkrsl:
 *   - Uses cloakbrowser (stealth Chromium) instead of raw playwright
 *   - Drops Firefox/WebKit paths (cloakbrowser is Chromium-only)
 *   - Each launched browser gets a fresh random proxy from ProxyPool
 *   - On launch failure, marks the proxy as failed and retries once
 *   - Sets geoip:true so timezone/locale auto-match the proxy IP
 */
export class BrowserPool {
  private browsers: Browser[] = [];
  private maxBrowsers: number;
  private headless: boolean;
  private proxyPool: ProxyPool;
  private lastUsedBrowserType: string = 'cloakbrowser';

  constructor(proxyPool?: ProxyPool) {
    this.maxBrowsers = parseInt(process.env.MAX_BROWSERS || '3', 10);
    this.headless = process.env.BROWSER_HEADLESS !== 'false';
    this.proxyPool = proxyPool ?? new ProxyPool();
    console.error(
      `[BrowserPool] Configuration: maxBrowsers=${this.maxBrowsers}, ` +
      `headless=${this.headless}, engine=cloakbrowser, ` +
      `proxy=${this.proxyPool.isEnabled() ? 'webshare-rotating' : 'off'}`
    );
  }

  async ensureProxyPoolReady(): Promise<void> {
    if (this.proxyPool.isEnabled()) {
      await this.proxyPool.init();
    }
  }

  async getBrowser(): Promise<Browser> {
    // Reuse a connected browser if available
    for (const b of this.browsers) {
      try {
        if (b.isConnected()) return b;
      } catch {
        // fall through to launch
      }
    }

    return await this.launchWithProxy();
  }

  /**
   * Force a fresh browser for a new query — useful when caller wants
   * fresh IP per search. mrkrsl's existing call sites use getBrowser() so
   * this is opt-in.
   */
  async getFreshBrowser(): Promise<Browser> {
    return await this.launchWithProxy();
  }

  /**
   * Launch an EPHEMERAL browser the caller is responsible for closing.
   * Not tracked in the pool. Used by per-query Bing/Brave dedicated browsers.
   */
  async launchEphemeral(): Promise<Browser> {
    return await this.launchEphemeralInner(false);
  }

  private async launchEphemeralInner(retried: boolean): Promise<Browser> {
    const proxy = await this.proxyPool.getRandomProxy();
    const launchOpts = this.buildLaunchOptions(proxy);
    try {
      const browser = await launch(launchOpts);
      if (proxy) {
        console.error(`[BrowserPool] Ephemeral cloakbrowser via proxy ${proxy.server} (${proxy.countryCode || '??'})`);
      }
      return browser;
    } catch (err) {
      if (proxy && isProxyError(err)) {
        this.proxyPool.markFailed(proxy);
        if (!retried) {
          console.error(`[BrowserPool] Ephemeral launch via ${proxy.server} failed (proxy error), retrying:`, (err as Error).message);
          return await this.launchEphemeralInner(true);
        }
      }
      throw err;
    }
  }

  private async launchWithProxy(retried = false): Promise<Browser> {
    const proxy = await this.proxyPool.getRandomProxy();
    const launchOpts = this.buildLaunchOptions(proxy);

    try {
      const browser = await launch(launchOpts);
      if (proxy) {
        console.error(`[BrowserPool] Launched cloakbrowser via proxy ${proxy.server} (${proxy.countryCode || '??'})`);
      } else {
        console.error('[BrowserPool] Launched cloakbrowser without proxy (passthrough)');
      }
      this.trackBrowser(browser);
      return browser;
    } catch (err) {
      if (proxy && isProxyError(err)) {
        this.proxyPool.markFailed(proxy);
        if (!retried) {
          console.error(`[BrowserPool] Launch via ${proxy.server} failed (proxy error), retrying with another proxy:`, (err as Error).message);
          return await this.launchWithProxy(true);
        }
      }
      throw err;
    }
  }

  private buildLaunchOptions(proxy: ProxyConfig | null): any {
    const opts: any = {
      headless: this.headless,
    };
    if (proxy) {
      opts.proxy = {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password,
      };
      // Auto-sync timezone/locale to proxy IP — improves stealth
      opts.geoip = true;
    }
    // Concrete proof in stderr: print the EXACT object passed to cloakbrowser.launch()
    // (with password masked). If proxy is null, this proves no proxy was applied.
    const debug = {
      headless: opts.headless,
      proxy: opts.proxy
        ? { server: opts.proxy.server, username: opts.proxy.username, password: '***' }
        : null,
      geoip: !!opts.geoip,
    };
    console.error(`[BrowserPool/PROOF] launch options →`, JSON.stringify(debug));
    return opts;
  }

  private trackBrowser(browser: Browser): void {
    this.browsers.push(browser);
    // Cap pool size — close oldest beyond cap
    while (this.browsers.length > this.maxBrowsers) {
      const old = this.browsers.shift();
      if (old) old.close().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    console.error(`[BrowserPool] Closing ${this.browsers.length} browsers`);
    await Promise.all(this.browsers.map(b => b.close().catch(() => undefined)));
    this.browsers = [];
    await this.proxyPool.shutdown();
  }

  getLastUsedBrowserType(): string {
    return this.lastUsedBrowserType;
  }
}
