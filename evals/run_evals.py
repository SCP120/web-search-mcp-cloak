#!/usr/bin/env python3
"""Web-search-cloak MCP eval harness.

Runs 10 queries from queries.yaml against the MCP and scores each on:
  - did the MCP return >= min_results?
  - do URLs contain expected hosts (any-of)?
  - do URLs avoid forbidden patterns (e.g. bing.com/ck/a redirects)?
  - latency under max?

Outputs:
  evals/artifacts/run-{timestamp}/summary.md
  evals/artifacts/run-{timestamp}/results.json

Modes:
  --mode direct   (default) — drive MCP-via-Docker via stdio, no LM Studio
  --mode lmstudio — call LM Studio /api/v1/chat with mcp/web-search-cloak integration
                    (requires "Allow calling servers from mcp.json" toggle ON in LM Studio)
"""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import yaml  # type: ignore
except ImportError:
    print("yaml missing — install with: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

REPO = Path(__file__).resolve().parent.parent
QUERIES_FILE = Path(__file__).resolve().parent / "queries.yaml"
ARTIFACTS_ROOT = Path(__file__).resolve().parent / "artifacts"

DOCKER_CMD = [
    "docker", "run", "-i", "--rm", "--init",
    "-e", "WEBSHARE_API_TOKEN",
    "-e", "MAX_CONTENT_LENGTH",
    "-e", "DEFAULT_TIMEOUT",
    "-e", "MAX_BROWSERS",
    "-e", "FORCE_MULTI_ENGINE_SEARCH",
    "-e", "ENABLE_RELEVANCE_CHECKING",
    "-e", "RELEVANCE_THRESHOLD",
    "web-search-mcp-cloak:latest",
]
DOCKER_ENV = {
    "WEBSHARE_API_TOKEN": os.environ.get("WEBSHARE_API_TOKEN", ""),
    "MAX_CONTENT_LENGTH": "5000",
    "DEFAULT_TIMEOUT": "90000",
    "MAX_BROWSERS": "2",
    # Don't force multi-engine in evals — Bing returns quality 1.0 on most
    # queries; running Brave+DDG after that is wasted time and causes
    # accumulated-latency timeouts under concurrency.
    "FORCE_MULTI_ENGINE_SEARCH": "false",
    "ENABLE_RELEVANCE_CHECKING": "true",
    "RELEVANCE_THRESHOLD": "0.1",
}

URL_RE = re.compile(r"URL:\s*(\S+)", re.IGNORECASE)
ANY_URL_RE = re.compile(r"https?://[^\s)\]>\"']+")

# LM Studio API
LM_API_URL = "http://localhost:1234/api/v1/chat"
LM_API_TOKEN = os.environ.get("LM_API_TOKEN", "")
LM_MODEL = os.environ.get("LM_MODEL", "glm-4.7-flash-uncensored-heretic-neo-code-imatrix-max")


# ---------------------------------------------------------------------------
# Direct-mode driver (MCP via Docker stdio)
# ---------------------------------------------------------------------------
class McpClient:
    def __init__(self, stderr_path: str | None = None):
        env = os.environ.copy(); env.update(DOCKER_ENV)
        stderr_target = open(stderr_path, "w") if stderr_path else subprocess.DEVNULL
        self.p = subprocess.Popen(
            DOCKER_CMD,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=stderr_target,
            env=env, text=True, bufsize=1,
        )
        self._next_id = 1
        self._init()

    def _send(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()

    def _read(self, timeout):
        import select
        deadline = time.time() + timeout
        while time.time() < deadline:
            rl, _, _ = select.select([self.p.stdout], [], [], 1.0)
            if rl:
                line = self.p.stdout.readline()
                if not line:
                    return None
                try:
                    return json.loads(line)
                except Exception:
                    continue
        return None

    def _init(self):
        self._send({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05",
                       "capabilities": {},
                       "clientInfo": {"name": "evals", "version": "1"}},
        })
        # wait for init response
        self._read(15)
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def search(self, query, limit=5, timeout=120):
        self._next_id += 1
        rid = self._next_id
        self._send({
            "jsonrpc": "2.0", "id": rid, "method": "tools/call",
            "params": {"name": "get-web-search-summaries",
                       "arguments": {"query": query, "limit": limit}},
        })
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = self._read(timeout=deadline - time.time())
            if msg is None:
                return None
            if msg.get("id") == rid:
                content = msg.get("result", {}).get("content", [])
                text = content[0].get("text", "") if content else ""
                return text
        return None

    def close(self):
        try:
            self.p.terminate(); self.p.wait(timeout=10)
        except Exception:
            self.p.kill(); self.p.wait()


def parse_urls(text: str) -> list[str]:
    return URL_RE.findall(text or "")


# ---------------------------------------------------------------------------
# LM Studio mode driver — POST /api/v1/chat with mcp/web-search-cloak integration
# ---------------------------------------------------------------------------
class LmStudioClient:
    """Drives LM Studio's /api/v1/chat with the MCP integration.

    Returns a structured result per query:
      {
        "tool_calls": [{"tool": ..., "args": ..., "output_text": ...}, ...],
        "assistant_text": "...",
        "raw": <full response>,
      }
    """

    def __init__(self):
        import urllib.request  # noqa: F401
        # quick auth probe
        ok, msg = self._probe()
        if not ok:
            raise RuntimeError(f"LM Studio API not reachable / authorized: {msg}")

    def _probe(self):
        import urllib.request, urllib.error
        req = urllib.request.Request(
            "http://localhost:1234/v1/models",
            headers={"Authorization": f"Bearer {LM_API_TOKEN}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return True, resp.status
        except urllib.error.HTTPError as e:
            return False, f"HTTP {e.code}"
        except Exception as e:
            return False, str(e)

    def search(self, query: str, limit: int = 5, timeout: int = 240):
        """Send a natural-language prompt to the model with MCP enabled."""
        # Tell model to use the LIGHTWEIGHT tool (snippets only, no page fetch).
        # full-web-search fetches each result's full content which makes evals
        # take 80s+ per query.
        prompt = (
            f"Search the web for: {query}\n\n"
            f"Use ONLY the `get-web-search-summaries` tool from web-search-cloak "
            f"(NOT `full-web-search`). Limit to {limit} results.\n"
            f"After the tool returns, list the top URLs verbatim and a one-line "
            f"summary."
        )
        payload = {
            "model": LM_MODEL,
            "input": prompt,
            "integrations": ["mcp/web-search-cloak"],
            "context_length": 8000,
        }
        body = json.dumps(payload).encode("utf-8")
        proc = subprocess.run(
            ["curl", "-sN", "-X", "POST", LM_API_URL,
             "-H", f"Authorization: Bearer {LM_API_TOKEN}",
             "-H", "Content-Type: application/json",
             "-d", body.decode("utf-8")],
            capture_output=True, text=True, timeout=timeout,
        )
        return self._parse_response(proc.stdout)

    @staticmethod
    def _parse_response(stdout: str):
        tool_calls = []
        assistant_text = []
        raw_obj = None

        # Try whole-body JSON first (non-streaming)
        body = stdout.strip()
        if body.startswith("{"):
            try:
                raw_obj = json.loads(body)
                # Look for "output" array (LM Studio shape)
                for item in raw_obj.get("output", []) or []:
                    t = item.get("type")
                    if t == "tool_call":
                        out = item.get("output")
                        out_text = out if isinstance(out, str) else json.dumps(out, default=str)
                        tool_calls.append({
                            "tool": item.get("tool") or item.get("name"),
                            "args": item.get("arguments"),
                            "output_text": out_text or "",
                            "provider_info": item.get("provider_info"),
                        })
                    elif t == "message":
                        c = item.get("content")
                        if isinstance(c, str):
                            assistant_text.append(c)
                        elif isinstance(c, list):
                            for cc in c:
                                if isinstance(cc, dict) and cc.get("type") == "text":
                                    assistant_text.append(cc.get("text", ""))
                # Sometimes response is plain { error: ... }
                if "error" in raw_obj and not tool_calls and not assistant_text:
                    return {
                        "tool_calls": [], "assistant_text": "",
                        "error": raw_obj.get("error"),
                        "raw": raw_obj,
                    }
            except Exception:
                raw_obj = None

        # Try line-by-line JSONL fallback
        if not tool_calls and not assistant_text:
            for line in stdout.splitlines():
                line = line.strip()
                if not line or not line.startswith("{"):
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                t = msg.get("type")
                if t == "tool_call":
                    out = msg.get("output")
                    out_text = out if isinstance(out, str) else json.dumps(out, default=str)
                    tool_calls.append({
                        "tool": msg.get("tool"),
                        "args": msg.get("arguments"),
                        "output_text": out_text or "",
                    })
                elif t == "message":
                    c = msg.get("content")
                    if isinstance(c, str):
                        assistant_text.append(c)

        return {
            "tool_calls": tool_calls,
            "assistant_text": "\n".join(assistant_text),
            "raw": raw_obj,
        }

    def close(self):
        pass


def evaluate_query(spec, response_text, latency, *, lmstudio_extras=None):
    """Score one query.

    response_text: string containing URLs (direct mode = MCP raw output;
                   lmstudio mode = tool_call output + assistant text combined).
    lmstudio_extras: dict with extra checks for lmstudio mode.
    """
    # In direct mode the response text is the MCP's "URL: ..." block;
    # in lmstudio mode it's tool_call output + assistant message combined.
    urls = parse_urls(response_text)
    if not urls:
        # Fall back to extracting bare URLs from anywhere in the text.
        urls = ANY_URL_RE.findall(response_text or "")
    pass_spec = spec.get("pass", {})
    min_results = pass_spec.get("min_results", 0)
    allow_zero = pass_spec.get("allow_zero", False)
    expect_any = [s.lower() for s in pass_spec.get("expect_url_contains", [])]
    forbid_any = [s.lower() for s in pass_spec.get("forbid_url_contains", [])]
    # In lmstudio mode the loop is much longer (model + MCP + model again),
    # so latency budgets need to be 3-4x higher.
    default_latency = 300 if lmstudio_extras is not None else 120
    max_latency = pass_spec.get("max_latency_seconds", default_latency)
    if lmstudio_extras is not None and "max_latency_seconds" in pass_spec:
        max_latency = max(max_latency, 300)

    checks = {}
    checks["count"] = (
        ("ok", f"{len(urls)} >= {min_results}")
        if (len(urls) >= min_results or (allow_zero and len(urls) == 0))
        else ("fail", f"got {len(urls)}, want >= {min_results}")
    )
    if expect_any:
        hit = any(any(x in u.lower() for x in expect_any) for u in urls)
        checks["expect_url"] = (
            ("ok", f"at least one URL matches {expect_any}")
            if hit else ("fail", f"no URL matched any of {expect_any}")
        )
    if forbid_any:
        bad = [u for u in urls if any(x in u.lower() for x in forbid_any)]
        checks["forbid_url"] = (
            ("ok", "no forbidden patterns")
            if not bad else ("fail", f"forbidden URL leaked: {bad[:3]}")
        )
    checks["latency"] = (
        ("ok", f"{latency:.1f}s <= {max_latency}s")
        if latency <= max_latency
        else ("fail", f"{latency:.1f}s > {max_latency}s")
    )

    # LM Studio specific: was the MCP actually invoked?
    if lmstudio_extras is not None:
        tool_calls = lmstudio_extras.get("tool_calls", [])
        called_mcp = any(
            "web-search-cloak" in str(tc.get("tool", ""))
            or "search" in str(tc.get("tool", "")).lower()
            for tc in tool_calls
        )
        checks["mcp_invoked"] = (
            ("ok", f"{len(tool_calls)} tool call(s)")
            if called_mcp else
            ("fail", f"no web-search-cloak tool_call (got {len(tool_calls)} calls)")
        )

    overall_pass = all(v[0] == "ok" for v in checks.values())
    return overall_pass, checks, urls


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["direct", "lmstudio"], default="direct")
    ap.add_argument("--limit", type=int, default=5, help="results per query")
    ap.add_argument("--queries", type=str, default=str(QUERIES_FILE),
                    help="path to queries yaml")
    ap.add_argument("--fresh-per-query", action="store_true",
                    help="DANGEROUS — spawns a new docker container per query. Stresses Docker Desktop's VM under "
                         "rapid churn (caused a kernel-watchdog panic in testing). Default persistent client is safe.")
    args = ap.parse_args()

    queries = yaml.safe_load(Path(args.queries).read_text())
    print(f"[evals] loaded {len(queries)} queries from {args.queries}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    run_dir = ARTIFACTS_ROOT / f"run-{timestamp}-{args.mode}"
    run_dir.mkdir(parents=True, exist_ok=True)

    client = None
    if args.mode == "direct":
        stderr_path = str(run_dir / "mcp_stderr.log")
        if args.fresh_per_query:
            print(f"[evals] ⚠️  --fresh-per-query is risky on macOS Docker Desktop; consider removing it")
            print(f"[evals] mode=direct (fresh-per-query) — new docker per query (stderr: {stderr_path})")
            client = None  # we'll spawn one inside the loop
        else:
            print(f"[evals] mode=direct — spawning MCP via docker run (stderr: {stderr_path})")
            client = McpClient(stderr_path=stderr_path)
    else:
        print(f"[evals] mode=lmstudio — POST {LM_API_URL} with model={LM_MODEL}")
        client = LmStudioClient()

    results = []
    try:
        for spec in queries:
            qid = spec["id"]; q = spec["query"]
            print(f"\n[evals] running {qid:30s} | {q}")
            t0 = time.time()
            try:
                if args.mode == "direct":
                    # Fresh-per-query: spawn a new container, run one query, tear down.
                    if args.fresh_per_query:
                        per_stderr = str(run_dir / f"mcp_stderr_{qid}.log")
                        per_client = McpClient(stderr_path=per_stderr)
                        try:
                            text = per_client.search(q, limit=args.limit, timeout=120)
                        finally:
                            per_client.close()
                    else:
                        text = client.search(q, limit=args.limit, timeout=180)
                    latency = time.time() - t0
                    ok, checks, urls = evaluate_query(spec, text or "", latency)
                    row = {
                        "id": qid, "query": q, "ok": ok,
                        "latency_seconds": round(latency, 1),
                        "url_count": len(urls), "urls": urls[:8],
                        "checks": {k: {"status": v[0], "detail": v[1]} for k,v in checks.items()},
                        "response_text": (text or "")[:1500],
                    }
                else:
                    # lmstudio mode — full model + MCP loop, longer timeout
                    resp = client.search(q, limit=args.limit, timeout=300)
                    latency = time.time() - t0
                    if resp.get("error"):
                        raise RuntimeError(f"LM Studio error: {resp['error']}")
                    # Combine tool_call outputs and assistant text for URL scan
                    combined = "\n".join(
                        tc.get("output_text", "") for tc in resp["tool_calls"]
                    ) + "\n" + resp.get("assistant_text", "")
                    ok, checks, urls = evaluate_query(
                        spec, combined, latency,
                        lmstudio_extras={"tool_calls": resp["tool_calls"]},
                    )
                    row = {
                        "id": qid, "query": q, "ok": ok,
                        "latency_seconds": round(latency, 1),
                        "url_count": len(urls), "urls": urls[:8],
                        "tool_calls": [
                            {"tool": tc.get("tool"),
                             "args": tc.get("args"),
                             "output_excerpt": (tc.get("output_text") or "")[:600]}
                            for tc in resp["tool_calls"]
                        ],
                        "assistant_text": (resp.get("assistant_text") or "")[:1500],
                        "checks": {k: {"status": v[0], "detail": v[1]} for k,v in checks.items()},
                    }

                (run_dir / f"{qid}.json").write_text(json.dumps(row, indent=2))
                results.append(row)
                tag = "✅" if ok else "❌"
                print(f"  {tag} {latency:.1f}s | {len(urls)} URLs | " +
                      ", ".join(f"{k}:{v[0]}" for k,v in checks.items()))
            except Exception as e:
                print(f"  ❌ EXCEPTION: {type(e).__name__}: {e}")
                results.append({
                    "id": qid, "query": q, "ok": False,
                    "latency_seconds": round(time.time() - t0, 1),
                    "error": f"{type(e).__name__}: {e}",
                })
    finally:
        if client:
            client.close()

    # Summary
    passed = sum(1 for r in results if r.get("ok"))
    total = len(results)

    summary_md = [f"# Eval run {timestamp} ({args.mode})\n",
                  f"**{passed}/{total} passed**\n",
                  "| ID | OK | Latency | URLs | Checks |",
                  "|----|----|---------|------|--------|"]
    for r in results:
        checks = r.get("checks", {})
        check_str = " ".join(f"{k}={v.get('status','?')}" for k,v in checks.items())
        summary_md.append(
            f"| {r['id']} | {'✅' if r.get('ok') else '❌'} | "
            f"{r.get('latency_seconds','-')}s | {r.get('url_count',0)} | {check_str} |"
        )
    summary_md.append("\n## Failures\n")
    for r in results:
        if r.get("ok"): continue
        summary_md.append(f"### {r['id']}")
        summary_md.append(f"Query: `{r['query']}`")
        if "error" in r:
            summary_md.append(f"Error: `{r['error']}`")
        else:
            for k, v in r.get("checks", {}).items():
                if v.get("status") != "ok":
                    summary_md.append(f"- **{k}**: {v.get('detail')}")
        summary_md.append("")

    (run_dir / "summary.md").write_text("\n".join(summary_md))
    (run_dir / "results.json").write_text(json.dumps(results, indent=2))

    print(f"\n[evals] {passed}/{total} passed")
    print(f"[evals] artifacts: {run_dir}")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
