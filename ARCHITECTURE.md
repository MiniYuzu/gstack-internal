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

## Setup 与构建管道

### 概览

`setup` 是构建和安装 gstack 的唯一入口。它处理从依赖验证到向多个 AI agent host（Claude、Codex、Kiro、Factory）注册 skill 的所有事情。

```
./setup [--host claude|codex|kiro|factory|auto] [--prefix|--no-prefix] [--team|--no-team]
```

脚本分 10 个阶段执行：

| 阶段 | 内容 | 关键文件 |
|------|------|----------|
| 1. 依赖检查 | 验证 `bun` 是否已安装 | — |
| 2. 参数解析 | 解析 `--host`、`--prefix`、`--team` | `bin/gstack-config` |
| 3. 构建 | 编译 browse 二进制 + 生成 skill 文档 | `package.json`、`scripts/gen-skill-docs.ts` |
| 4. 外部 host 生成 | 生成 `.agents/`、`.factory/` 的 skill 文档 | `scripts/gen-skill-docs.ts --host codex|factory` |
| 5. Chromium 验证 | 启动 Playwright 确认浏览器可用 | — |
| 6. 全局状态 | 创建 `~/.gstack/projects/` | — |
| 7. Claude 安装 | 将 skill 链接到 `~/.claude/skills/` | `bin/gstack-patch-names`、`bin/gstack-relink` |
| 8. 外部 host 安装 | 为 Codex/Factory/Kiro 链接 skill | `hosts/*.ts` 配置 |
| 9. 版本迁移 | 运行幂等迁移脚本 | `gstack-upgrade/migrations/` |
| 10. Team mode hook | 注册/注销 SessionStart hook | `bin/gstack-settings-hook` |

### 智能重建检测

Setup 通过比较 mtime 避免不必要的工作：

1. 如果 `browse/dist/browse` 不存在 → 构建
2. 如果 `browse/src/` 下有任何文件比二进制新 → 构建
3. 如果 `package.json` 或 `bun.lock` 比二进制新 → 构建
4. 否则跳过整个构建阶段

这意味着连续运行两次 `./setup`，第二次耗时不到一秒。

### 构建阶段细节

`bun run build`（正常模式）：

```bash
bun run gen:skill-docs --host all           # 为所有 host 生成 SKILL.md
bun build --compile browse/src/cli.ts       # 编译 browse 二进制 (~58MB)
bun build --compile browse/src/find-browse.ts
bun build --compile bin/gstack-global-discover.ts
bash browse/scripts/build-node-server.sh    # Windows 的 Node.js 服务器包
git rev-parse HEAD > browse/dist/.version   # 版本标记，用于自动重启
```

`bun run build:node`（内网模式）：

使用 `npm install --legacy-peer-deps` + `bun run build:node`，而不是 `bun build --compile`。产出 Node.js CLI 脚本而非编译后的二进制文件，因为内网环境缺少 Bun 编译器。

### 外部 host skill 生成

即使二进制是最新的（无需构建），setup 也会始终重新生成外部 host 的 skill：

```bash
bun run gen:skill-docs --host codex   # → .agents/skills/gstack-*/
bun run gen:skill-docs --host factory # → .factory/skills/gstack-*/
```

生成很快（<2s），而基于 mtime 的过期检测在 clone/checkout/upgrade 后很脆弱。始终重新生成可防止 skill 文档过期。

## 多 Host Skill 生成

### 问题

不同的 AI agent 以不同格式消费 skill：
- **Claude Code** 读取带 YAML frontmatter 的 `SKILL.md`，使用 `Skill` 工具调用
- **Codex** 读取 `.md` 文件，附带 OpenAI 兼容的 `agents/openai.yaml` 元数据
- **Kiro** 读取 `.md` 文件，但使用不同的路径约定（`~/.kiro/` 而非 `~/.claude/`）
- **Factory Droid** 有自己的 frontmatter 限制

为每个 host 手动维护副本必然导致漂移。

### 解决方案

单个 `.tmpl` 模板通过声明式配置生成所有 host 变体：

```
skill/SKILL.md.tmpl
    │
    ├─ --host claude ──→ skill/SKILL.md              (主 host，最小转换)
    ├─ --host codex ───→ .agents/skills/gstack-skill/SKILL.md  (路径重写、openai.yaml)
    ├─ --host factory ─→ .factory/skills/gstack-skill/SKILL.md (frontmatter 白名单)
    └─ --host all ─────→ 以上所有
```

### 生成管道

`scripts/gen-skill-docs.ts` 处理每个模板：

1. **发现**：`discoverTemplates()` 扫描根目录及一级子目录中的 `SKILL.md.tmpl`
2. **Frontmatter 解析**：提取 `name:`、`description:`、`preamble-tier:`、`benefits-from:`
3. **占位符解析**：通过 resolver 注册表（`scripts/resolvers/index.ts`）替换 `{{NAME}}` 或 `{{NAME:arg1:arg2}}`
4. **语音触发折叠**：将 `voice-triggers` YAML 折叠进 description 正文
5. **Host 专用 frontmatter 转换**：根据 host 配置剥离/保留字段（白名单/黑名单模式）
6. **路径重写**：`~/.claude/skills/gstack` → `~/.codex/skills/gstack` 等
7. **安全提示注入**：如果存在 hook，插入安全建议文本
8. **元数据生成**：为 Codex 生成 `agents/openai.yaml`，包含显示名和描述
9. **输出**：写入生成的文件，并前置 `<!-- AUTO-GENERATED -->` 头

