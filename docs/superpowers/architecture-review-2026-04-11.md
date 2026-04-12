# gstack 工程架构深度审视报告

**生成时间:** 2026-04-11  
**审查者:** /plan-eng-review  
**项目版本:** v0.16.2.0  
**分支:** main

---

## 执行摘要

本报告对 gstack 项目进行了全面的工程架构审视。总体评估：**架构成熟、设计良好、安全考虑周到**。项目采用创新的持久化浏览器守护进程模型，结合 Bun 的编译能力，实现了亚秒级的浏览器自动化体验。

**总体评分: 8.5/10**

| 维度 | 评分 | 评价 |
|------|------|------|
| 架构设计 | 9/10 | 清晰的组件边界，合理的职责分离 |
| 代码质量 | 8/10 | 良好的组织，少量技术债务 |
| 测试覆盖 | 8/10 | 三层测试金字塔，E2E 成本偏高 |
| 性能优化 | 8/10 | 无重大瓶颈，可扩展性良好 |
| 安全架构 | 9/10 | 多层防御，企业级安全考虑 |

---

## 1. 系统架构全景

### 1.1 核心架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              GSTACK ARCHITECTURE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    HTTP    ┌─────────────────┐    CDP    ┌─────────────┐ │
│  │  CLI Binary  │◄──────────►│  Browse Server  │◄─────────►│  Chromium   │ │
│  │  (~58MB)     │  localhost │  (Bun.serve)    │  Protocol │  (Headless) │ │
│  └──────────────┘            └─────────────────┘           └─────────────┘ │
│         │                             │                                      │
│         │                        ┌────┴────┐                                 │
│         │                        │ TabSession│ Per-tab state isolation       │
│         │                        │ (Ref map) │ • Refs (@e1, @e2)              │
│         │                        └────┬────┘ • Frame context               │
│         │                             │       • Snapshot diffing            │
│    ┌────┴─────────────────────────────┴────┐                                │
│    │         Command Registry              │                                │
│    │  ┌─────────┬──────────┬─────────────┐ │                                │
│    │  │  READ   │  WRITE   │    META     │ │                                │
│    │  │ text    │ goto     │ snapshot    │ │                                │
│    │  │ click   │ fill     │ screenshot  │ │                                │
│    │  │ console │ cookie   │ tabs        │ │                                │
│    │  └─────────┴──────────┴─────────────┘ │                                │
│    └────────────────────────────────────────┘                                │
│                                                                              │
│  ═══════════════════════════════════════════════════════════════════════   │
│                              SKILLS LAYER                                    │
│  ═══════════════════════════════════════════════════════════════════════   │
│                                                                              │
│   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│   │   /qa   │ │  /ship  │ │/review  │ │/design  │ │/office  │ │/investi-│   │
│   │         │ │         │ │         │ │-review  │ │-hours   │ │  gate   │   │
│   └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐    │
│   │                 SKILL.md Template System                            │    │
│   │  SKILL.md.tmpl ──► gen-skill-docs.ts ──► SKILL.md (generated)      │    │
│   │                                                                     │    │
│   │  Placeholders: {{COMMAND_REFERENCE}}, {{SNAPSHOT_FLAGS}},            │    │
│   │               {{PREAMBLE}}, {{QA_METHODOLOGY}}                       │    │
│   └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 组件职责矩阵

| 组件 | 文件 | 行数 | 核心职责 | 依赖 |
|------|------|------|----------|------|
| **CLI** | `cli.ts` | ~1006 | 参数解析、服务器发现、HTTP 客户端 | - |
| **Server** | `server.ts` | ~2392 | HTTP 路由、命令分发、状态管理 | BrowserManager |
| **BrowserManager** | `browser-manager.ts` | ~1235 | Chromium 生命周期、Tab 管理、状态持久化 | TabSession |
| **TabSession** | `tab-session.ts` | ~140 | Per-tab 状态（Refs、Frame、Snapshot） | - |
| **Commands** | `commands.ts` | ~151 | 命令注册表（单一数据源） | - |
| **Read** | `read-commands.ts` | ~418 | 读取命令实现 | TabSession |
| **Write** | `write-commands.ts` | ~919 | 写入命令实现 | TabSession |
| **Meta** | `meta-commands.ts` | ~664 | 元命令实现 | TabSession |

