# Architecture

This document explains **why** gstack is built the way it is. For setup and commands, see CLAUDE.md. For contributing, see CONTRIBUTING.md.

## The core idea

gstack gives Claude Code a persistent browser and a set of opinionated workflow skills. The browser is the hard part — everything else is Markdown.

The key insight: an AI agent interacting with a browser needs **sub-second latency** and **persistent state**. If every command cold-starts a browser, you're waiting 3-5 seconds per tool call. If the browser dies between commands, you lose cookies, tabs, and login sessions. So gstack runs a long-lived Chromium daemon that the CLI talks to over localhost HTTP.

```
Claude Code                     gstack
─────────                      ──────
                               ┌──────────────────────┐
  Tool call: $B snapshot -i    │  CLI (compiled binary)│
  ─────────────────────────→   │  • reads state file   │
                               │  • POST /command      │
                               │    to localhost:PORT   │
                               └──────────┬───────────┘
                                          │ HTTP
                               ┌──────────▼───────────┐
                               │  Server (Bun.serve)   │
                               │  • dispatches command  │
                               │  • talks to Chromium   │
                               │  • returns plain text  │
                               └──────────┬───────────┘
                                          │ CDP
                               ┌──────────▼───────────┐
                               │  Chromium (headless)   │
                               │  • persistent tabs     │
                               │  • cookies carry over  │
                               │  • 30min idle timeout  │
                               └───────────────────────┘
```

First call starts everything (~3s). Every call after: ~100-200ms.

## Why Bun

Node.js would work. Bun is better here for three reasons:

1. **Compiled binaries.** `bun build --compile` produces a single ~58MB executable. No `node_modules` at runtime, no `npx`, no PATH configuration. The binary just runs. This matters because gstack installs into `~/.claude/skills/` where users don't expect to manage a Node.js project.

2. **Native SQLite.** Cookie decryption reads Chromium's SQLite cookie database directly. Bun has `new Database()` built in — no `better-sqlite3`, no native addon compilation, no gyp. One less thing that breaks on different machines.

3. **Native TypeScript.** The server runs as `bun run server.ts` during development. No compilation step, no `ts-node`, no source maps to debug. The compiled binary is for deployment; source files are for development.

4. **Built-in HTTP server.** `Bun.serve()` is fast, simple, and doesn't need Express or Fastify. The server handles ~10 routes total. A framework would be overhead.

The bottleneck is always Chromium, not the CLI or server. Bun's startup speed (~1ms for the compiled binary vs ~100ms for Node) is nice but not the reason we chose it. The compiled binary and native SQLite are.

## The daemon model

### Why not start a browser per command?

Playwright can launch Chromium in ~2-3 seconds. For a single screenshot, that's fine. For a QA session with 20+ commands, it's 40+ seconds of browser startup overhead. Worse: you lose all state between commands. Cookies, localStorage, login sessions, open tabs — all gone.

The daemon model means:

- **Persistent state.** Log in once, stay logged in. Open a tab, it stays open. localStorage persists across commands.
- **Sub-second commands.** After the first call, every command is just an HTTP POST. ~100-200ms round-trip including Chromium's work.
- **Automatic lifecycle.** The server auto-starts on first use, auto-shuts down after 30 minutes idle. No process management needed.

### State file

The server writes `.gstack/browse.json` (atomic write via tmp + rename, mode 0o600):

```json
{ "pid": 12345, "port": 34567, "token": "uuid-v4", "startedAt": "...", "binaryVersion": "abc123" }
```

The CLI reads this file to find the server. If the file is missing or the server fails an HTTP health check, the CLI spawns a new server. On Windows, PID-based process detection is unreliable in Bun binaries, so the health check (GET /health) is the primary liveness signal on all platforms.

### Port selection

Random port between 10000-60000 (retry up to 5 on collision). This means 10 Conductor workspaces can each run their own browse daemon with zero configuration and zero port conflicts. The old approach (scanning 9400-9409) broke constantly in multi-workspace setups.

### Version auto-restart

The build writes `git rev-parse HEAD` to `browse/dist/.version`. On each CLI invocation, if the binary's version doesn't match the running server's `binaryVersion`, the CLI kills the old server and starts a new one. This prevents the "stale binary" class of bugs entirely — rebuild the binary, next command picks it up automatically.

