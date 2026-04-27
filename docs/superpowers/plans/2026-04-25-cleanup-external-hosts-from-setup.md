# 清理 setup 脚本外部 host 安装逻辑

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 setup 脚本中删除 Codex/Factory/Kiro 的安装逻辑，仅保留 Claude Code 支持。

**Architecture:** 删除外部 host 变量、参数、函数和安装调用，简化 `--host` 只支持 `claude|auto`（auto 仅检测 claude），消除对内网无用的外部 host 生成和安装代码。

**Tech Stack:** bash, bun test, git worktree

---

## 文件结构

- **Modify:** `setup` — 删除外部 host 变量、参数解析、函数、安装逻辑（约 200-250 行）
- **Test:** `bun test` — 验证 host-config 测试仍通过
- **Verify:** `bash -n setup` — 脚本语法检查
- **Verify:** 在临时目录中运行 `./setup --local` 确认仅安装 Claude skill

---

## 变更映射

setup 脚本中需要删除/简化的代码块：

| 位置 | 内容 | 操作 |
|------|------|------|
| L21-24 | `CODEX_SKILLS`, `CODEX_GSTACK`, `FACTORY_SKILLS`, `FACTORY_GSTACK` | 删除 |
| L51 | `--host` 帮助文本 | 改为 "expected claude or auto" |
| L64 | `claude|codex|kiro|factory|auto` | 改为 `claude|auto` |
| L65-76 | `openclaw` 分支 | 删除 |
| L77 | 错误消息中的 host 列表 | 改为 "expected claude or auto" |
| L125-127 | `--local` 中 codex 不支持检查 | 删除 |
| L132 | `INSTALL_CODEX=0` | 删除 |
| L137-139 | `INSTALL_CODEX`, `INSTALL_KIRO`, `INSTALL_FACTORY` 初始化 | 删除 |
| L142-144 | auto 模式下 codex/kiro/droid 检测 | 删除 |
| L146 | 全零检查 | 简化为只判断 `INSTALL_CLAUDE` |
| L151-156 | codex/kiro/factory 的 elif 分支 | 删除 |
| L159-184 | `migrate_direct_codex_install` 函数及调用 | 删除 |
| L255-275 | `.agents/` 和 `.factory/` skill docs 生成 | 删除 |
| L446-480 | `link_codex_skill_dirs` 函数 | 删除 |
| L486-512 | `create_agents_sidecar` 函数 | 保留（可能被其他地方引用），但其调用删除 |
| L518-558 | `create_codex_runtime_root` 函数 | 删除 |
| L560-596 | `create_factory_runtime_root` 函数 | 删除 |
| L598-628 | `link_factory_skill_dirs` 函数 | 删除 |
| L633-636 | `CODEX_REPO_LOCAL` 变量 | 删除 |
| L705-724 | Codex 安装逻辑（第 5 步） | 删除 |
| L726-780 | Kiro 安装逻辑（第 6 步） | 删除 |
| L782-790 | Factory 安装逻辑（第 6b 步） | 删除 |
| L792-797 | `create_agents_sidecar` 调用 | 删除 |

---

## Task 1: 删除外部 host 变量和参数解析

**Files:**
- Modify: `setup:21-24`
- Modify: `setup:51`
- Modify: `setup:64-77`
- Modify: `setup:125-132`
- Modify: `setup:136-156`

- [ ] **Step 1: 删除外部 host 变量定义**

删除 `CODEX_SKILLS`, `CODEX_GSTACK`, `FACTORY_SKILLS`, `FACTORY_GSTACK` 四行：

```bash
# 修改前 (L21-24)
BROWSE_BIN="$SOURCE_GSTACK_DIR/browse/dist/browse"
CODEX_SKILLS="$HOME/.codex/skills"
CODEX_GSTACK="$CODEX_SKILLS/gstack"
FACTORY_SKILLS="$HOME/.factory/skills"
FACTORY_GSTACK="$FACTORY_SKILLS/gstack"

# 修改后
BROWSE_BIN="$SOURCE_GSTACK_DIR/browse/dist/browse"
```