---

## 2. 关键架构决策

### 2.1 为什么选择 Bun？

1. **编译二进制** — `bun build --compile` 生成单个 ~58MB 可执行文件，无 node_modules 依赖
2. **原生 SQLite** — Cookie 解密直接读取 Chromium 的 SQLite 数据库，无需 native addon
3. **原生 TypeScript** — 开发时直接运行 `.ts`，无需编译步骤
4. **内置 HTTP Server** — `Bun.serve()` 足够快，无需 Express

### 2.2 守护进程模型

**为什么不是每次命令启动浏览器？**

| 方案 | 首次调用 | 后续调用 | 状态保持 |
|------|----------|----------|----------|
| 每次启动 | ~3s | ~3s | ❌ 丢失 |
| 守护进程 | ~3s | ~100ms | ✅ 保持 |

**关键设计：**
- 状态文件 `.gstack/browse.json` 存储 PID、端口、Token
- 30 分钟空闲自动关闭
- 版本自动重启（二进制版本不匹配时）

### 2.3 Ref 系统（元素寻址）

**为什么不用 DOM mutation？**

```
传统方案: 注入 data-ref="@e1" 属性
问题:
  - CSP (Content Security Policy) 阻止
  - React/Vue hydration 会剥离
  - Shadow DOM 无法穿透

gstack 方案: Playwright Locators
优势:
  - 基于 Accessibility Tree，无需 DOM 修改
  - 使用 getByRole(role, { name }) 查询
  - 外部化，无框架冲突
```

**Ref 生命周期：**
```
snapshot ──► 生成 @e1, @e2... ──► 存储 Locator
    │                                    │
    ▼                                    ▼
framenavigated ──► clearRefs() ◄─── 使用 @e3
```

---

## 3. 数据流架构

### 3.1 请求处理流程

```
┌─────────────────────────────────────────────────────────────────┐
│                      REQUEST FLOW                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Claude Code Tool Call                                          │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │  $B goto    │───►│  CLI Binary │───►│  POST /command      │ │
│  │  https://x  │    │  (browse)   │    │  localhost:PORT     │ │
│  └─────────────┘    └─────────────┘    └──────────┬──────────┘ │
│                                                    │            │
│                                                    ▼            │
│                                          ┌─────────────────┐    │
│                                          │  Server Router  │    │
│                                          │  (server.ts)    │    │
│                                          └────────┬────────┘    │
│                                                   │             │
│                     ┌─────────────────────────────┼─────────────┤
│                     │                             │             │
│                     ▼                             ▼             │
│              ┌────────────┐              ┌──────────────┐       │
│              │  READ cmd  │              │  WRITE cmd   │       │
│              │  text      │              │  goto        │       │
│              │  html      │              │  click       │       │
│              │  console   │              │  fill        │       │
│              └─────┬──────┘              └──────┬───────┘       │
│                    │                            │               │
│                    ▼                            ▼               │
│           ┌──────────────┐            ┌─────────────────┐       │
│           │  getCleanText│            │  page.goto()    │       │
│           │  page.eval() │            │  locator.click()│       │
│           └──────────────┘            └─────────────────┘       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 状态管理

**全局状态（BrowserManager）：**
- `browser`: Playwright Browser 实例
- `context`: BrowserContext
- `pages`: Map<tabId, Page>
- `tabSessions`: Map<tabId, TabSession>
- `tabOwnership`: Map<tabId, clientId> — 多 Agent 隔离

**Per-tab 状态（TabSession）：**
- `page`: Page 引用
- `refMap`: Map<refId, RefEntry> — 元素定位器
- `lastSnapshot`: string — 用于 diff
- `activeFrame`: Frame — iframe 上下文

---

## 4. 安全架构

### 4.1 防御层矩阵

| 层级 | 机制 | 实现位置 | 防护目标 |
|------|------|----------|----------|
| **L1** | 数据标记 | `datamarkContent()` | 内容外泄检测 |
| **L2** | 隐藏元素剥离 | `markHiddenElements()` | ARIA 注入攻击 |
| **L3** | 内容过滤器 | `registerContentFilter()` | 恶意 URL/内容 |
| **L4** | 指令硬化 | SKILL.md SECURITY 段落 | 提示注入 |
| **L5** | URL 验证 | `validateNavigationUrl()` | SSRF/元数据窃取 |
| **L6** | 传输安全 | localhost + Bearer Token | 未授权访问 |
| **L7** | Cookie 加密 | macOS Keychain | 凭证泄露 |

### 4.2 URL 验证安全

```typescript
// 阻止的端点示例
BLOCKED_METADATA_HOSTS = [
  '169.254.169.254',        // AWS/GCP/Azure 元数据
  'fe80::1',                // IPv6 链路本地
  'metadata.google.internal', // GCP 内部
]

