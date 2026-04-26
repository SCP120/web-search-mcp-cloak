/**
 * Live proof that CloakBrowser is actually using the Webshare proxy.
 * Compares: home IP (no proxy) vs proxied IP (through Webshare).
 */
import { launch } from 'cloakbrowser';

const TOKEN = process.env.WEBSHARE_API_TOKEN;
if (!TOKEN) { console.error('Set WEBSHARE_API_TOKEN'); process.exit(1); }

// 1. Get a single proxy from Webshare
const r = await fetch('https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=3', {
  headers: { Authorization: `Token ${TOKEN}` },
});
const data = await r.json();
const p = data.results[0];
console.log(`\n📋 Picked proxy: ${p.proxy_address}:${p.port} (${p.country_code})`);

// 2. Verify with a normal HTTP request through the proxy first (no browser)
import { Agent, request } from 'undici';
const proxyUrl = `http://${p.username}:${p.password}@${p.proxy_address}:${p.port}`;
console.log(`\n🔬 Testing proxy at HTTP layer (curl-style)...`);
import { spawn } from 'child_process';
const curl = spawn('curl', [
  '-s', '--max-time', '10',
  '--proxy', proxyUrl,
  'https://httpbin.org/ip'
]);
let curlOut = ''; curl.stdout.on('data', d => curlOut += d);
await new Promise(res => curl.on('close', res));
console.log(`   curl says origin IP: ${curlOut.trim() || '(empty / failed)'}`);

// 3. Now launch CloakBrowser WITHOUT proxy
console.log(`\n🏠 Launching CloakBrowser WITHOUT proxy (your home IP)...`);
const noProxyBrowser = await launch({ headless: true });
const ctx1 = await noProxyBrowser.newContext();
const page1 = await ctx1.newPage();
await page1.goto('https://httpbin.org/ip', { timeout: 20000 });
const homeIp = JSON.parse(await page1.locator('body').innerText()).origin;
console.log(`   Browser sees home IP: ${homeIp}`);
await noProxyBrowser.close();

// 4. Launch CloakBrowser WITH proxy
console.log(`\n🌐 Launching CloakBrowser WITH proxy ${p.proxy_address}...`);
const proxiedBrowser = await launch({
  headless: true,
  proxy: {
    server: `http://${p.proxy_address}:${p.port}`,
    username: p.username,
    password: p.password,
  },
});
const ctx2 = await proxiedBrowser.newContext();
const page2 = await ctx2.newPage();
await page2.goto('https://httpbin.org/ip', { timeout: 30000 });
const proxiedIp = JSON.parse(await page2.locator('body').innerText()).origin;
console.log(`   Browser sees IP through proxy: ${proxiedIp}`);
await proxiedBrowser.close();

console.log(`\n========================`);
console.log(`Home IP:       ${homeIp}`);
console.log(`Webshare IP:   ${p.proxy_address}`);
console.log(`Browser saw:   ${proxiedIp}`);
console.log(`========================`);
if (proxiedIp === p.proxy_address) {
  console.log(`✅ PROXY IS CORRECTLY APPLIED — IP matches Webshare proxy exactly`);
} else if (proxiedIp !== homeIp) {
  console.log(`✅ PROXY IS APPLIED — different from home IP, just doesn't match (proxy may have outbound NAT)`);
} else {
  console.log(`❌ PROXY NOT APPLIED — browser used home IP despite config`);
}
