# gstack 内网环境适配改造计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 改造 gstack 工程以适应 Windows 内网环境（无 .exe 执行权限、无外网访问、需使用本地 Chrome），支持源码直驱运行模式。

**Architecture:** 
1. 精简 Host 配置，仅保留 Claude Code 和 OpenCode 支持
2. 将 Bun 编译的 .exe 二进制文件改造为 Node.js CLI 脚本（`bun run browse/src/cli.ts` 模式）
3. 使用 playwright-core 替代 playwright，支持外部 Chrome 路径配置（通过 `GSTACK_CHROMIUM_PATH` 或 `~/.gstack/config.yaml`）
4. 通过环境变量完全禁用自动更新检查、版本检查机制

**Tech Stack:** TypeScript, Node.js, Bun (构建时), Playwright Core

---

## 文件结构概览

| 模块 | 文件 | 说明 |
|------|------|------|
| Host 配置 | `hosts/index.ts` | Host 注册表，需剔除多余 hosts |
| Host 配置 | `hosts/claude.ts` | Claude Code 配置（保留） |
| Host 配置 | `hosts/opencode.ts` | OpenCode 配置（保留） |
| CLI 构建 | `package.json` | build 脚本，生成 .exe 文件 |
| CLI 入口 | `browse/src/cli.ts` | 浏览器 CLI 入口，含版本检查逻辑 |
| CLI 查找 | `browse/src/find-browse.ts` | 查找 browse 可执行文件 |
| Server 入口 | `browse/src/server.ts` | 浏览器 Server 入口，含 BROWSE_BIN 定义 |
| 浏览器管理 | `browse/src/browser-manager.ts` | Chromium 启动逻辑，需 playwright-core 改造 |
| Node 兼容构建 | `browse/scripts/build-node-server.sh` | Windows Node 构建脚本 |
| Setup 脚本 | `setup` | 安装脚本，需支持 Node CLI 模式 |
| 更新检查 | `bin/gstack-update-check` | 更新检查脚本 |
| 技能模板 | `scripts/resolvers/browse.ts` | Browse 命令 resolver |
| 技能模板 | `scripts/resolvers/design.ts` | Design 命令 resolver |
| 技能模板 | `scripts/resolvers/preamble.ts` | 技能前导模板（含更新检查） |
| 技能模板 | `SKILL.md.tmpl` | 主技能模板 |

---

## 核心环境变量

改造后的系统支持以下环境变量：

| 变量名 | 必需 | 说明 |
|--------|------|------|
| `GSTACK_CHROMIUM_PATH` | 是 | Chrome/Chromium 可执行文件完整路径 |
| `GSTACK_INTERNAL_NETWORK` | 是 | 设置为 `1` 启用内网模式（Node CLI + 禁用更新） |
| `GSTACK_ENABLE_UPDATE_CHECK` | 否 | 设置为 `0` 禁用更新检查 |
| `GSTACK_DISABLE_VERSION_CHECK` | 否 | 设置为 `1` 禁用版本不匹配重启 |
| `GSTACK_AUTO_UPGRADE` | 否 | 设置为 `0` 禁用自动升级 |

---

## 任务 1: 精简 Host 配置（仅保留 Claude Code 和 OpenCode）

**Files:**
- Modify: `hosts/index.ts`
- Delete: `hosts/codex.ts`, `hosts/cursor.ts`, `hosts/factory.ts`, `hosts/kiro.ts`, `hosts/openclaw.ts`, `hosts/slate.ts`

**说明:** 内网环境仅使用 Claude Code 和 OpenCode，需要移除其他 host 配置并清理引用。

- [ ] **Step 1: 修改 hosts/index.ts 仅保留 claude 和 opencode**