// DNS 重绑定防护 —— 同时检查 A 和 AAAA 记录
const v4Check = resolve4(hostname).then(...);
const v6Check = resolve6(hostname).then(...);  // Issue #668 修复
```

### 4.3 敏感数据脱敏

```typescript
// Cookie/Storage 值脱敏规则
SENSITIVE_PATTERNS = [
  /^eyJ/,           // JWT
  /^sk-/,           // OpenAI API Key
  /^ghp_/,          // GitHub Token
  /^AKIA/,          // AWS Access Key
  /token|secret|key|password/i  // 名称匹配
]
```

---

## 5. 技能系统架构

### 5.1 模板生成流程

```
SKILL.md.tmpl          (人类编写的模板 + 占位符)
       │
       ▼
gen-skill-docs.ts      (读取源代码元数据)
       │
       ├── {{COMMAND_REFERENCE}} ──► commands.ts
       ├── {{SNAPSHOT_FLAGS}} ─────► snapshot.ts
       ├── {{PREAMBLE}} ───────────► gen-skill-docs.ts 内置
       └── ...
       ▼
SKILL.md               (生成的文档，提交到 Git)
```

**为什么提交生成的文件？**
1. Claude 在技能加载时读取 SKILL.md —— 没有构建步骤
2. CI 可以验证文档新鲜度 (`--dry-run` + `git diff`)
3. Git blame 可追溯命令添加历史

### 5.2 技能目录结构

```
skills/
├── browse/              # 浏览器核心技能
├── qa/                  # QA 测试工作流
├── ship/                # 发布工作流
├── review/              # 代码审查
├── design-review/       # 设计审查
├── plan-ceo-review/     # CEO 视角规划审查
├── plan-eng-review/     # 工程架构审查 (本技能)
├── investigate/         # 调试调查
├── office-hours/        # YC Office Hours
└── [20+ 更多技能]
```

---

## 6. 测试架构

### 6.1 三层测试金字塔

```
TIER 3: E2E via claude -p
─────────────────────────────
• skill-e2e*.test.ts (15 个文件)
• codex-e2e.test.ts
• gemini-e2e.test.ts
• 成本: ~$3.85/次, ~20 分钟
• 触发: EVALS=1 环境变量

TIER 2: LLM-as-judge
─────────────────────────────
• skill-llm-eval.test.ts
• 成本: ~$0.15/次, ~30 秒
• 评估文档质量

TIER 1: Static + Integration
─────────────────────────────
• skill-validation.test.ts  ← 命令解析验证
• gen-skill-docs.test.ts    ← 模板生成验证
• commands.test.ts          ← 浏览器命令集成
• [40+ 个单元测试文件]
• 成本: 免费, <2 秒
• 每次提交前运行
```

### 6.2 E2E 测试基础设施

```
skill-e2e-*.test.ts
       │
       │ generates runId
       ▼
  ┌──────────────┐
  │ runSkillTest │◄───── 写入 prompt 到临时文件
  │(session-    │◄───── spawn `claude -p`
  │ runner.ts)   │◄───── 流式 NDJSON 输出
  └──────┬───────┘
         │
    ┌────┴────┐
    ▼         ▼