- [ ] **Step 2: 简化 --host 参数解析**

```bash
# 修改前 (L51)
--host) [ -z "$2" ] && echo "Missing value for --host (expected claude, codex, kiro, or auto)" >&2 && exit 1; HOST="$2"; shift 2 ;;

# 修改后
--host) [ -z "$2" ] && echo "Missing value for --host (expected claude or auto)" >&2 && exit 1; HOST="$2"; shift 2 ;;
```

- [ ] **Step 3: 简化 host case 并删除 openclaw 分支**

```bash
# 修改前 (L64-78)
case "$HOST" in
  claude|codex|kiro|factory|auto) ;;
  openclaw)
    echo ""
    echo "OpenClaw integration uses a different model..."
    ...
    exit 0 ;;
  *) echo "Unknown --host value: $HOST (expected claude, codex, kiro, factory, openclaw, or auto)" >&2; exit 1 ;;
esac

# 修改后
case "$HOST" in
  claude|auto) ;;
  *) echo "Unknown --host value: $HOST (expected claude or auto)" >&2; exit 1 ;;
esac
```

- [ ] **Step 4: 简化 --local 逻辑**

删除 `--local` 块中 codex 检查（L125-127）和 `INSTALL_CODEX=0`（L132）：

```bash
# 修改前 (L122-133)
if [ "$LOCAL_INSTALL" -eq 1 ]; then
  echo "Warning: --local is deprecated..." >&2
  echo "  See: https://github.com/garrytan/gstack#team-mode" >&2
  if [ "$HOST" = "codex" ]; then
    echo "Error: --local is only supported for Claude Code (not Codex)." >&2
    exit 1
  fi
  INSTALL_SKILLS_DIR="$(pwd)/.claude/skills"
  mkdir -p "$INSTALL_SKILLS_DIR"
  HOST="claude"
  INSTALL_CODEX=0
fi

# 修改后
if [ "$LOCAL_INSTALL" -eq 1 ]; then
  echo "Warning: --local is deprecated. Use global install + --team instead." >&2
  echo "  See: https://github.com/garrytan/gstack#team-mode" >&2
  INSTALL_SKILLS_DIR="$(pwd)/.claude/skills"
  mkdir -p "$INSTALL_SKILLS_DIR"
  HOST="claude"
fi
```

- [ ] **Step 5: 简化 INSTALL 变量和分支**

```bash
# 修改前 (L136-157)
# For auto: detect which agents are installed
INSTALL_CLAUDE=0
INSTALL_CODEX=0
INSTALL_KIRO=0
INSTALL_FACTORY=0
if [ "$HOST" = "auto" ]; then
  command -v claude >/dev/null 2>&1 && INSTALL_CLAUDE=1
  command -v codex >/dev/null 2>&1 && INSTALL_CODEX=1
  command -v kiro-cli >/dev/null 2>&1 && INSTALL_KIRO=1
  command -v droid >/dev/null 2>&1 && INSTALL_FACTORY=1
  if [ "$INSTALL_CLAUDE" -eq 0 ] && [ "$INSTALL_CODEX" -eq 0 ] && [ "$INSTALL_KIRO" -eq 0 ] && [ "$INSTALL_FACTORY" -eq 0 ]; then
    INSTALL_CLAUDE=1
  fi
elif [ "$HOST" = "claude" ]; then
  INSTALL_CLAUDE=1
elif [ "$HOST" = "codex" ]; then
  INSTALL_CODEX=1
elif [ "$HOST" = "kiro" ]; then
  INSTALL_KIRO=1
elif [ "$HOST" = "factory" ]; then
  INSTALL_FACTORY=1
fi

# 修改后
# For auto: detect which agents are installed
INSTALL_CLAUDE=0
if [ "$HOST" = "auto" ]; then
  command -v claude >/dev/null 2>&1 && INSTALL_CLAUDE=1
  if [ "$INSTALL_CLAUDE" -eq 0 ]; then
    INSTALL_CLAUDE=1
  fi
elif [ "$HOST" = "claude" ]; then
  INSTALL_CLAUDE=1
fi
```