## Security model

### Localhost only

The HTTP server binds to `localhost`, not `0.0.0.0`. It's not reachable from the network.

### Bearer token auth

Every server session generates a random UUID token, written to the state file with mode 0o600 (owner-only read). Every HTTP request must include `Authorization: Bearer <token>`. If the token doesn't match, the server returns 401.

This prevents other processes on the same machine from talking to your browse server. The cookie picker UI (`/cookie-picker`) and health check (`/health`) are exempt — they're localhost-only and don't execute commands.

### Cookie security

Cookies are the most sensitive data gstack handles. The design:

1. **Keychain access requires user approval.** First cookie import per browser triggers a macOS Keychain dialog. The user must click "Allow" or "Always Allow." gstack never silently accesses credentials.

2. **Decryption happens in-process.** Cookie values are decrypted in memory (PBKDF2 + AES-128-CBC), loaded into the Playwright context, and never written to disk in plaintext. The cookie picker UI never displays cookie values — only domain names and counts.

3. **Database is read-only.** gstack copies the Chromium cookie DB to a temp file (to avoid SQLite lock conflicts with the running browser) and opens it read-only. It never modifies your real browser's cookie database.

4. **Key caching is per-session.** The Keychain password + derived AES key are cached in memory for the server's lifetime. When the server shuts down (idle timeout or explicit stop), the cache is gone.

5. **No cookie values in logs.** Console, network, and dialog logs never contain cookie values. The `cookies` command outputs cookie metadata (domain, name, expiry) but values are truncated.

### Shell injection prevention

The browser registry (Comet, Chrome, Arc, Brave, Edge) is hardcoded. Database paths are constructed from known constants, never from user input. Keychain access uses `Bun.spawn()` with explicit argument arrays, not shell string interpolation.

## The ref system

Refs (`@e1`, `@e2`, `@c1`) are how the agent addresses page elements without writing CSS selectors or XPath.

### How it works

```
1. Agent runs: $B snapshot -i
2. Server calls Playwright's page.accessibility.snapshot()
3. Parser walks the ARIA tree, assigns sequential refs: @e1, @e2, @e3...
4. For each ref, builds a Playwright Locator: getByRole(role, { name }).nth(index)
5. Stores Map<string, RefEntry> on the BrowserManager instance (role + name + Locator)
6. Returns the annotated tree as plain text

Later:
7. Agent runs: $B click @e3
8. Server resolves @e3 → Locator → locator.click()
```

### Why Locators, not DOM mutation

The obvious approach is to inject `data-ref="@e1"` attributes into the DOM. This breaks on:

- **CSP (Content Security Policy).** Many production sites block DOM modification from scripts.
- **React/Vue/Svelte hydration.** Framework reconciliation can strip injected attributes.
- **Shadow DOM.** Can't reach inside shadow roots from the outside.

Playwright Locators are external to the DOM. They use the accessibility tree (which Chromium maintains internally) and `getByRole()` queries. No DOM mutation, no CSP issues, no framework conflicts.

### Ref lifecycle

Refs are cleared on navigation (the `framenavigated` event on the main frame). This is correct — after navigation, all locators are stale. The agent must run `snapshot` again to get fresh refs. This is by design: stale refs should fail loudly, not click the wrong element.

### Ref staleness detection

SPAs can mutate the DOM without triggering `framenavigated` (e.g. React router transitions, tab switches, modal opens). This makes refs stale even though the page URL didn't change. To catch this, `resolveRef()` performs an async `count()` check before using any ref:

```
resolveRef(@e3) → entry = refMap.get("e3")
                → count = await entry.locator.count()
                → if count === 0: throw "Ref @e3 is stale — element no longer exists. Run 'snapshot' to get fresh refs."
                → if count > 0: return { locator }
```

This fails fast (~5ms overhead) instead of letting Playwright's 30-second action timeout expire on a missing element. The `RefEntry` stores `role` and `name` metadata alongside the Locator so the error message can tell the agent what the element was.

### Cursor-interactive refs (@c)

The `-C` flag finds elements that are clickable but not in the ARIA tree — things styled with `cursor: pointer`, elements with `onclick` attributes, or custom `tabindex`. These get `@c1`, `@c2` refs in a separate namespace. This catches custom components that frameworks render as `<div>` but are actually buttons.