[HB]      [PL]
心跳      进度
│         │
▼         ▼
e2e-    progress
live    .log
.json
```

---

## 7. 性能特征

### 7.1 性能指标

| 指标 | 值 | 评价 |
|------|-----|------|
| CLI 启动时间 | ~1ms | 优秀 (Bun 编译) |
| 首次调用（冷启动） | ~3s | 可接受 (Chromium 启动) |
| 后续调用延迟 | ~100-200ms | 优秀 |
| 内存缓冲区 | 50K × 3 = 固定 | 可控 |
| 空闲超时 | 30 分钟 | 合理 |

### 7.2 优化策略

**已实施：**
- Ref 映射缓存 —— 避免重复解析
- Cookie 密钥缓存 —— 避免重复 PBKDF2
- 日志环形缓冲区 —— O(1) push，内存有界
- 异步日志刷新 —— 1 秒间隔，不阻塞请求

**可优化：**
- snapshot 深度限制 (`-d N`) —— 已添加
- 大型页面文本提取 —— 增量处理可考虑

---

## 8. 技术债务与改进机会

### 8.1 已知问题

| 位置 | 问题 | 优先级 | 建议 |
|------|------|--------|------|
| `browser-manager.ts` | 1235 行，职责过多 | P2 | 拆分为 BrowserLifecycle、TabManager |
| `server.ts` | 2392 行，路由和逻辑混合 | P3 | 提取路由配置 |
| Cookie 解密 | 仅支持 macOS | P2 | 添加 Linux/Windows 支持 |
| `write-commands.ts` | 919 行 | P3 | 按类别拆分 |
| E2E 测试 | 依赖 `claude -p`，成本高 | P2 | 更多单元测试替代 |

### 8.2 架构演进建议

**短期（1-3 个月）：**
1. 添加 Linux/Windows Cookie 解密支持
2. 拆分 `browser-manager.ts` 为更小的模块
3. 增加单元测试覆盖率到 90%

**中期（3-6 个月）：**
1. 实现真正的 Session 隔离（独立 cookie/storage）
2. 视频录制功能
3. 网络拦截/模拟

**长期（6-12 个月）：**
1. Chrome DevTools MCP 集成
2. ML 提示注入分类器
3. 多浏览器支持（Firefox、WebKit）

---

## 9. 失败模式分析

### 9.1 生产故障场景

| 场景 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| Chromium 崩溃 | 中 | 高 | 自动重启，状态恢复 |
| 内存不足 | 低 | 高 | 缓冲区大小限制 |
| Cookie 解密失败 | 中（非 macOS） | 中 | 优雅降级，提示用户 |
| 端口冲突 | 低 | 低 | 随机端口 + 重试 |
| DNS 重绑定 | 低 | 高 | 多层验证（已实现） |

### 9.2 恢复策略

```typescript
// Chromium 崩溃处理
browser.on('disconnected', () => {
  console.error('[browse] FATAL: Chromium crashed');
  process.exit(1);  // 退出，让 CLI 重启
});

// CLI 下次调用时
try {
  await healthCheck();
} catch {
  // 服务器无响应，启动新实例
  await spawnServer();
}
```

---

## 10. 并行化策略

### 10.1 工作流依赖分析

| 工作流 | 模块 | 依赖 | 可并行 |
|--------|------|------|--------|
| Browse 核心 | `browse/src/` | - | ✅ |
| Skills | `*/SKILL.md.tmpl` | gen-skill-docs.ts | ✅ |
| Design 二进制 | `design/src/` | - | ✅ |
| Chrome 扩展 | `extension/` | - | ✅ |
| 测试基础设施 | `test/helpers/` | 所有模块 | ❌ |

### 10.2 推荐工作流

```
阶段 1（并行）:
  ├── 工作流 A: Browse 核心优化
  ├── 工作流 B: Skills 模板更新
  ├── 工作流 C: Design 功能添加
  └── 工作流 D: Chrome 扩展改进