```typescript
// hosts/index.ts
/**
 * Host config registry.
 *
 * Import all host configs and derive the Host union type.
 * Adding a new host: create hosts/myhost.ts, import here, add to ALL_HOST_CONFIGS.
 */

import type { HostConfig } from '../scripts/host-config';
import claude from './claude';
import opencode from './opencode';

/** All registered host configs. Add new hosts here. */
export const ALL_HOST_CONFIGS: HostConfig[] = [claude, opencode];

/** Map from host name to config. */
export const HOST_CONFIG_MAP: Record<string, HostConfig> = Object.fromEntries(
  ALL_HOST_CONFIGS.map(c => [c.name, c])
);

/** Union type of all host names, derived from configs. */
export type Host = (typeof ALL_HOST_CONFIGS)[number]['name'];

/** All host names as a string array (for CLI arg validation, etc.). */
export const ALL_HOST_NAMES: string[] = ALL_HOST_CONFIGS.map(c => c.name);

/** Get a host config by name. Throws if not found. */
export function getHostConfig(name: string): HostConfig {
  const config = HOST_CONFIG_MAP[name];
  if (!config) {
    throw new Error(`Unknown host '${name}'. Valid hosts: ${ALL_HOST_NAMES.join(', ')}`);
  }
  return config;
}

/**
 * Resolve a host name from a CLI argument, handling aliases.
 * e.g., 'agents' → 'codex', 'droid' → 'factory'
 */
export function resolveHostArg(arg: string): string {
  // Direct name match
  if (HOST_CONFIG_MAP[arg]) return arg;

  // Alias match
  for (const config of ALL_HOST_CONFIGS) {
    if (config.cliAliases?.includes(arg)) return config.name;
  }

  throw new Error(`Unknown host '${arg}'. Valid hosts: ${ALL_HOST_NAMES.join(', ')}`);
}

/**
 * Get hosts that are NOT the primary host (Claude).
 * These are the hosts that need generated skill docs.
 */
export function getExternalHosts(): HostConfig[] {
  return ALL_HOST_CONFIGS.filter(c => c.name !== 'claude');
}

// Re-export individual configs for direct import
export { claude, opencode };
```

- [ ] **Step 2: 删除其他 host 配置文件**

```bash
rm -f hosts/codex.ts hosts/cursor.ts hosts/factory.ts hosts/kiro.ts hosts/openclaw.ts hosts/slate.ts
```

Expected: 文件被删除，无报错

- [ ] **Step 3: 提交更改**

```bash
git add hosts/
git commit -m "refactor: remove unused host configs, keep only claude and opencode"
```

---

## 任务 2: .exe → Node CLI 改造

**Files:**
- Create: `browse/dist/browse.js` (Node CLI 包装器)
- Create: `browse/dist/find-browse.js` (Node CLI 包装器)
- Create: `design/dist/design.js` (Node CLI 包装器)
- Create: `scripts/build-node-cli.js` (构建脚本)
- Modify: `browse/src/find-browse.ts` (支持 .js 包装器)
- Modify: `browse/src/server.ts` (BROWSE_BIN 支持 .js)
- Modify: `package.json` (更新 bin 入口和 scripts)

**说明:** 根据 package.json build 脚本，会生成以下 .exe 文件：
- `browse/dist/browse`
- `browse/dist/find-browse`
- `design/dist/design`
- `bin/gstack-global-discover`

通过创建 .js 包装器调用 `bun run <source>.ts`，可完全等效替代 .exe 功能。

- [ ] **Step 1: 创建 browse/dist/browse.js 包装器**

```javascript
#!/usr/bin/env node
/**
 * gstack browse - Node.js CLI wrapper for internal network environments
 * 
 * Replaces the compiled .exe binary. Requires bun in PATH.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '..', 'src');
const cliPath = join(srcDir, 'cli.ts');

const child = spawn('bun', ['run', cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
  windowsHide: false,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[gstack] Failed to start:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: 创建 browse/dist/find-browse.js 包装器**

```javascript
#!/usr/bin/env node
/**
 * gstack find-browse - Node.js CLI wrapper
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '..', 'src');
const scriptPath = join(srcDir, 'find-browse.ts');

const child = spawn('bun', ['run', scriptPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[gstack] Failed to start:', err.message);
  process.exit(1);
});
```

- [ ] **Step 3: 创建 design/dist/design.js 包装器**

```javascript
#!/usr/bin/env node
/**
 * gstack design - Node.js CLI wrapper
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '..', 'src');
const cliPath = join(srcDir, 'cli.ts');

const child = spawn('bun', ['run', cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[gstack] Failed to start:', err.message);
  process.exit(1);
});
```

- [ ] **Step 4: 创建 scripts/build-node-cli.js 构建脚本**

```javascript
#!/usr/bin/env node
/**
 * Build script for Node.js CLI mode (no .exe compilation)
 */