### 占位符解析器注册表

| 占位符 | 来源 | 生成内容 |
|--------|------|----------|
| `{{PREAMBLE}}` | `scripts/resolvers/preamble.ts` | 更新检查、会话追踪、学习加载、AskUserQuestion 格式、遥测提示 |
| `{{COMMAND_REFERENCE}}` | `browse/src/commands.ts` | 分类命令表及描述 |
| `{{SNAPSHOT_FLAGS}}` | `browse/src/snapshot.ts` | 标志参考及示例 |
| `{{BROWSE_SETUP}}` | `scripts/resolvers/browse.ts` | 二进制发现 + `$B` 设置说明 |
| `{{BASE_BRANCH_DETECT}}` | `scripts/resolvers/utility.ts` | PR 导向 skill 的动态基分支检测 |
| `{{QA_METHODOLOGY}}` | `scripts/resolvers/testing.ts` | `/qa` 和 `/qa-only` 的共享 QA 方法论 |
| `{{DESIGN_METHODOLOGY}}` | `scripts/resolvers/design.ts` | 设计审计方法论 + 硬规则 |
| `{{REVIEW_DASHBOARD}}` | `scripts/resolvers/review.ts` | `/ship` 起飞前的审查准备仪表板 |
| `{{TEST_BOOTSTRAP}}` | `scripts/resolvers/testing.ts` | 测试框架检测、引导、CI/CD 设置 |
| `{{CODEX_PLAN_REVIEW}}` | `scripts/resolvers/review.ts` | 跨模型计划审查（Codex 或 Claude 子代理） |
| `{{LEARNINGS_SEARCH}}` | `scripts/resolvers/learnings.ts` | 会话开始时搜索历史学习 |
| `{{LEARNINGS_LOG}}` | `scripts/resolvers/learnings.ts` | 会话结束时记录操作发现 |

### 声明式 Host 配置系统

每个支持的 host 在 `hosts/*.ts` 中定义为一个类型化的 `HostConfig`：

```typescript
// hosts/claude.ts — 主 host，最小转换
const claude: HostConfig = {
  name: 'claude',
  displayName: 'Claude Code',
  globalRoot: '.claude/skills/gstack',
  frontmatter: { mode: 'denylist', stripFields: ['sensitive'] },
  pathRewrites: [],
  install: { prefixable: true, linkingStrategy: 'real-dir-symlink' },
};

// hosts/opencode.ts — 外部 host，路径重写 + 白名单
const opencode: HostConfig = {
  name: 'opencode',
  displayName: 'OpenCode',
  globalRoot: '.config/opencode/skills/gstack',
  frontmatter: { mode: 'allowlist', keepFields: ['name', 'description', 'version'] },
  pathRewrites: [{ from: '~/.claude/skills/gstack', to: '~/.config/opencode/skills/gstack' }],
  install: { prefixable: false, linkingStrategy: 'symlink-generated' },
};
```

关键 `HostConfig` 字段：
- `frontmatter.mode`：`allowlist`（仅保留列出字段）或 `denylist`（删除列出字段）
- `pathRewrites`：host 专用路径的字面量字符串替换
- `generation.skipSkills` / `includeSkills`：每个 host 的 skill 白名单/黑名单
- `runtimeRoot.globalSymlinks`：要符号链接到 host 运行时根目录的资源
- `install.linkingStrategy`：skill 如何暴露给 host

添加新 host：创建 `hosts/myhost.ts`，在 `hosts/index.ts` 中导入，添加到 `ALL_HOST_CONFIGS`。完整清单见 `docs/ADDING_A_HOST.md`。

## 安装策略

不同 host 需要不同安装策略，因为它们的 skill 发现机制不同。

### Claude Code：real-dir-symlink

Claude 通过扫描 `~/.claude/skills/` 下包含 `SKILL.md` 的目录来发现 skill。如果我们将整个 gstack 仓库符号链接到该目录，Claude 会看到嵌套在 `gstack/qa/` 和 `gstack/ship/` 下的 skill，自动给它们加上 `gstack-qa`、`gstack-ship` 前缀。

解决方案：在 `~/.claude/skills/` 顶层创建**真实目录**（不是符号链接），内部只有 `SKILL.md` 是符号链接：

```
~/.claude/skills/
├── qa/              ← 真实目录
│   └── SKILL.md     ← 符号链接 → ~/.claude/skills/gstack/qa/SKILL.md
├── ship/            ← 真实目录
│   └── SKILL.md     ← 符号链接
└── gstack/          ← 符号链接到仓库根目录（运行时资源：bin/、browse/dist/）
```