- [ ] **Step 6: 语法检查**

```bash
bash -n setup
```
Expected: 无输出（语法正确）

- [ ] **Step 7: Commit**

```bash
git add setup
git commit -m "chore: 从 setup 删除外部 host 变量和参数解析"
```

---

## Task 2: 删除外部 host 迁移和生成逻辑

**Files:**
- Modify: `setup:159-184`（migrate_direct_codex_install 及调用）
- Modify: `setup:255-275`（.agents/ 和 .factory/ 生成）

- [ ] **Step 1: 删除 migrate_direct_codex_install**

删除函数定义（L159-180）和调用（L182-184）。

```bash
# 删除整个 migrate_direct_codex_install 函数及其调用
```

- [ ] **Step 2: 删除 .agents/ 和 .factory/ 生成逻辑**

删除 L255-275 的 AGENTS_DIR、NEEDS_AGENTS_GEN、.factory 生成块。

```bash
# 修改前 (L250-275)
# 1b. Generate .agents/ Codex skill docs...
AGENTS_DIR="$SOURCE_GSTACK_DIR/.agents/skills"
NEEDS_AGENTS_GEN=1
if [ "$NEEDS_AGENTS_GEN" -eq 1 ] && [ "$NEEDS_BUILD" -eq 0 ]; then
  log "Generating .agents/ skill docs..."
  (
    cd "$SOURCE_GSTACK_DIR"
    bun install --frozen-lockfile 2>/dev/null || bun install
    bun run gen:skill-docs --host codex
  )
fi

# 1c. Generate .factory/ Factory Droid skill docs
if [ "$INSTALL_FACTORY" -eq 1 ] && [ "$NEEDS_BUILD" -eq 0 ]; then
  ...
fi

# 修改后：整段删除
```

- [ ] **Step 3: 语法检查**

```bash
bash -n setup
```

- [ ] **Step 4: Commit**

```bash
git add setup
git commit -m "chore: 从 setup 删除 codex 迁移和外部 host skill 生成"
```

---

## Task 3: 删除外部 host 安装辅助函数

**Files:**
- Modify: `setup:446-480`（link_codex_skill_dirs）
- Modify: `setup:518-558`（create_codex_runtime_root）
- Modify: `setup:560-596`（create_factory_runtime_root）
- Modify: `setup:598-628`（link_factory_skill_dirs）

- [ ] **Step 1: 删除四个外部 host 辅助函数**

逐个删除 `link_codex_skill_dirs`、`create_codex_runtime_root`、`create_factory_runtime_root`、`link_factory_skill_dirs` 函数定义。

保留 `create_agents_sidecar`（L486-512），虽然 Codex 不再使用，但该函数本身无外部依赖，删除不影响脚本。

- [ ] **Step 2: 语法检查**

```bash
bash -n setup
```

- [ ] **Step 3: Commit**

```bash
git add setup
git commit -m "chore: 从 setup 删除外部 host 安装辅助函数"
```

---

## Task 4: 删除外部 host 安装调用

**Files:**
- Modify: `setup:633-636`（CODEX_REPO_LOCAL）
- Modify: `setup:705-724`（Codex 安装）
- Modify: `setup:726-780`（Kiro 安装）
- Modify: `setup:782-790`（Factory 安装）
- Modify: `setup:792-797`（create_agents_sidecar 调用）

- [ ] **Step 1: 删除 CODEX_REPO_LOCAL 变量**

删除 L633-636：

```bash
# 删除前
CODEX_REPO_LOCAL=0
if [ "$SKILLS_BASENAME" = "skills" ] && [ "$SKILLS_PARENT_BASENAME" = ".agents" ]; then
  CODEX_REPO_LOCAL=1
fi

# 删除后：整段删除
```

- [ ] **Step 2: 删除 Codex 安装逻辑**

删除 L705-724（第 5 步 "Install for Codex"）。