import { chmod, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const gitHash = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  
  // Ensure dist directories exist
  await mkdir(join(__dirname, '..', 'browse', 'dist'), { recursive: true });
  await mkdir(join(__dirname, '..', 'design', 'dist'), { recursive: true });
  
  // Make wrapper scripts executable
  const wrappers = [
    'browse/dist/browse.js',
    'browse/dist/find-browse.js',
    'design/dist/design.js',
  ];
  
  for (const wrapper of wrappers) {
    const wrapperPath = join(__dirname, '..', wrapper);
    if (existsSync(wrapperPath)) {
      await chmod(wrapperPath, 0o755);
      console.log(`Made executable: ${wrapper}`);
    } else {
      console.warn(`Warning: ${wrapper} not found`);
    }
  }
  
  // Write version files
  await writeFile(join(__dirname, '..', 'browse', 'dist', '.version'), gitHash);
  await writeFile(join(__dirname, '..', 'design', 'dist', '.version'), gitHash);
  
  console.log('Node CLI build complete');
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
```

- [ ] **Step 5: 修改 browse/src/find-browse.ts 支持 .js 包装器**

```typescript
// browse/src/find-browse.ts
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function getGitRoot(): string | null {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim();
  } catch {
    return null;
  }
}

export function locateBinary(): string | null {
  const root = getGitRoot();
  const home = homedir();
  const markers = ['.codex', '.agents', '.claude'];

  // Workspace-local takes priority
  if (root) {
    for (const m of markers) {
      // Try .js wrapper first (internal network mode)
      const localJs = join(root, m, 'skills', 'gstack', 'browse', 'dist', 'browse.js');
      if (existsSync(localJs)) return localJs;
      // Fall back to compiled binary
      const local = join(root, m, 'skills', 'gstack', 'browse', 'dist', 'browse');
      if (existsSync(local)) return local;
    }
  }

  // Global fallback
  for (const m of markers) {
    // Try .js wrapper first
    const globalJs = join(home, m, 'skills', 'gstack', 'browse', 'dist', 'browse.js');
    if (existsSync(globalJs)) return globalJs;
    // Fall back to compiled binary
    const global = join(home, m, 'skills', 'gstack', 'browse', 'dist', 'browse');
    if (existsSync(global)) return global;
  }

  return null;
}

function main() {
  const bin = locateBinary();
  if (!bin) {
    process.stderr.write('ERROR: browse binary not found. Run: cd <skill-dir> && ./setup\n');
    process.exit(1);
  }

  console.log(bin);
}

