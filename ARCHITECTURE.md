# 架构

本文档说明 gstack 的构建方式及其原因。setup 命令和日常使用见 CLAUDE.md，贡献指南见 CONTRIBUTING.md。

## 概述

gstack 给 Claude Code 提供持久浏览器和一组结构化工作流 skill。浏览器是难点，其余都是 Markdown。

关键洞察：AI agent 与浏览器交互需要**亚秒级延迟**和**持久状态**。如果每个命令都冷启动浏览器，每次 tool call 要等 3-5 秒。如果浏览器在命令之间死掉，cookies、标签页、登录会话全部丢失。所以 gstack 运行一个长驻 Chromium 守护进程，CLI 通过 localhost HTTP 与之通信。

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

首次调用启动全部（~3s）。之后每次调用：~100-200ms。

Bun 被选中的原因有三：编译后的单文件二进制（~58MB，无 node_modules）、内置 SQLite（直接读取 Chromium cookie 数据库）、原生 TypeScript（开发时无需编译步骤）。瓶颈永远是 Chromium，不是 CLI 或 server。

## 安全模型

### Localhost only

HTTP server 绑定到 `localhost`，不是 `0.0.0.0`。无法从网络访问。

### Bearer token 认证

每个 server 会话生成随机 UUID token，以 0o600 权限写入 state file。每个 HTTP 请求必须带 `Authorization: Bearer <token>`，否则返回 401。这阻止了同一台机器上的其他进程访问你的 browse server。Cookie picker UI (`/cookie-picker`) 和 health check (`/health`) 除外，它们只接受 localhost 且不执行命令。

### Cookie 安全

Cookie 是 gstack 处理的最敏感数据：

1. **Keychain 访问需要用户批准。** 首次导入 cookie 时触发 macOS Keychain 弹窗，用户必须点击"Allow"或"Always Allow"。gstack 不会静默访问凭据。
2. **内存中解密。** Cookie 值在内存中解密（PBKDF2 + AES-128-CBC），加载到 Playwright context，永远不会以明文写入磁盘。Cookie picker UI 只显示域名和数量，从不显示 cookie 值。
3. **数据库只读。** gstack 将 Chromium cookie DB 复制到临时文件（避免 SQLite 锁冲突）并以只读方式打开。永远不会修改真实浏览器的 cookie 数据库。
4. **Key 缓存按会话隔离。** Keychain 密码和派生 AES key 只在 server 生命周期内缓存在内存中。server 关闭（空闲超时或显式 stop）后缓存即消失。
5. **日志中无 cookie 值。** Console、network、dialog 日志从不包含 cookie 值。`cookies` 命令只输出元数据（域名、名称、过期时间），值被截断。

### 防注入

浏览器注册表（Comet、Chrome、Arc、Brave、Edge）是硬编码的。数据库路径由已知常量构造，不来自用户输入。Keychain 访问使用 `Bun.spawn()` 并传入显式参数数组，不使用 shell 字符串插值。

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