- [ ] **Step 3: 删除 Kiro 安装逻辑**

删除 L726-780（第 6 步 "Install for Kiro CLI"）。

- [ ] **Step 4: 删除 Factory 安装逻辑**

删除 L782-790（第 6b 步 "Install for Factory Droid"）。

- [ ] **Step 5: 删除 create_agents_sidecar 调用**

删除 L792-797：

```bash
# 删除前
if [ "$INSTALL_CODEX" -eq 1 ]; then
  create_agents_sidecar "$SOURCE_GSTACK_DIR"
fi

# 删除后：整段删除
```

- [ ] **Step 6: 语法检查**

```bash
bash -n setup
```

- [ ] **Step 7: Commit**

```bash
git add setup
git commit -m "chore: 从 setup 删除外部 host 安装调用逻辑"
```

---

## Task 5: 运行测试

- [ ] **Step 1: 运行免费测试**

```bash
bun test
```
Expected: PASS

**注意：** `test/host-config.test.ts` 中引用了 `opencode`（来自 `hosts/index.ts` 的 re-export）。由于用户要求保留 `hosts/opencode.ts`，该测试应仍通过。

搜索 setup 相关测试引用：

```bash
grep -rn 'setup' test/ --include='*.test.ts' | grep -v node_modules
```

如测试引用已删除的 setup 行为（如 `--host codex` 参数），更新测试。

- [ ] **Step 2: 如有测试修改则提交**

```bash
git add test/
git commit -m "test: 更新测试以匹配简化后的 setup 脚本"
```

---

## Task 6: 在独立环境验证 setup

**Files:** None（纯验证步骤）

- [ ] **Step 1: 创建临时验证目录**

```bash
TMPDIR=$(mktemp -d /tmp/gstack-verify-XXXXXX)
cp -r . "$TMPDIR/"
cd "$TMPDIR"
```

- [ ] **Step 2: 运行简化后的 setup**

```bash
./setup --local
```
Expected:
- 成功构建 browse 二进制（如需要）
- 仅在 `$TMPDIR/.claude/skills/` 下创建 Claude skill 链接
- **不**创建 `~/.codex/skills/`、`~/.kiro/skills/`、`~/.factory/skills/`
- **不**生成 `.agents/skills/` 或 `.factory/skills/`

- [ ] **Step 3: 检查安装结果**

```bash
ls -la "$TMPDIR/.claude/skills/"
```
Expected: 看到 `gstack/`、`qa/`、`ship/` 等 Claude skill 目录

```bash
ls -la ~/.codex/skills/gstack 2>/dev/null || echo "No ~/.codex/skills/gstack"
ls -la ~/.kiro/skills/gstack 2>/dev/null || echo "No ~/.kiro/skills/gstack"
```
Expected: 不存在（setup 没有触碰这些目录）

- [ ] **Step 4: 清理临时目录**

```bash
cd -
rm -rf "$TMPDIR"
```

---

## Task 7: 合并提交（可选）

如验证通过，可将多个 commit 合并为一个：

```bash
git rebase -i HEAD~4
# squash 后三个 commit
```

或保留多个 bisect-friendly commit。

---

## Self-Review

**1. Spec coverage:**
- [x] 删除 Codex 变量和参数 — Task 1
- [x] 删除 Factory/Kiro 变量和参数 — Task 1
- [x] 删除 `.agents/` 生成 — Task 2
- [x] 删除 `.factory/` 生成 — Task 2
- [x] 删除 Codex 安装函数和调用 — Task 3, 4
- [x] 删除 Kiro 安装 — Task 4
- [x] 删除 Factory 安装 — Task 4
- [x] 独立环境验证 — Task 6

**2. Placeholder scan:**
- [x] 无 "TBD", "TODO", "implement later"
- [x] 无模糊描述
- [x] 所有命令都有 Expected 输出

**3. Type consistency:**
- [x] setup 是 bash 脚本，无类型问题
- [x] host-config 测试中的 `opencode` 导入保留（用户要求保留 opencode.ts）