main();
```

- [ ] **Step 6: 修改 browse/src/server.ts 中的 findBrowseBin**

找到 `findBrowseBin` 函数（约 240 行），修改为：

```typescript
function findBrowseBin(): string {
  // Try .js wrapper first (internal network mode)
  const jsPath = path.resolve(__dirname, '..', 'dist', 'browse.js');
  if (fs.existsSync(jsPath)) {
    return `bun run ${jsPath}`;
  }
  
  // Fall back to compiled binary
  const binPath = path.resolve(__dirname, '..', 'dist', 'browse');
  if (fs.existsSync(binPath)) {
    return binPath;
  }
  
  return 'browse'; // Fallback to PATH lookup
}
```

- [ ] **Step 7: 修改 package.json**

```json
{
  "name": "gstack",
  "version": "0.15.15.0",
  "license": "MIT",
  "type": "module",
  "bin": {
    "browse": "./browse/dist/browse.js",
    "find-browse": "./browse/dist/find-browse.js",
    "design": "./design/dist/design.js"
  },
  "scripts": {
    "build": "bun run gen:skill-docs --host all; bun build --compile browse/src/cli.ts --outfile browse/dist/browse && bun build --compile browse/src/find-browse.ts --outfile browse/dist/find-browse && bun build --compile design/src/cli.ts --outfile design/dist/design && bun build --compile bin/gstack-global-discover.ts --outfile bin/gstack-global-discover && bash browse/scripts/build-node-server.sh && git rev-parse HEAD > browse/dist/.version && git rev-parse HEAD > design/dist/.version && chmod +x browse/dist/browse browse/dist/find-browse design/dist/design bin/gstack-global-discover && rm -f .*.bun-build || true",
    "build:node": "bun run gen:skill-docs --host all && bash browse/scripts/build-node-server.sh && node scripts/build-node-cli.js",
    ...
  },
  "dependencies": {
    "@ngrok/ngrok": "^1.7.0",
    "diff": "^7.0.0",
    "playwright-core": "^1.58.2",
    "puppeteer-core": "^24.40.0"
  }
}
```

- [ ] **Step 8: 提交更改**

```bash
chmod +x browse/dist/browse.js browse/dist/find-browse.js design/dist/design.js
git add package.json browse/dist/*.js design/dist/*.js scripts/build-node-cli.js
git add browse/src/find-browse.ts browse/src/server.ts
git commit -m "feat: add Node.js CLI wrappers and build:node script for internal network compatibility"
```

---

## 任务 3: Playwright → Playwright-Core 迁移 + Chrome 路径配置

**Files:**
- Modify: `package.json` (依赖项)
- Modify: `browse/src/browser-manager.ts` (chromium 启动逻辑)
- Modify: `browse/src/read-commands.ts` (import 更新)
- Modify: `browse/src/tab-session.ts` (import 更新)
- Modify: `browse/src/cdp-inspector.ts` (import 更新)
- Modify: `browse/src/content-security.ts` (import 更新)
- Modify: `browse/src/meta-commands.ts` (import 更新)
- Modify: `browse/src/snapshot.ts` (import 更新)
- Modify: `browse/scripts/build-node-server.sh` (external 列表)
- Modify: `bin/gstack-config` (添加 chromium_path 支持)

**说明:** 
- playwright-core 不包含浏览器下载，适合内网环境
- 通过环境变量 `GSTACK_CHROMIUM_PATH` 或配置文件指定 Chrome 路径
- 如果未配置路径，抛出错误而不是尝试自动检测

- [ ] **Step 1: 修改 package.json 依赖**

```json
{
  "dependencies": {
    "@ngrok/ngrok": "^1.7.0",
    "diff": "^7.0.0",
    "playwright-core": "^1.58.2",
    "puppeteer-core": "^24.40.0"
  }
}
```

- [ ] **Step 2: 修改 browser-manager.ts**

```typescript
// 第 18 行: 修改 import
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Locator, type Cookie } from 'playwright-core';

// 在 BrowserManager 类中添加配置读取方法
private getChromePath(): string | undefined {
  // 1. 环境变量最高优先级
  if (process.env.GSTACK_CHROMIUM_PATH) {
    return process.env.GSTACK_CHROMIUM_PATH;
  }
  
  // 2. 配置文件 (~/.gstack/config.yaml)
  try {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(process.env.HOME || '/tmp', '.gstack', 'config.yaml');
    if (fs.existsSync(configPath)) {
      const config = fs.readFileSync(configPath, 'utf-8');
      const match = config.match(/^chromium_path:\s*(.+)$/m);
      if (match) {
        const chromePath = match[1].trim();
        if (fs.existsSync(chromePath)) {
          return chromePath;
        }
      }
    }
  } catch {
    // ignore config read errors
  }
  
  return undefined;
}

// 修改 launchHeaded 方法中的 chrome 路径获取逻辑（约 259 行）
// 原代码:
// const executablePath = process.env.GSTACK_CHROMIUM_PATH || undefined;
// const chromePath = executablePath || chromium.executablePath();

// 新代码:
const chromePath = this.getChromePath();
if (!chromePath) {
  throw new Error(
    'Chrome/Chromium path not configured. ' +
    'Please set GSTACK_CHROMIUM_PATH environment variable ' +
    'or add "chromium_path: /path/to/chrome.exe" to ~/.gstack/config.yaml'
  );
}

// 类似修改其他位置的 chromium.executablePath() 调用（约 303 行）
```

- [ ] **Step 3: 更新所有 playwright import 为 playwright-core**

修改以下文件中的 import：
- `browse/src/read-commands.ts`
- `browse/src/tab-session.ts`
- `browse/src/cdp-inspector.ts`
- `browse/src/content-security.ts`
- `browse/src/meta-commands.ts`
- `browse/src/snapshot.ts`

将 `from 'playwright'` 改为 `from 'playwright-core'`

```bash
sed -i "s/from 'playwright'/from 'playwright-core'/g" browse/src/read-commands.ts browse/src/tab-session.ts browse/src/cdp-inspector.ts browse/src/content-security.ts browse/src/meta-commands.ts browse/src/snapshot.ts
```

- [ ] **Step 4: 更新 build-node-server.sh**

```bash
# 修改 external 列表
bun build "$SRC_DIR/server.ts" \
  --target=node \
  --outfile "$DIST_DIR/server-node.mjs" \
  --external playwright-core \
  --external diff \
  --external "bun:sqlite"
```

- [ ] **Step 5: 修改 bin/gstack-config 添加 chromium_path 支持**

在 gstack-config 脚本中添加：

```bash
case "$1" in
  get)
    case "$2" in
      chromium_path)
        grep "^chromium_path:" "$CONFIG_FILE" 2>/dev/null | sed 's/^chromium_path: *//' || echo ""
        ;;
      # ... existing cases
    esac
    ;;
  set)
    case "$2" in
      chromium_path)
        update_config "$2" "$3"
        ;;
      # ... existing cases
    esac
    ;;