## Logging architecture

Three ring buffers (50,000 entries each, O(1) push):

```
Browser events → CircularBuffer (in-memory) → Async flush to .gstack/*.log
```

Console messages, network requests, and dialog events each have their own buffer. Flushing happens every 1 second — the server appends only new entries since the last flush. This means:

- HTTP request handling is never blocked by disk I/O
- Logs survive server crashes (up to 1 second of data loss)
- Memory is bounded (50K entries × 3 buffers)
- Disk files are append-only, readable by external tools

The `console`, `network`, and `dialog` commands read from the in-memory buffers, not disk. Disk files are for post-mortem debugging.

## SKILL.md template system

### The problem

SKILL.md files tell Claude how to use the browse commands. If the docs list a flag that doesn't exist, or miss a command that was added, the agent hits errors. Hand-maintained docs always drift from code.

### The solution

```
SKILL.md.tmpl          (human-written prose + placeholders)
       ↓
gen-skill-docs.ts      (reads source code metadata)
       ↓
SKILL.md               (committed, auto-generated sections)
```

Templates contain the workflows, tips, and examples that require human judgment. Placeholders are filled from source code at build time:

| Placeholder | Source | What it generates |
|-------------|--------|-------------------|
| `{{COMMAND_REFERENCE}}` | `commands.ts` | Categorized command table |
| `{{SNAPSHOT_FLAGS}}` | `snapshot.ts` | Flag reference with examples |
| `{{PREAMBLE}}` | `gen-skill-docs.ts` | Startup block: update check, session tracking, contributor mode, AskUserQuestion format |
| `{{BROWSE_SETUP}}` | `gen-skill-docs.ts` | Binary discovery + setup instructions |
| `{{BASE_BRANCH_DETECT}}` | `gen-skill-docs.ts` | Dynamic base branch detection for PR-targeting skills (ship, review, qa, plan-ceo-review) |
| `{{QA_METHODOLOGY}}` | `gen-skill-docs.ts` | Shared QA methodology block for /qa and /qa-only |
| `{{DESIGN_METHODOLOGY}}` | `gen-skill-docs.ts` | Shared design audit methodology for /plan-design-review and /design-review |
| `{{REVIEW_DASHBOARD}}` | `gen-skill-docs.ts` | Review Readiness Dashboard for /ship pre-flight |
| `{{TEST_BOOTSTRAP}}` | `gen-skill-docs.ts` | Test framework detection, bootstrap, CI/CD setup for /qa, /ship, /design-review |
| `{{CODEX_PLAN_REVIEW}}` | `gen-skill-docs.ts` | Optional cross-model plan review (Codex or Claude subagent fallback) for /plan-ceo-review and /plan-eng-review |
| `{{DESIGN_SETUP}}` | `resolvers/design.ts` | Discovery pattern for `$D` design binary, mirrors `{{BROWSE_SETUP}}` |
| `{{DESIGN_SHOTGUN_LOOP}}` | `resolvers/design.ts` | Shared comparison board feedback loop for /design-shotgun, /plan-design-review, /design-consultation |

This is structurally sound — if a command exists in code, it appears in docs. If it doesn't exist, it can't appear.

### The preamble

Every skill starts with a `{{PREAMBLE}}` block that runs before the skill's own logic. It handles five things in a single bash command:

1. **Update check** — calls `gstack-update-check`, reports if an upgrade is available.
2. **Session tracking** — touches `~/.gstack/sessions/$PPID` and counts active sessions (files modified in the last 2 hours). When 3+ sessions are running, all skills enter "ELI16 mode" — every question re-grounds the user on context because they're juggling windows.
3. **Operational self-improvement** — at the end of every skill session, the agent reflects on failures (CLI errors, wrong approaches, project quirks) and logs operational learnings to the project's JSONL file for future sessions.
4. **AskUserQuestion format** — universal format: context, question, `RECOMMENDATION: Choose X because ___`, lettered options. Consistent across all skills.
5. **Search Before Building** — before building infrastructure or unfamiliar patterns, search first. Three layers of knowledge: tried-and-true (Layer 1), new-and-popular (Layer 2), first-principles (Layer 3). When first-principles reasoning reveals conventional wisdom is wrong, the agent names the "eureka moment" and logs it. See `ETHOS.md` for the full builder philosophy.

