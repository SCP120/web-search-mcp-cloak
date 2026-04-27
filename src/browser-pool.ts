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
    msg.includes('407')
  );
}

/**
 * Simple FIFO semaphore. Caps concurrent browser launches across the whole MCP.
 * Without this, multi-engine search × concurrent queries spawns unbounded
 * headless_shell processes — which is what crashed the host.
 */
class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(public readonly capacity: number) {
    this.available = capacity;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>(resolve => this.waiters.push(resolve));
    this.available--;
  }

  release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }

  get inUse(): number {
    return this.capacity - this.available;
  }
}

/**
 * BrowserPool — wraps cloakbrowser launches with Webshare proxy rotation.
 *
 * Hardening (Layer 1, post-kernel-panic):
 *   - Global semaphore caps concurrent browsers (covers ephemerals too)
 *   - Every launched browser is tracked in `allBrowsers` for cleanup
 *   - closeAll() closes pooled AND in-flight ephemeral browsers
 *   - ensureSafetyHooks() registers exit handlers as a last-resort reaper
 */
export class BrowserPool {
  private browsers: Browser[] = [];
  private allBrowsers: Set<Browser> = new Set();
  private maxBrowsers: number;
  private headless: boolean;
  private proxyPool: ProxyPool;
  private semaphore: Semaphore;
  private hooksInstalled = false;

  constructor(proxyPool?: ProxyPool) {
    this.maxBrowsers = parseInt(process.env.MAX_BROWSERS || '2', 10);
    this.headless = process.env.BROWSER_HEADLESS !== 'false';
    this.proxyPool = proxyPool ?? new ProxyPool();
    this.semaphore = new Semaphore(this.maxBrowsers);
    this.installSafetyHooks();
    console.error(
      `[BrowserPool] Configuration: maxBrowsers=${this.maxBrowsers} (semaphore), ` +
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
    for (const b of this.browsers) {
      try {
        if (b.isConnected()) return b;
      } catch {
        // fall through
      }
    }
    return await this.launchWithProxy();
  }

  async getFreshBrowser(): Promise<Browser> {
    return await this.launchWithProxy();
  }

  /**
   * Launch an ephemeral browser the caller is responsible for closing.
   * Acquires the semaphore (caller MUST call browser.close() to release).
   * Tracked in `allBrowsers` so closeAll() can sweep it on shutdown.
   */
  async launchEphemeral(): Promise<Browser> {
    await this.semaphore.acquire();
    try {
      const browser = await this.launchEphemeralInner(false);
      this.trackForCleanup(browser);
      return browser;
    } catch (err) {
      this.semaphore.release();
      throw err;
    }
  }

  private async launchEphemeralInner(retried: boolean): Promise<Browser> {
    const proxy = await this.proxyPool.getRandomProxy();
    const launchOpts = this.buildLaunchOptions(proxy);
    try {
      const browser = await launch(launchOpts);
      if (proxy) {
        console.error(`[BrowserPool] Ephemeral cloakbrowser via proxy ${proxy.server} (${proxy.countryCode || '??'}) | inUse=${this.semaphore.inUse}/${this.semaphore.capacity}`);
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
    await this.semaphore.acquire();
    try {
      const proxy = await this.proxyPool.getRandomProxy();
      const launchOpts = this.buildLaunchOptions(proxy);
      try {
        const browser = await launch(launchOpts);
        if (proxy) {
          console.error(`[BrowserPool] Launched cloakbrowser via proxy ${proxy.server} (${proxy.countryCode || '??'}) | inUse=${this.semaphore.inUse}/${this.semaphore.capacity}`);
        } else {
          console.error('[BrowserPool] Launched cloakbrowser without proxy (passthrough)');
        }
        this.trackBrowser(browser);
        this.trackForCleanup(browser);
        return browser;
      } catch (err) {
        if (proxy && isProxyError(err)) {
          this.proxyPool.markFailed(proxy);
          if (!retried) {
            console.error(`[BrowserPool] Launch via ${proxy.server} failed (proxy error), retrying:`, (err as Error).message);
            this.semaphore.release();
            return await this.launchWithProxy(true);
          }
        }
        this.semaphore.release();
        throw err;
      }
    } catch (err) {
      throw err;
    }
  }

  /**
   * Wrap browser.close() so the semaphore is released and the browser is
   * untracked exactly once. Patched onto the instance — callers continue to
   * use `await browser.close()` normally.
   */
  private trackForCleanup(browser: Browser): void {
    this.allBrowsers.add(browser);
    const originalClose = browser.close.bind(browser);
    let released = false;

    const release = (reason: string) => {
      if (released) return;
      released = true;
      this.allBrowsers.delete(browser);
      this.semaphore.release();
      console.error(`[BrowserPool] released slot (${reason}) | inUse=${this.semaphore.inUse}/${this.semaphore.capacity}`);
    };

    browser.close = async (...args: unknown[]) => {
      // Race close() against a 5s deadline. If Chromium is wedged, fall back
      // to SIGKILL on the underlying process. Either way release the slot —
      // never let one stuck browser deadlock the whole MCP.
      const closePromise = (originalClose as (...a: unknown[]) => Promise<void>)(...args);
      try {
        await Promise.race([
          closePromise,
          new Promise<void>((_, rej) => setTimeout(() => rej(new Error('close() exceeded 5s')), 5000)),
        ]);
      } catch (err) {
        console.error(`[BrowserPool] graceful close failed (${(err as Error).message}); SIGKILL fallback`);
        try {
          const proc = (browser as any).process?.();
          if (proc && typeof proc.kill === 'function') {
            proc.kill('SIGKILL');
          }
        } catch { /* ignore */ }
      } finally {
        release('close()');
      }
    };

    // If the browser disconnects on its own (crash, killed externally), release too
    browser.on('disconnected', () => release('disconnected'));
  }

  private buildLaunchOptions(proxy: ProxyConfig | null): any {
    const opts: any = { headless: this.headless };
    if (proxy) {
      opts.proxy = {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password,
      };
      opts.geoip = true;
    }
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
    while (this.browsers.length > this.maxBrowsers) {
      const old = this.browsers.shift();
      if (old) old.close().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    const total = this.allBrowsers.size;
    console.error(`[BrowserPool] Closing ALL ${total} browsers (pooled + ephemeral)`);
    const browsers = Array.from(this.allBrowsers);
    this.browsers = [];
    this.allBrowsers.clear();
    await Promise.all(
      browsers.map(b =>
        Promise.race([
          b.close().catch(() => undefined),
          new Promise(resolve => setTimeout(resolve, 5000)),
        ])
      )
    );
    await this.proxyPool.shutdown();
  }

  /**
   * Last-resort: synchronous reaper on process exit. Sends SIGKILL to any
   * remaining headless_shell PIDs we know about. Async close() can't run on
   * the 'exit' event — only sync code.
   */
  private installSafetyHooks(): void {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    process.on('exit', () => {
      for (const browser of this.allBrowsers) {
        try {
          // playwright Browser exposes the underlying process via _connection in some builds;
          // best-effort SIGKILL via close() can't be awaited here. Just log.
          // Actual cleanup happens via SIGTERM/SIGINT handlers (see index.ts).
          const proc = (browser as any).process?.();
          if (proc && typeof proc.kill === 'function') {
            try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    });
  }

  getActiveCount(): number {
    return this.semaphore.inUse;
  }

  getLastUsedBrowserType(): string {
    return 'cloakbrowser';
  }
}