esac
```

- [ ] **Step 6: 提交更改**

```bash
git add package.json browse/src/*.ts browse/scripts/build-node-server.sh bin/gstack-config
git commit -m "feat: migrate from playwright to playwright-core with configurable chrome path"
```

---

## 任务 4: 关闭自动更新检查机制

**Files:**
- Modify: `bin/gstack-update-check` (默认禁用)
- Modify: `browse/src/cli.ts` (版本检查绕过)
- Modify: `scripts/resolvers/preamble.ts` (移除更新检查调用)
- Modify: `SKILL.md.tmpl` 和其他 .tmpl 文件

**说明:** 内网环境无法访问外部网络，需要完全关闭自动更新检查。

- [ ] **Step 1: 修改 bin/gstack-update-check**

在脚本开头添加禁用检查：

```bash
#!/usr/bin/env bash
# gstack-update-check — periodic version check for all skills.

# 内网环境：默认禁用更新检查
if [ "${GSTACK_ENABLE_UPDATE_CHECK:-0}" != "1" ]; then
  exit 0
fi

# ... rest of the script remains unchanged
```

- [ ] **Step 2: 修改 browse/src/cli.ts 版本检查逻辑**

找到 cli.ts 第 324-328 行，修改为：

```typescript
// Check for binary version mismatch (auto-restart on update)
const currentVersion = readVersionHash();
if (currentVersion && state.binaryVersion && currentVersion !== state.binaryVersion) {
  if (process.env.GSTACK_DISABLE_VERSION_CHECK === '1') {
    // Internal network: skip version check
    console.log('[browse] Version mismatch detected but GSTACK_DISABLE_VERSION_CHECK is set, continuing...');
  } else {
    console.error('[browse] Binary updated, restarting server...');
    await killServer(state.pid);
    return startServer();
  }
}
```

- [ ] **Step 3: 修改 preamble.ts**

在 `scripts/resolvers/preamble.ts` 的 `generatePreambleBash` 函数中，注释掉更新检查调用：

```typescript
function generatePreambleBash(ctx: TemplateContext): string {
  // ... existing code ...

  return `## Preamble (run first)

\`\`\`bash
${runtimeRoot}# Update check disabled for internal network environment
# _UPD=$(${ctx.paths.binDir}/gstack-update-check 2>/dev/null || ${ctx.paths.localSkillRoot}/bin/gstack-update-check 2>/dev/null || true)
# [ -n "$_UPD" ] && echo "$_UPD" || true
_UPD=""
... rest of preamble
```

- [ ] **Step 4: 修改 SKILL.md.tmpl**

找到并注释掉更新检查相关的内容：

```markdown
<!-- Update check disabled for internal network environment
If output shows `UPGRADE_AVAILABLE <old> <new>`: read ...
-->
```

- [ ] **Step 5: 重新生成 SKILL.md**

```bash
bun run gen:skill-docs
```

- [ ] **Step 6: 提交更改**

```bash
git add bin/gstack-update-check browse/src/cli.ts scripts/resolvers/preamble.ts
git add SKILL.md.tmpl */SKILL.md.tmpl */SKILL.md
git commit -m "feat: disable auto-update check for internal network environments"
```

---

## 任务 5: Setup 脚本改造支持内网模式

**Files:**
- Modify: `setup`

**说明:** setup 脚本需要检测内网模式并跳过 .exe 构建。

- [ ] **Step 1: 在 setup 中添加内网模式检测**

在 setup 脚本开头（约第 26 行后）添加：

```bash
IS_WINDOWS=0
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) IS_WINDOWS=1 ;;
esac