这确保 Claude 将 `/qa` 和 `/ship` 视为顶层 skill。`--prefix` 标志会将目录名改为 `gstack-qa/`、`gstack-ship/`，供同时运行其他 skill 包的用户使用。

迁移辅助工具处理扁平名和带前缀名之间的切换，不会留下过期符号链接。

### Codex：symlink-generated

Codex 递归扫描 `~/.codex/skills/`。如果我们在那里暴露整个仓库，源码 `SKILL.md`（Claude 格式）和生成的 Codex skill 都会被发现——导致重复。

解决方案：创建**最小运行时根目录**，只包含运行时资源，然后从 `.agents/skills/` 符号链接生成的 skill：

```
~/.codex/skills/
├── gstack/          ← 最小运行时根（bin/、browse/dist/、ETHOS.md）
└── gstack-qa/       ← 符号链接 → .agents/skills/gstack-qa/
```

`.agents/skills/gstack/` sidecar 包含指向 `bin/`、`browse/`、`review/` 的符号链接，以便 skill 模板在运行时解析 `$SKILL_ROOT/review/checklist.md` 等路径。

### Kiro：copy-and-sed

Kiro 与 Codex 类似，但使用 `~/.kiro/skills/` 路径。setup 不维护单独的生成管道，而是复制 Codex 生成的 skill，然后运行 `sed` 重写路径：

```bash
sed -e 's|~/.codex/skills/gstack|~/.kiro/skills/gstack|g' \
    -e 's|~/.claude/skills/gstack|~/.kiro/skills/gstack|g' \
    .agents/skills/gstack-qa/SKILL.md > ~/.kiro/skills/gstack-qa/SKILL.md
```

这让 Kiro 支持成本很低——没有单独的模板变体，只有路径重写。

## CLI 工具链

`bin/` 目录包含约 20 个小工具，`setup` 和 skill 在运行时调用。它们被设计为可组合的外壳脚本，而非单一庞大的 CLI。

| 工具 | 用途 | 调用方 |
|------|------|--------|
| `gstack-config` | 键值配置存储（`get`/`set`/`list`/`delete`）。持久化到 `~/.gstack/config.yaml`。跟踪 `skill_prefix`、`proactive`、`telemetry`、`team_mode`、`auto_upgrade`。 | `setup`、skill 序言、用户直接 |
| `gstack-update-check` | 比较本地 VERSION 与 GitHub 最新版。如果升级在 24h 内，打印 `UPGRADE_AVAILABLE` 或 `JUST_UPGRADED`。 | 每个 skill 序言 |
| `gstack-relink` | 自修复符号链接管理器。检测并修复仓库移动或重命名后的损坏 skill 符号链接。 | `setup`、`gstack-upgrade` |
| `gstack-patch-names` | 根据前缀偏好（扁平 vs `gstack-`）重写 `SKILL.md` 中的 `name:` 字段。 | `setup` |
| `gstack-slug` | 从仓库路径生成文件系统安全的项目 slug。用于学习、时间线、评估存储路径。 | Skill 序言 |
| `gstack-timeline-log` | 将结构化 JSON 追加到 `~/.gstack/projects/{slug}/timeline.jsonl`。跟踪 skill 开始/完成，用于会话恢复。 | Skill 序言、完成时 |
| `gstack-learnings-log` | 将操作发现（模式、陷阱、偏好）持久化到 `~/.gstack/projects/{slug}/learnings.jsonl`。 | Skill 完成时 |
| `gstack-learnings-search` | 会话开始时搜索历史学习。将相关过去上下文加载到 skill 序言中。 | Skill 序言 |
| `gstack-review-log` / `gstack-review-read` | 持久化审查元数据 + 渲染审查准备仪表板。`/ship`、`/plan-eng-review` 等使用。 | 审查 skill |
| `gstack-settings-hook` | 管理 Claude Code `settings.json` hook（`add`/`remove`/`list`）。用于 team mode 的 SessionStart hook。 | `setup --team`、`setup --no-team` |
| `gstack-session-update` | SessionStart hook 调用。如果启用 `auto_upgrade` 且版本变化，自动更新 gstack。 | `settings.json` hook |
| `gstack-team-init` | 在仓库的本地 Claude Code 设置中注册 SessionStart hook。为新仓库引导 team mode。 | `setup --team` 输出、用户直接 |
| `gstack-platform-detect` | 检测操作系统、shell 和已安装的 AI agent。用于 `setup --host auto`。 | `setup` |
| `gstack-repo-mode` | 确定仓库所有权模型（`solo` vs `collaborative`）。影响主动行为。 | Skill 序言 |
| `gstack-diff-scope` | 为审查 skill 生成范围限定的 diff（排除生成文件、vendor 等）。 | `/review`、`/ship` |
| `gstack-open-url` | 跨平台 URL 打开器（macOS `open`、Linux `xdg-open`、Windows `start`）。 | Skill |
| `gstack-extension` | Chrome 扩展助手：注入侧边栏、管理内容脚本。 | Browse 命令 |

设计原则：每个工具做好一件事。它们在 setup 中由 bash 组合，在 skill 模板中由自然语言 prose 组合。没有任何单一二进制膨胀成全能 CLI。

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
