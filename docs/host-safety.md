# Host Safety — Two Crashes, Two Lessons

This MCP brought down a Mac M5 Pro (48GB) twice during development.
Both were `watchdog timeout: no checkins from watchdogd in 93 seconds`
kernel panics. Different root causes; both now mitigated.

## Crash #1 — Untracked headless browsers

**Symptom:** macOS kernel panic. Top tasks in panic log:
`Google Chrome Helper`, `headless_shell` × N at priority 47.

**Cause:** The MCP launched ephemeral cloakbrowser instances per
search engine attempt. With `FORCE_MULTI_ENGINE_SEARCH=true`, every
query spawned 2–3 browsers. Under concurrent queries the count grew
unbounded — `MAX_BROWSERS` only capped the persistent pool, not
ephemerals — saturating swap and starving `watchdogd`.

**Fix (Layer 1, in-code):**

| Change | Effect |
|--------|--------|
| Global `Semaphore(MAX_BROWSERS)` wrapping `launchEphemeral()` | Hard cap covers ephemerals too |
| `allBrowsers: Set<Browser>` tracking | `closeAll()` sweeps in-flight browsers |
| `browser.close()` 5s deadline + SIGKILL fallback | Wedged Chromium can't deadlock the semaphore |
| `'disconnected'` event releases slot | Crashed browsers don't leak slots |
| Removed per-query `closeAll()` from summaries handler | Was killing concurrent queries' browsers |

See `src/browser-pool.ts`.

## Crash #2 — Docker Desktop VM churn

**Symptom:** Same kernel-watchdog panic. Top processes:
`com.docker.virtualization`, `com.apple.Virtualization.Virtua`,
`docker`, `docker-agent`, `docker-sandbox`, plus Docker Desktop helpers.
Two prior `com.apple.Virtualization.VirtualMachine` crashes earlier
the same day (09:43, 02:35) preceded the host panic at 11:51.

**Cause:** Rapid `docker run` cycling.

  - The eval framework's `--fresh-per-query` flag spawned 10 fresh
    containers in succession.
  - LM Studio's MCP integration launches a new `docker run` per
    test session.
  - Combined with normal Chrome/VS Code/Termius, Docker Desktop's
    Linux VM (Apple Virtualization framework) couldn't keep up
    spinning containers up/down.

**Fix (Layer 2, container-level):**

`mcp.json` now invokes Docker with soft resource caps:

```json
"args": [
  "run", "-i", "--rm", "--init",
  "--memory=2g", "--memory-swap=2g",
  "--pids-limit=300",
  "--cpus=2",
  ...
]
```

These don't *prevent* crashes from the host's perspective (Docker
Desktop's VM is still finite). What they do:

  - One runaway container can't eat 48 GB of host RAM via the VM.
  - Fork-bombs cap out at 300 PIDs inside the container.
  - CPU bound to 2 cores leaves headroom for `watchdogd`.

**Operational rules:**

  - ❌ Don't use `--fresh-per-query` in `run_evals.py`. It's marked
    DANGEROUS in `--help`. The persistent McpClient is the default
    and is safe.
  - ❌ Don't fire >5 LM Studio chat calls back-to-back to a model
    using the MCP — each may spawn a new `docker run`.
  - ✅ Default persistent eval (no flags) is safe.
  - ✅ Production LM Studio chat use is safe (one `docker run` per
    session, not per request).

## Why both layers matter

| Failure mode | Caught by |
|--------------|-----------|
| One query leaks a browser | Layer 1 (semaphore + cleanup) |
| All queries leak browsers | Layer 1 + Layer 2 (container OOMs, host fine) |
| Container OOMs from runaway | Layer 2 limits (`--memory`, `--pids-limit`) |
| Docker VM thrashes from churn | **Operational** — don't churn |

Layer 1 alone would have prevented Crash #1. Layer 2 alone would
*not* have prevented Crash #2 (the VM crashes regardless of any
single container's limits). Both layers + the operational rule
"don't churn `docker run`" cover all known failure modes.

## If you crash anyway

1. Read `/Library/Logs/DiagnosticReports/Retired/panic-full-*.panic`
2. Look at top procnames for the smoking gun
3. Check `~/Library/Logs/DiagnosticReports/com.apple.Virtualization*.diag`
   — if Docker's VM crashed before the host, that's a churn issue
4. `pgrep -fl chrome-headless` after reboot — should be empty if
   Layer 1 is working