阶段 2（合并后）:
  └── 更新测试基础设施
  └── 运行完整 E2E 测试
```

---

## 11. 与其他系统的集成

### 11.1 AI Agent 支持

| Agent | 配置位置 | 状态 |
|-------|----------|------|
| Claude | `hosts/claude.ts` | ✅ 主支持 |
| OpenCode | `hosts/opencode.ts` | ✅ 已适配 |

### 11.2 部署目标

| 平台 | 支持 | 方式 |
|------|------|------|
| macOS | ✅ | 原生二进制 |
| Linux | ✅ | 从源码构建 |
| Windows | ✅ | Node.js 回退模式（内网适配） |
| Docker | ✅ | Dockerfile.ci |

---

## 12. 内网环境适配改造（已实施）

### 12.1 改造背景

针对严格受限的内网环境（无外网直连、拦截未经签名 `.exe`、Windows 宿主），已完成以下改造：

### 12.2 已实施的变更

| 变更项 | 位置 | 实现 |
|--------|------|------|
| Agent 配置裁剪 | `hosts/index.ts` | 仅保留 `claude` 和 `opencode` |
| Playwright 切换 | `browse/src/browser-manager.ts` | 从 `playwright` 切换到 `playwright-core` |
| Chrome 路径配置 | `browse/src/browser-manager.ts` | 支持 `GSTACK_CHROMIUM_PATH` 环境变量 |
| Node CLI 包装器 | `browse/dist/browse.js` | Windows 下使用 `bun run` 执行源码 |
| 禁用更新检查 | `bin/gstack-update-check` | `GSTACK_ENABLE_UPDATE_CHECK=0` 时跳过 |
| 内网模式检测 | `setup` 脚本 | `GSTACK_INTERNAL_NETWORK=1` 时启用 |

### 12.3 关键代码片段

**Playwright-core 配置：**
```typescript
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.GSTACK_CHROMIUM_PATH || getChromePathFromConfig(),
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
```

**版本检查跳过：**
```typescript
if (process.env.GSTACK_DISABLE_VERSION_CHECK === '1') {
  console.log('[browse] Version mismatch detected but GSTACK_DISABLE_VERSION_CHECK is set, continuing...');
} else {
  console.error('[browse] Binary updated, restarting server...');
  await killServer(state.pid);
  return startServer();
}
```

---

## 13. 参考文档

### 13.1 关键文件

```
CLAUDE.md              # 开发指南
ARCHITECTURE.md        # 架构概述（现有）
ETHOS.md               # 构建哲学
TODOS.md               # 待办事项
SKILL.md.tmpl          # 技能模板源文件
scripts/gen-skill-docs.ts  # 文档生成器
```

### 13.2 代码统计

```bash
# TypeScript 文件统计
$ find . -name "*.ts" -not -path "./node_modules/*" | wc -l
~173 文件

# 代码行数统计
$ find browse/src -name "*.ts" | xargs wc -l
total: ~12,704 行

# 测试文件统计
$ find test browse/test -name "*.test.ts" | wc -l
~60 个测试文件
```

---

## 14. 附录：版本历史

| 版本 | 日期 | 主要变更 |
|------|------|----------|
| v0.16.2.0 | 2026-04 | 当前版本，内网适配完成 |
| v0.16.x.x | 2026-04 | Node CLI 包装器，playwright-core 迁移 |
| v0.15.16.0 | 2026-04 | TabSession 提取，状态隔离 |
| v0.15.15.1 | 2026-04 | Pair-agent 隧道修复 |
| v0.15.15.0 | 2026-04 | 内容安全层，4 层防御 |
| v0.12.1.0 | 2026-03 | iframe 支持，状态持久化 |

---

**报告结束**

本架构文档应作为后续工程改造的参考依据。建议在进行重大变更前重新审视相关章节，确保架构一致性。
