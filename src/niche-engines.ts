/**
 * Niche search engines (JSON-API only, no headless browser).
 *
 * Three domains:
 *   - searchVulnerabilities  → OSV.dev + NVD (CVE / package vuln lookup)
 *   - searchMakeMoneyOnline  → HN Algolia + IndieHackers (revenue posts, side hustles)
 *   - searchGitHub           → GitHub Search API (OSS libs, microservices)
 *
 * All sub-second. No proxy needed. No browser overhead.
 */
import axios from 'axios';
import * as cheerio from 'cheerio';

const UA = 'web-search-mcp-cloak/0.5 (+https://github.com/SCP120/web-search-mcp-cloak)';

// ---------------------------------------------------------------------------
// Cybersecurity — OSV.dev + NVD
// ---------------------------------------------------------------------------

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  modified?: string;
  published?: string;
  references?: Array<{ type: string; url: string }>;
  affected?: Array<{ package?: { ecosystem?: string; name?: string } }>;
}

interface OsvQueryResponse {
  vulns?: OsvVuln[];
}

interface NvdCveItem {
  cve: {
    id: string;
    descriptions: Array<{ lang: string; value: string }>;
    metrics?: {
      cvssMetricV31?: Array<{ cvssData: { baseScore: number; baseSeverity: string } }>;
      cvssMetricV30?: Array<{ cvssData: { baseScore: number; baseSeverity: string } }>;
    };
    references?: Array<{ url: string }>;
    published?: string;
  };
}

interface NvdResponse {
  vulnerabilities?: NvdCveItem[];
}

export async function searchVulnerabilities(query: string, limit = 10): Promise<string> {
  console.error(`[NICHE] vulns: query="${query}" limit=${limit}`);
  const cveIdMatch = query.match(/CVE-\d{4}-\d+/i);

  // Strategy: if query contains a CVE-ID, hit NVD first (canonical record).
  // Otherwise, query OSV.dev for package-ecosystem search via free-text.
  if (cveIdMatch) {
    const cveId = cveIdMatch[0].toUpperCase();
    return await searchNvdById(cveId);
  }

  // OSV doesn't support free-text search well; use the bulk query endpoint
  // with `package` if a known ecosystem-prefix is detected, else fall back to
  // NVD keyword search.
  const ecoPkgMatch = query.match(/^(?:pypi|npm|go|cargo|maven|nuget|composer|ruby|gems)\s*[:/]\s*([\w@\-./]+)/i);
  if (ecoPkgMatch) {
    const [, pkgName] = ecoPkgMatch;
    const eco = query.match(/^(\w+)/)![1].toLowerCase();
    return await searchOsvByPackage(eco, pkgName, limit);
  }

  return await searchNvdByKeyword(query, limit);
}

async function searchOsvByPackage(ecosystem: string, name: string, limit: number): Promise<string> {
  const ecoMap: Record<string, string> = {
    pypi: 'PyPI', npm: 'npm', go: 'Go', cargo: 'crates.io',
    maven: 'Maven', nuget: 'NuGet', composer: 'Packagist',
    ruby: 'RubyGems', gems: 'RubyGems',
  };
  const ecoName = ecoMap[ecosystem] || ecosystem;

  const resp = await axios.post<OsvQueryResponse>(
    'https://api.osv.dev/v1/query',
    { package: { ecosystem: ecoName, name } },
    { headers: { 'User-Agent': UA }, timeout: 8000 },
  );

  const vulns = (resp.data.vulns || []).slice(0, limit);
  if (vulns.length === 0) {
    return `No vulnerabilities found for ${ecoName}/${name} on osv.dev.`;
  }

  const lines = [`# Vulnerabilities for **${ecoName}:${name}** (${vulns.length} found via osv.dev)\n`];
  for (const v of vulns) {
    lines.push(`## ${v.id}${v.aliases?.length ? ` (${v.aliases.join(', ')})` : ''}`);
    if (v.summary) lines.push(`**Summary:** ${v.summary}`);
    if (v.published) lines.push(`**Published:** ${v.published}`);
    if (v.details) lines.push(`\n${truncate(v.details, 600)}\n`);
    const refs = v.references?.slice(0, 3) || [];
    if (refs.length) {
      lines.push(`**References:**`);
      for (const r of refs) lines.push(`- ${r.url}`);
    }
    lines.push('\n---\n');
  }
  return lines.join('\n');
}