# 内网模式检测
INTERNAL_NETWORK=0
if [ "${GSTACK_INTERNAL_NETWORK:-0}" = "1" ]; then
  INTERNAL_NETWORK=1
fi
```

- [ ] **Step 2: 修改 build 逻辑**

找到 build 逻辑（约 207-218 行），修改为：

```bash
if [ "$NEEDS_BUILD" -eq 1 ]; then
  if [ "$INTERNAL_NETWORK" -eq 1 ]; then
    log "Building gstack for internal network (Node CLI mode)..."
    (
      cd "$SOURCE_GSTACK_DIR"
      bun install
      bun run build:node
    )
  else
    log "Building browse binary..."
    (
      cd "$SOURCE_GSTACK_DIR"
      bun install
      bun run build
    )
  fi
  # ... rest of logic
fi
```

- [ ] **Step 3: 修改 ensure_playwright_browser 函数**

```bash
ensure_playwright_browser() {
  if [ "$IS_WINDOWS" -eq 1 ]; then
    (
      cd "$SOURCE_GSTACK_DIR"
      # Use playwright-core with configured chrome path
      node -e "const { chromium } = require('playwright-core'); (async () => { const chromePath = process.env.GSTACK_CHROMIUM_PATH; if (!chromePath) { console.error('GSTACK_CHROMIUM_PATH not set'); process.exit(1); } const b = await chromium.launch({ executablePath: chromePath }); await b.close(); })()" 2>/dev/null
    )
  else
    (
      cd "$SOURCE_GSTACK_DIR"
      bun --eval 'import { chromium } from "playwright-core"; const chromePath = process.env.GSTACK_CHROMIUM_PATH; if (!chromePath) { console.error("GSTACK_CHROMIUM_PATH not set"); process.exit(1); } const browser = await chromium.launch({ executablePath: chromePath }); await browser.close();'
    ) >/dev/null 2>&1
  fi
}
```

- [ ] **Step 4: 提交更改**

```bash
git add setup
git commit -m "feat: add GSTACK_INTERNAL_NETWORK mode to setup script"
```

---

## 任务 6: Skill Resolvers 更新

**Files:**
- Modify: `scripts/resolvers/browse.ts`
- Modify: `scripts/resolvers/design.ts`

**说明:** 更新技能模板中的 `$B` 变量定义，支持 Node CLI 模式。

- [ ] **Step 1: 修改 browse.ts resolver**

找到约 108 行的 B 变量定义，修改为：

```typescript
// 原代码:
// [ -n "$_ROOT" ] && [ -x "$_ROOT/${ctx.paths.localSkillRoot}/browse/dist/browse" ] && B="$_ROOT/${ctx.paths.localSkillRoot}/browse/dist/browse"