### Why committed, not generated at runtime?

Three reasons:

1. **Claude reads SKILL.md at skill load time.** There's no build step when a user invokes `/browse`. The file must already exist and be correct.
2. **CI can validate freshness.** `gen:skill-docs --dry-run` + `git diff --exit-code` catches stale docs before merge.
3. **Git blame works.** You can see when a command was added and in which commit.

### Template test tiers

| Tier | What | Cost | Speed |
|------|------|------|-------|
| 1 — Static validation | Parse every `$B` command in SKILL.md, validate against registry | Free | <2s |
| 2 — E2E via `claude -p` | Spawn real Claude session, run each skill, check for errors | ~$3.85 | ~20min |
| 3 — LLM-as-judge | Sonnet scores docs on clarity/completeness/actionability | ~$0.15 | ~30s |

Tier 1 runs on every `bun test`. Tiers 2+3 are gated behind `EVALS=1`. The idea is: catch 95% of issues for free, use LLMs only for judgment calls.

## Setup and Build Pipeline

### Overview

`setup` is the single entry point for building and installing gstack. It handles everything from dependency verification to registering skills with multiple AI agent hosts (Claude, Codex, Kiro, Factory).

```
./setup [--host claude|codex|kiro|factory|auto] [--prefix|--no-prefix] [--team|--no-team]
```

The script runs in 10 phases:

| Phase | What | Key files |
|-------|------|-----------|
| 1. Dependency check | Verify `bun` is installed | — |
| 2. Flag parsing | Resolve `--host`, `--prefix`, `--team` | `bin/gstack-config` |
| 3. Build | Compile browse binary + generate skill docs | `package.json`, `scripts/gen-skill-docs.ts` |
| 4. External host generation | Generate `.agents/`, `.factory/` skill docs | `scripts/gen-skill-docs.ts --host codex|factory` |
| 5. Chromium verification | Launch Playwright to confirm browser works | — |
| 6. Global state | Create `~/.gstack/projects/` | — |
| 7. Claude install | Link skills into `~/.claude/skills/` | `bin/gstack-patch-names`, `bin/gstack-relink` |
| 8. External host install | Link skills for Codex/Factory/Kiro | `hosts/*.ts` configs |
| 9. Version migrations | Run idempotent migration scripts | `gstack-upgrade/migrations/` |
| 10. Team mode hook | Register/unregister SessionStart hook | `bin/gstack-settings-hook` |

### Smart rebuild detection

Setup avoids unnecessary work by comparing mtimes:

1. If `browse/dist/browse` doesn't exist → build
2. If any file in `browse/src/` is newer than the binary → build
3. If `package.json` or `bun.lock` is newer than the binary → build
4. Otherwise skip the build phase entirely

This means running `./setup` twice in a row takes under a second the second time.

### Build phase details

`bun run build` (normal mode):

```bash
bun run gen:skill-docs --host all           # Generate SKILL.md for all hosts
bun build --compile browse/src/cli.ts       # Compile browse binary (~58MB)
bun build --compile browse/src/find-browse.ts
bun build --compile bin/gstack-global-discover.ts
bash browse/scripts/build-node-server.sh    # Node.js server bundle for Windows
git rev-parse HEAD > browse/dist/.version   # Version marker for auto-restart
```

`bun run build:node` (internal network mode):

Uses `npm install --legacy-peer-deps` + `bun run build:node` instead of `bun build --compile`. Produces Node.js CLI scripts rather than compiled binaries, because the internal network environment lacks Bun's compiler.

### External host skill generation

Even when the binary is fresh (no build needed), setup always regenerates external host skills:

```bash
bun run gen:skill-docs --host codex   # → .agents/skills/gstack-*/
bun run gen:skill-docs --host factory # → .factory/skills/gstack-*/
```

Generation is fast (<2s) and mtime-based staleness checks are fragile after clone/checkout/upgrade. Always regenerating prevents stale skill docs.

## Host-aware skill generation

### The problem