async function searchNvdById(cveId: string): Promise<string> {
  const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(cveId)}`;
  const resp = await axios.get<NvdResponse>(url, { headers: { 'User-Agent': UA }, timeout: 8000 });
  const items = resp.data.vulnerabilities || [];
  if (items.length === 0) return `No record for ${cveId} on nvd.nist.gov.`;
  return formatNvdItems(items);
}

async function searchNvdByKeyword(keyword: string, limit: number): Promise<string> {
  const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(keyword)}&resultsPerPage=${Math.min(limit, 20)}`;
  const resp = await axios.get<NvdResponse>(url, { headers: { 'User-Agent': UA }, timeout: 10000 });
  const items = (resp.data.vulnerabilities || []).slice(0, limit);
  if (items.length === 0) return `No CVEs found for "${keyword}" on nvd.nist.gov.`;
  return formatNvdItems(items, keyword);
}

function formatNvdItems(items: NvdCveItem[], keyword?: string): string {
  const heading = keyword
    ? `# CVEs matching "${keyword}" (${items.length} from nvd.nist.gov)\n`
    : `# CVE record (${items.length} item(s) from nvd.nist.gov)\n`;
  const lines = [heading];
  for (const item of items) {
    const cve = item.cve;
    const desc = cve.descriptions.find(d => d.lang === 'en')?.value || '(no description)';
    const cvss = cve.metrics?.cvssMetricV31?.[0]?.cvssData
              || cve.metrics?.cvssMetricV30?.[0]?.cvssData;
    lines.push(`## ${cve.id}${cvss ? ` — CVSS ${cvss.baseScore} (${cvss.baseSeverity})` : ''}`);
    if (cve.published) lines.push(`**Published:** ${cve.published.slice(0, 10)}`);
    lines.push(`\n${truncate(desc, 700)}\n`);
    const refs = cve.references?.slice(0, 3) || [];
    if (refs.length) {
      lines.push(`**References:**`);
      for (const r of refs) lines.push(`- ${r.url}`);
    }
    lines.push('\n---\n');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Make money online — Hacker News (Algolia) + IndieHackers
// ---------------------------------------------------------------------------

interface HnHit {
  objectID: string;
  title?: string;
  story_title?: string;
  url?: string;
  story_url?: string;
  author?: string;
  points?: number;
  num_comments?: number;
  created_at?: string;
  _highlightResult?: {
    title?: { value: string };
    story_text?: { value: string };
  };
  story_text?: string;
}

interface HnResponse {
  hits: HnHit[];
  nbHits: number;
}

export async function searchMakeMoneyOnline(query: string, limit = 10): Promise<string> {
  console.error(`[NICHE] mmo: query="${query}" limit=${limit}`);
  // Run HN search and IndieHackers scrape in parallel
  const [hnText, ihText] = await Promise.allSettled([
    searchHackerNews(query, Math.min(limit, 8)),
    searchIndieHackers(query, Math.min(limit, 5)),
  ]);

  const out: string[] = [`# Make-money-online search: "${query}"\n`];
  if (hnText.status === 'fulfilled') out.push(hnText.value);
  else out.push(`## Hacker News\n_(failed: ${(hnText.reason as Error).message})_\n`);

  if (ihText.status === 'fulfilled') out.push(ihText.value);
  else out.push(`## IndieHackers\n_(failed: ${(ihText.reason as Error).message})_\n`);

  return out.join('\n');
}

async function searchHackerNews(query: string, limit: number): Promise<string> {
  // Algolia HN API — relevance ranked, free, unauth, returns JSON.
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${limit}&tags=story`;
  const resp = await axios.get<HnResponse>(url, { headers: { 'User-Agent': UA }, timeout: 6000 });
  const hits = resp.data.hits || [];
  if (hits.length === 0) return `## Hacker News\nNo posts found for "${query}".\n`;

  const lines = [`## Hacker News (${hits.length} of ${resp.data.nbHits} matching, sorted by relevance)\n`];
  for (const h of hits) {
    const title = h.title || h.story_title || '(no title)';
    const url = h.url || h.story_url || `https://news.ycombinator.com/item?id=${h.objectID}`;
    const points = h.points ?? 0;
    const comments = h.num_comments ?? 0;
    const date = h.created_at ? h.created_at.slice(0, 10) : '?';
    lines.push(`### ${title}`);
    lines.push(`- **${points} points · ${comments} comments · ${date}** by ${h.author || '?'}`);
    lines.push(`- URL: ${url}`);
    lines.push(`- HN thread: https://news.ycombinator.com/item?id=${h.objectID}`);
    if (h.story_text) {
      // strip HTML tags from story_text
      const plain = h.story_text.replace(/<[^>]+>/g, '').trim();
      if (plain.length > 30) lines.push(`\n  ${truncate(plain, 350)}\n`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function searchIndieHackers(query: string, limit: number): Promise<string> {
  // IndieHackers HTML scrape. Their site uses Next.js SSR so server-rendered
  // results are present in initial HTML.
  try {
    const url = `https://www.indiehackers.com/search?q=${encodeURIComponent(query)}`;
    const resp = await axios.get<string>(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 8000,
      responseType: 'text',
    });
    const $ = cheerio.load(resp.data);
    const results: { title: string; url: string; snippet: string }[] = [];
    // Try multiple selectors for IndieHackers result cards
    const selectors = [
      'a.search-result-link',
      'a[href*="/post/"]',
      'a[href*="/product/"]',
      '.search-result',
    ];
    for (const sel of selectors) {
      $(sel).each((_, el) => {
        if (results.length >= limit) return false;
        const $el = $(el);
        const href = $el.attr('href') || '';
        const title = $el.text().trim().split('\n')[0].trim();
        if (!title || !href) return;
        const fullUrl = href.startsWith('http') ? href : `https://www.indiehackers.com${href}`;
        const snippet = $el.find('.snippet, .description, p').first().text().trim();
        if (results.find(r => r.url === fullUrl)) return;
        results.push({ title: title.slice(0, 200), url: fullUrl, snippet });
      });
      if (results.length > 0) break;
    }

    if (results.length === 0) return `## IndieHackers\nNo results parsed for "${query}" (page may need login or selectors changed).\n`;

    const lines = [`## IndieHackers (${results.length} results)\n`];
    for (const r of results) {
      lines.push(`### ${r.title}`);
      lines.push(`- URL: ${r.url}`);
      if (r.snippet) lines.push(`  ${truncate(r.snippet, 250)}`);
      lines.push('');
    }
    return lines.join('\n');
  } catch (err) {
    return `## IndieHackers\n_(failed: ${(err as Error).message})_\n`;
  }
}

// ---------------------------------------------------------------------------
// GitHub Search — repos
// ---------------------------------------------------------------------------

interface GhRepoItem {
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  updated_at: string;
  topics?: string[];
  archived?: boolean;
}

interface GhSearchResponse {
  total_count: number;
  items: GhRepoItem[];
}

export async function searchGitHub(
  query: string,
  opts: { language?: string; topic?: string; sort?: 'stars' | 'updated'; limit?: number } = {},
): Promise<string> {
  const { language, topic, sort = 'stars', limit = 10 } = opts;
  console.error(`[NICHE] github: query="${query}" lang=${language} topic=${topic} sort=${sort} limit=${limit}`);

  // Build q with qualifiers
  const parts = [query];
  if (language) parts.push(`language:${language}`);
  if (topic) parts.push(`topic:${topic}`);
  const q = parts.join(' ');

  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=desc&per_page=${Math.min(limit, 30)}`;
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  // Use GITHUB_TOKEN if provided — bumps from 60/hr to 5000/hr
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const resp = await axios.get<GhSearchResponse>(url, { headers, timeout: 8000 });
  const items = resp.data.items || [];
  if (items.length === 0) return `No GitHub repositories matching "${q}".`;

  const lines = [
    `# GitHub Search: \`${q}\` (${items.length} of ${resp.data.total_count} matches, sorted by ${sort})\n`,
  ];
  for (const r of items.slice(0, limit)) {
    lines.push(`## ${r.full_name}${r.archived ? ' _(archived)_' : ''}`);
    lines.push(`- **${r.stargazers_count}** ⭐ · **${r.forks_count}** forks · ${r.language || 'unknown'} · updated ${r.updated_at.slice(0, 10)}`);
    lines.push(`- URL: ${r.html_url}`);
    if (r.topics?.length) lines.push(`- Topics: \`${r.topics.slice(0, 6).join('\`, \`')}\``);
    if (r.description) lines.push(`\n  ${truncate(r.description, 350)}\n`);
    lines.push('---\n');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + '…';
}