// 新代码:
# Try .js wrapper first (internal network compatible), then binary
[ -n "$_ROOT" ] && [ -f "$_ROOT/${ctx.paths.localSkillRoot}/browse/dist/browse.js" ] && B="bun run $_ROOT/${ctx.paths.localSkillRoot}/browse/dist/browse.js"
[ -n "$_ROOT" ] && [ -z "$B" ] && [ -x "$_ROOT/${ctx.paths.localSkillRoot}/browse/dist/browse" ] && B="$_ROOT/${ctx.paths.localSkillRoot}/browse/dist/browse"
```

- [ ] **Step 2: 修改 design.ts resolver**

类似地更新 design 命令的路径解析逻辑。

- [ ] **Step 3: 重新生成 SKILL.md 并提交**

```bash
bun run gen:skill-docs
git add scripts/resolvers/browse.ts scripts/resolvers/design.ts */SKILL.md
git commit -m "feat: update skill resolvers to support Node CLI mode"
```

---

## 附录 A: 完整文件清单

### 需修改的文件
1. `hosts/index.ts`
2. `package.json`
3. `browse/src/browser-manager.ts`
4. `browse/src/read-commands.ts`
5. `browse/src/tab-session.ts`
6. `browse/src/cdp-inspector.ts`
7. `browse/src/content-security.ts`
8. `browse/src/meta-commands.ts`
9. `browse/src/snapshot.ts`
10. `browse/src/cli.ts`
11. `browse/src/find-browse.ts`
12. `browse/src/server.ts`
13. `browse/scripts/build-node-server.sh`
14. `bin/gstack-update-check`
15. `bin/gstack-config`
16. `scripts/resolvers/preamble.ts`
17. `scripts/resolvers/browse.ts`
18. `scripts/resolvers/design.ts`
19. `SKILL.md.tmpl`
20. `setup`

### 需删除的文件
1. `hosts/codex.ts`
2. `hosts/cursor.ts`
3. `hosts/factory.ts`
4. `hosts/kiro.ts`
5. `hosts/openclaw.ts`
6. `hosts/slate.ts`

### 需创建的文件
1. `browse/dist/browse.js`
2. `browse/dist/find-browse.js`
3. `design/dist/design.js`
4. `scripts/build-node-cli.js`

---

## 附录 B: 内网环境部署指南

### 1. 准备阶段（外网机器）

```bash
# 克隆代码
git clone <repo-url>
cd gstack

# 切换到改造后的分支
git checkout <internal-network-branch>

# 安装依赖
bun install

# 构建 Node CLI 版本
bun run build:node
```

### 2. 打包迁移

```bash
# 打包整个项目（包含 node_modules）
tar -czf gstack-internal.tar.gz gstack/

# 或者使用 zip（Windows 友好）
zip -r gstack-internal.zip gstack/ -x "*.git*"
```

### 3. 内网机器部署

```bash
# 解压
tar -xzf gstack-internal.tar.gz
cd gstack

# 设置环境变量并运行 setup
set GSTACK_INTERNAL_NETWORK=1
set GSTACK_CHROMIUM_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
set GSTACK_ENABLE_UPDATE_CHECK=0
set GSTACK_DISABLE_VERSION_CHECK=1
./setup
```

### 4. 验证

```bash
# 验证 browse 命令
bun run browse/src/cli.ts --help

# 验证配置
bun run bin/gstack-config get chromium_path
```

### 5. 配置文件示例

`~/.gstack/config.yaml`:
```yaml
chromium_path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
update_check: false
auto_upgrade: false
```

---

**Plan End**