Different AI agents consume skills in different formats:
- **Claude Code** reads `SKILL.md` with YAML frontmatter, uses `Skill` tool invocation
- **Codex** reads `.md` files with OpenAI-compatible `agents/openai.yaml` metadata
- **Kiro** reads `.md` files but uses different path conventions (`~/.kiro/` not `~/.claude/`)
- **Factory Droid** has its own frontmatter restrictions

Hand-maintaining a copy per host would guarantee drift.

### The solution

A single `.tmpl` template generates all host variants via declarative config:

```
skill/SKILL.md.tmpl
    │
    ├─ --host claude ──→ skill/SKILL.md              (primary host, minimal transform)
    ├─ --host codex ───→ .agents/skills/gstack-skill/SKILL.md  (path rewrites, openai.yaml)
    ├─ --host factory ─→ .factory/skills/gstack-skill/SKILL.md (frontmatter allowlist)
    └─ --host all ─────→ 以上所有
```

### Generation pipeline

`scripts/gen-skill-docs.ts` processes each template:

1. **Discovery**: `discoverTemplates()` scans root + one level of subdirs for `SKILL.md.tmpl`
2. **Frontmatter parsing**: Extracts `name:`, `description:`, `preamble-tier:`, `benefits-from:`
3. **Placeholder resolution**: Replaces `{{NAME}}` or `{{NAME:arg1:arg2}}` via resolver registry (`scripts/resolvers/index.ts`)
4. **Voice trigger folding**: Collapses `voice-triggers` YAML into description prose
5. **Host-specific frontmatter transform**: Strips/keeps fields per host config (allowlist/denylist mode)
6. **Path rewrites**: `~/.claude/skills/gstack` → `~/.codex/skills/gstack`, etc.
7. **Safety prose injection**: If hooks are present, inserts advisory text
8. **Metadata generation**: For Codex, generates `agents/openai.yaml` with display name + description
9. **Output**: Writes generated file + prepends `<!-- AUTO-GENERATED -->` header

### Placeholder resolver registry

| Placeholder | Source | Generated by |
|-------------|--------|--------------|
| `{{PREAMBLE}}` | `scripts/resolvers/preamble.ts` | Update check, session tracking, learnings load, AskUserQuestion format, telemetry prompts |
| `{{COMMAND_REFERENCE}}` | `browse/src/commands.ts` | Categorized command table with descriptions |
| `{{SNAPSHOT_FLAGS}}` | `browse/src/snapshot.ts` | Flag reference with examples |
| `{{BROWSE_SETUP}}` | `scripts/resolvers/browse.ts` | Binary discovery + `$B` setup instructions |
| `{{BASE_BRANCH_DETECT}}` | `scripts/resolvers/utility.ts` | Dynamic base branch detection for PR-targeting skills |
| `{{QA_METHODOLOGY}}` | `scripts/resolvers/testing.ts` | Shared QA methodology for `/qa` and `/qa-only` |
| `{{DESIGN_METHODOLOGY}}` | `scripts/resolvers/design.ts` | Design audit methodology + hard rules |
| `{{REVIEW_DASHBOARD}}` | `scripts/resolvers/review.ts` | Review Readiness Dashboard for `/ship` pre-flight |
| `{{TEST_BOOTSTRAP}}` | `scripts/resolvers/testing.ts` | Test framework detection, bootstrap, CI/CD setup |
| `{{CODEX_PLAN_REVIEW}}` | `scripts/resolvers/review.ts` | Cross-model plan review (Codex or Claude subagent) |
| `{{LEARNINGS_SEARCH}}` | `scripts/resolvers/learnings.ts` | Search historical learnings at session start |
| `{{LEARNINGS_LOG}}` | `scripts/resolvers/learnings.ts` | Log operational discoveries at session end |

### Declarative host config system

Each supported host is defined as a typed `HostConfig` in `hosts/*.ts`:

```typescript
// hosts/claude.ts — primary host, minimal transformation
const claude: HostConfig = {
  name: 'claude',
  displayName: 'Claude Code',
  globalRoot: '.claude/skills/gstack',
  frontmatter: { mode: 'denylist', stripFields: ['sensitive'] },
  pathRewrites: [],
  install: { prefixable: true, linkingStrategy: 'real-dir-symlink' },
};

// hosts/opencode.ts — external host, path rewrites + allowlist
const opencode: HostConfig = {
  name: 'opencode',
  displayName: 'OpenCode',
  globalRoot: '.config/opencode/skills/gstack',
  frontmatter: { mode: 'allowlist', keepFields: ['name', 'description', 'version'] },
  pathRewrites: [{ from: '~/.claude/skills/gstack', to: '~/.config/opencode/skills/gstack' }],
  install: { prefixable: false, linkingStrategy: 'symlink-generated' },
};
```

Key `HostConfig` fields:
- `frontmatter.mode`: `'allowlist'` (only keep listed fields) or `'denylist'` (strip listed fields)
- `pathRewrites`: Literal string replacements for host-specific paths
- `generation.skipSkills` / `includeSkills`: Skill allowlist/denylist per host
- `runtimeRoot.globalSymlinks`: Assets to symlink into the host's runtime root
- `install.linkingStrategy`: How skills are exposed to the host

Adding a new host: create `hosts/myhost.ts`, import in `hosts/index.ts`, add to `ALL_HOST_CONFIGS`. See `docs/ADDING_A_HOST.md` for the full checklist.

## Installation strategies

Different hosts require different installation strategies because their skill discovery mechanisms differ.

### Claude Code: real-dir-symlink

Claude discovers skills by scanning `~/.claude/skills/` for directories containing `SKILL.md`. If we symlinked the entire gstack repo into that directory, Claude would see skills nested under `gstack/qa/` and `gstack/ship/`, auto-prefixing them as `gstack-qa` and `gstack-ship`.

The solution: create **real directories** (not symlinks) at the top level of `~/.claude/skills/`, with only `SKILL.md` symlinked inside:

```
~/.claude/skills/
├── qa/              ← real directory
│   └── SKILL.md     ← symlink → ~/.claude/skills/gstack/qa/SKILL.md
├── ship/            ← real directory
│   └── SKILL.md     ← symlink
└── gstack/          ← symlink to repo root (for runtime assets: bin/, browse/dist/)
```

This ensures Claude sees `/qa` and `/ship` as top-level skills. The `--prefix` flag changes directory names to `gstack-qa/`, `gstack-ship/` if the user runs other skill packs alongside gstack.

Migration helpers handle switching between flat and prefixed names without leaving stale symlinks.

### Codex: symlink-generated

Codex scans `~/.codex/skills/` recursively. If we exposed the whole repo there, both source `SKILL.md` files (Claude format) and generated Codex skills would be discoverable — causing duplicates.

The solution: create a **minimal runtime root** with only runtime assets, then symlink generated skills from `.agents/skills/`:

```
~/.codex/skills/
├── gstack/          ← minimal runtime root (bin/, browse/dist/, ETHOS.md)
└── gstack-qa/       ← symlink → .agents/skills/gstack-qa/
```

The `.agents/skills/gstack/` sidecar contains symlinks to `bin/`, `browse/`, `review/` so skill templates can resolve paths like `$SKILL_ROOT/review/checklist.md` at runtime.

### Kiro: copy-and-sed

Kiro is similar to Codex but uses `~/.kiro/skills/` paths. Rather than maintaining a separate generation pipeline, setup copies the Codex-generated skills and runs `sed` to rewrite paths:

```bash
sed -e 's|~/.codex/skills/gstack|~/.kiro/skills/gstack|g' \
    -e 's|~/.claude/skills/gstack|~/.kiro/skills/gstack|g' \
    .agents/skills/gstack-qa/SKILL.md > ~/.kiro/skills/gstack-qa/SKILL.md
```

This keeps Kiro support cheap — no separate template variants, just path rewriting.

## CLI Toolchain

The `bin/` directory contains ~20 small utilities that `setup` and skills use at runtime. They're designed to be composable shell scripts, not a monolithic CLI.

| Tool | Purpose | Called by |
|------|---------|-----------|
| `gstack-config` | Key-value config store (`get`/`set`/`list`/`delete`). Persists to `~/.gstack/config.yaml`. Tracks `skill_prefix`, `proactive`, `telemetry`, `team_mode`, `auto_upgrade`. | `setup`, skill preambles, user directly |
| `gstack-update-check` | Compares local VERSION against GitHub latest. Prints `UPGRADE_AVAILABLE` or `JUST_UPGRADED` if within 24h of upgrade. | Every skill preamble |
| `gstack-relink` | Self-healing symlink manager. Detects and fixes broken skill symlinks after repo moves or renames. | `setup`, `gstack-upgrade` |
| `gstack-patch-names` | Rewrites `name:` fields in `SKILL.md` files based on prefix preference (flat vs `gstack-`). | `setup` |
| `gstack-slug` | Generates a filesystem-safe project slug from repo path. Used for learnings, timelines, eval storage paths. | Skill preambles |
| `gstack-timeline-log` | Appends structured JSON to `~/.gstack/projects/{slug}/timeline.jsonl`. Tracks skill starts/completions for session recovery. | Skill preambles, completions |
| `gstack-learnings-log` | Persists operational discoveries (patterns, pitfalls, preferences) to `~/.gstack/projects/{slug}/learnings.jsonl`. | Skill completions |
| `gstack-learnings-search` | Searches historical learnings at session start. Loads relevant past context into the skill preamble. | Skill preambles |
| `gstack-review-log` / `gstack-review-read` | Persists review metadata + renders the Review Readiness Dashboard. Used by `/ship`, `/plan-eng-review`, etc. | Review skills |
| `gstack-settings-hook` | Manages Claude Code `settings.json` hooks (`add`/`remove`/`list`). Used for team mode SessionStart hook. | `setup --team`, `setup --no-team` |
| `gstack-session-update` | Called by SessionStart hook. Auto-updates gstack if `auto_upgrade` is enabled and version changed. | `settings.json` hook |
| `gstack-team-init` | Registers the SessionStart hook in a repo's local Claude Code settings. Bootstraps team mode for new repos. | `setup --team` output, user directly |
| `gstack-platform-detect` | Detects OS, shell, and installed AI agents. Used by `setup --host auto`. | `setup` |
| `gstack-repo-mode` | Determines repo ownership model (`solo` vs `collaborative`). Affects proactive behavior. | Skill preambles |
| `gstack-diff-scope` | Generates scoped diff for review skills (excludes generated files, vendor, etc.). | `/review`, `/ship` |
| `gstack-open-url` | Cross-platform URL opener (macOS `open`, Linux `xdg-open`, Windows `start`). | Skills |
| `gstack-extension` | Chrome extension helper: injects sidebar, manages content scripts. | Browse commands |

The design principle: each tool does one thing well. They're composed by bash in setup and by prose in skill templates. No single binary grows into a god CLI.

## Command dispatch

Commands are categorized by side effects:

- **READ** (text, html, links, console, cookies, ...): No mutations. Safe to retry. Returns page state.
- **WRITE** (goto, click, fill, press, ...): Mutates page state. Not idempotent.
- **META** (snapshot, screenshot, tabs, chain, ...): Server-level operations that don't fit neatly into read/write.

This isn't just organizational. The server uses it for dispatch:

```typescript
if (READ_COMMANDS.has(cmd))  → handleReadCommand(cmd, args, bm)
if (WRITE_COMMANDS.has(cmd)) → handleWriteCommand(cmd, args, bm)
if (META_COMMANDS.has(cmd))  → handleMetaCommand(cmd, args, bm, shutdown)
```

The `help` command returns all three sets so agents can self-discover available commands.

## Error philosophy

Errors are for AI agents, not humans. Every error message must be actionable:

- "Element not found" → "Element not found or not interactable. Run `snapshot -i` to see available elements."
- "Selector matched multiple elements" → "Selector matched multiple elements. Use @refs from `snapshot` instead."
- Timeout → "Navigation timed out after 30s. The page may be slow or the URL may be wrong."

Playwright's native errors are rewritten through `wrapError()` to strip internal stack traces and add guidance. The agent should be able to read the error and know what to do next without human intervention.

### Crash recovery

The server doesn't try to self-heal. If Chromium crashes (`browser.on('disconnected')`), the server exits immediately. The CLI detects the dead server on the next command and auto-restarts. This is simpler and more reliable than trying to reconnect to a half-dead browser process.

## E2E test infrastructure

### Session runner (`test/helpers/session-runner.ts`)

E2E tests spawn `claude -p` as a completely independent subprocess — not via the Agent SDK, which can't nest inside Claude Code sessions. The runner:

1. Writes the prompt to a temp file (avoids shell escaping issues)
2. Spawns `sh -c 'cat prompt | claude -p --output-format stream-json --verbose'`
3. Streams NDJSON from stdout for real-time progress
4. Races against a configurable timeout
5. Parses the full NDJSON transcript into structured results

The `parseNDJSON()` function is pure — no I/O, no side effects — making it independently testable.

### Observability data flow

```
  skill-e2e-*.test.ts
        │
        │ generates runId, passes testName + runId to each call
        │
  ┌─────┼──────────────────────────────┐
  │     │                              │
  │  runSkillTest()              evalCollector
  │  (session-runner.ts)         (eval-store.ts)
  │     │                              │
  │  per tool call:              per addTest():
  │  ┌──┼──────────┐              savePartial()
  │  │  │          │                   │
  │  ▼  ▼          ▼                   ▼
  │ [HB] [PL]    [NJ]          _partial-e2e.json
  │  │    │        │             (atomic overwrite)
  │  │    │        │
  │  ▼    ▼        ▼
  │ e2e-  prog-  {name}
  │ live  ress   .ndjson
  │ .json .log
  │
  │  on failure:
  │  {name}-failure.json
  │
  │  ALL files in ~/.gstack-dev/
  │  Run dir: e2e-runs/{runId}/
  │
  │         eval-watch.ts
  │              │
  │        ┌─────┴─────┐
  │     read HB     read partial
  │        └─────┬─────┘
  │              ▼
  │        render dashboard
  │        (stale >10min? warn)
```

**Split ownership:** session-runner owns the heartbeat (current test state), eval-store owns partial results (completed test state). The watcher reads both. Neither component knows about the other — they share data only through the filesystem.

**Non-fatal everything:** All observability I/O is wrapped in try/catch. A write failure never causes a test to fail. The tests themselves are the source of truth; observability is best-effort.

**Machine-readable diagnostics:** Each test result includes `exit_reason` (success, timeout, error_max_turns, error_api, exit_code_N), `timeout_at_turn`, and `last_tool_call`. This enables `jq` queries like:
```bash
jq '.tests[] | select(.exit_reason == "timeout") | .last_tool_call' ~/.gstack-dev/evals/_partial-e2e.json
```

### Eval persistence (`test/helpers/eval-store.ts`)

The `EvalCollector` accumulates test results and writes them in two ways:

1. **Incremental:** `savePartial()` writes `_partial-e2e.json` after each test (atomic: write `.tmp`, `fs.renameSync`). Survives kills.
2. **Final:** `finalize()` writes a timestamped eval file (e.g. `e2e-20260314-143022.json`). The partial file is never cleaned up — it persists alongside the final file for observability.

`eval:compare` diffs two eval runs. `eval:summary` aggregates stats across all runs in `~/.gstack-dev/evals/`.

### Test tiers

| Tier | What | Cost | Speed |
|------|------|------|-------|
| 1 — Static validation | Parse `$B` commands, validate against registry, observability unit tests | Free | <5s |
| 2 — E2E via `claude -p` | Spawn real Claude session, run each skill, scan for errors | ~$3.85 | ~20min |
| 3 — LLM-as-judge | Sonnet scores docs on clarity/completeness/actionability | ~$0.15 | ~30s |

Tier 1 runs on every `bun test`. Tiers 2+3 are gated behind `EVALS=1`. The idea: catch 95% of issues for free, use LLMs only for judgment calls and integration testing.

## What's intentionally not here

- **No WebSocket streaming.** HTTP request/response is simpler, debuggable with curl, and fast enough. Streaming would add complexity for marginal benefit.
- **No MCP protocol.** MCP adds JSON schema overhead per request and requires a persistent connection. Plain HTTP + plain text output is lighter on tokens and easier to debug.
- **No multi-user support.** One server per workspace, one user. The token auth is defense-in-depth, not multi-tenancy.
- **No Windows/Linux cookie decryption.** macOS Keychain is the only supported credential store. Linux (GNOME Keyring/kwallet) and Windows (DPAPI) are architecturally possible but not implemented.
- **No iframe auto-discovery.** `$B frame` supports cross-frame interaction (CSS selector, @ref, `--name`, `--url` matching), but the ref system does not auto-crawl iframes during `snapshot`. You must explicitly enter a frame context first.
