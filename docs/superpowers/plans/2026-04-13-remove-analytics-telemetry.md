# 清理 Analytics 和 Telemetry 外网依赖文件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除 gstack 工程中所有外网依赖的 analytics、telemetry、数据上报功能，保留核心浏览器自动化功能

**Architecture:** 通过删除外网依赖的脚本、测试、edge functions 和数据库迁移文件，清理 telemetry 数据流。修改 preamble.ts 模板，禁用远程上报但保留本地日志的基础结构。

**Tech Stack:** TypeScript, Bash, Bun, Supabase Edge Functions

---

## 文件清单

### 删除的文件 (12 个)

| 类型 | 路径 | 说明 |
|------|------|------|
| Script | `scripts/analytics.ts` | Analytics CLI 脚本，读取本地 JSONL 生成报表 |
| Bin | `bin/gstack-analytics` | Analytics dashboard 二进制 |
| Bin | `bin/gstack-telemetry-log` | Telemetry 日志记录器 |
| Bin | `bin/gstack-telemetry-sync` | Telemetry 数据同步到 Supabase |
| Bin | `bin/gstack-community-dashboard` | 社区仪表板（依赖 Supabase）|
| Test | `test/analytics.test.ts` | Analytics 单元测试 |
| Test | `test/telemetry.test.ts` | Telemetry 单元测试 |
| Edge Function | `supabase/functions/telemetry-ingest/index.ts` | 遥测数据摄入 edge function |
| Edge Function | `supabase/functions/community-pulse/index.ts` | 社区脉搏 edge function |
| Migration | `supabase/migrations/001_telemetry.sql` | Telemetry 数据库 schema |
| Config | `supabase/config.sh` | Supabase 配置 |
| Script | `supabase/verify-rls.sh` | RLS 验证脚本 |

### 修改的文件 (2 个)

| 路径 | 修改内容 |
|------|----------|
| `scripts/resolvers/preamble.ts` | 移除 telemetry 相关代码，保留 session 管理，修复 proactive prompt 条件 |
| `package.json` | 移除 "analytics" 脚本 |

### 保留的文件 (关键本地工具)

| 路径 | 说明 |
|------|------|
| `bin/gstack-update-check` | ⚠️ 保留 - 已适配内网环境（检查 `GSTACK_ENABLE_UPDATE_CHECK`）|
| `bin/gstack-timeline-log` | 保留 - 本地 session 时间线记录 |
| `bin/gstack-timeline-read` | 保留 - 本地时间线读取 |
| `bin/gstack-learnings-log` | 保留 - 本地学习记录 |
| `bin/gstack-builder-profile` | 保留 - 本地 builder 档案 |

---

## Task 1: 删除 Analytics 和 Telemetry 脚本文件

**Files:**
- Delete: `scripts/analytics.ts`
- Delete: `bin/gstack-analytics`
- Delete: `bin/gstack-telemetry-log`
- Delete: `bin/gstack-telemetry-sync`
- Delete: `bin/gstack-community-dashboard`
- **Keep**: `bin/gstack-update-check` (已适配内网)

- [ ] **Step 1: 删除 scripts/analytics.ts**

```bash
git rm scripts/analytics.ts
```

- [ ] **Step 2: 删除 bin/gstack-analytics**

```bash
git rm bin/gstack-analytics
```

- [ ] **Step 3: 删除 bin/gstack-telemetry-log**

```bash
git rm bin/gstack-telemetry-log
```

- [ ] **Step 4: 删除 bin/gstack-telemetry-sync**

```bash
git rm bin/gstack-telemetry-sync
```

- [ ] **Step 5: 删除 bin/gstack-community-dashboard**

```bash
git rm bin/gstack-community-dashboard
```

- [ ] **Step 6: Commit 删除的脚本文件**

```bash
git commit -m "chore: remove analytics and telemetry scripts

Remove external network dependent analytics/telemetry tools:
- scripts/analytics.ts - CLI for viewing skill usage stats
- bin/gstack-analytics - Personal usage dashboard
- bin/gstack-telemetry-log - Local telemetry JSONL appender
- bin/gstack-telemetry-sync - Supabase sync tool
- bin/gstack-community-dashboard - Community stats dashboard

Note: gstack-update-check is kept as it's already adapted
for internal network environments (checks GSTACK_ENABLE_UPDATE_CHECK).

These tools require external network access to function properly.
Internal network environments should use local logs only."
```

---

## Task 2: 删除 Telemetry 相关测试文件

**Files:**
- Delete: `test/analytics.test.ts`
- Delete: `test/telemetry.test.ts`

- [ ] **Step 1: 删除 test/analytics.test.ts**

```bash
git rm test/analytics.test.ts
```

- [ ] **Step 2: 删除 test/telemetry.test.ts**

```bash
git rm test/telemetry.test.ts
```

- [ ] **Step 3: Commit 删除的测试文件**

```bash
git commit -m "chore: remove analytics and telemetry tests

Remove tests for deleted analytics/telemetry functionality:
- test/analytics.test.ts
- test/telemetry.test.ts

These tests are no longer needed after removing the underlying
telemetry infrastructure."
```

---

## Task 3: 删除 Supabase Edge Functions 和数据库迁移

**Files:**
- Delete: `supabase/functions/telemetry-ingest/index.ts`
- Delete: `supabase/functions/community-pulse/index.ts`
- Delete: `supabase/migrations/001_telemetry.sql`
- Delete: `supabase/config.sh`
- Delete: `supabase/verify-rls.sh`

- [ ] **Step 1: 删除 telemetry-ingest edge function**

```bash
git rm supabase/functions/telemetry-ingest/index.ts
```

- [ ] **Step 2: 删除 community-pulse edge function**

```bash
git rm supabase/functions/community-pulse/index.ts
```

- [ ] **Step 3: 删除数据库迁移文件**

```bash
git rm supabase/migrations/001_telemetry.sql
```

- [ ] **Step 4: 删除 Supabase 配置文件**

```bash
git rm supabase/config.sh
git rm supabase/verify-rls.sh
```

- [ ] **Step 5: Commit Supabase 相关删除**

```bash
git commit -m "chore: remove Supabase telemetry infrastructure

Remove external Supabase-dependent components:
- supabase/functions/telemetry-ingest/ - Edge function for telemetry intake
- supabase/functions/community-pulse/ - Edge function for community stats
- supabase/migrations/001_telemetry.sql - Telemetry database schema
- supabase/config.sh - Supabase configuration
- supabase/verify-rls.sh - RLS verification script

These components require external network access to Supabase
and are not suitable for internal network deployments."
```

---

## Task 4: 修改 preamble.ts 移除 Telemetry 上报代码

**Files:**
- Modify: `scripts/resolvers/preamble.ts`

**关键修改原则：**
1. 保留 `_SESSION_ID` - timeline-log 需要它
2. 保留 `.pending-*` 清理逻辑（session 管理）
3. 修复 `generateProactivePrompt` - 移除对 `TEL_PROMPTED` 的依赖
4. 仅删除外网依赖的上报代码

- [ ] **Step 1: 修改 preamble.ts - 更新文件头注释**

将第 11-14 行：
```typescript
 * Telemetry data flow:
 *   1. Always: local JSONL append to ~/.gstack/analytics/ (inline, inspectable)
 *   2. If _TEL != "off" AND binary exists: gstack-telemetry-log for remote reporting
 */
```

改为：
```typescript
 * Telemetry: Disabled for internal network deployment.
 *   Remote telemetry removed - external network dependent.
 *   Local session tracking (timeline-log) preserved.
 */
```

- [ ] **Step 2: 修改 preamble.ts - 简化 generatePreambleBash 函数**

找到第 52-68 行，将 telemetry 相关代码：
```typescript
_TEL=$(${ctx.paths.binDir}/gstack-config get telemetry 2>/dev/null || true)
_TEL_PROMPTED=$([ -f ~/.gstack/.telemetry-prompted ] && echo "yes" || echo "no")
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
echo "TELEMETRY: ${_TEL:-off}"
echo "TEL_PROMPTED: $_TEL_PROMPTED"
mkdir -p ~/.gstack/analytics
if [ "$_TEL" != "off" ]; then
echo '{"skill":"${ctx.skillName}","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
# zsh-compatible: use find instead of glob to avoid NOMATCH error
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do
  if [ -f "$_PF" ]; then
    if [ "$_TEL" != "off" ] && [ -x "${ctx.paths.binDir}/gstack-telemetry-log" ]; then
      ${ctx.paths.binDir}/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true
    fi
    rm -f "$_PF" 2>/dev/null || true
  fi
  break
done
```

改为：
```typescript
# Session tracking for timeline (local-only)
_SESSION_ID="$$-$(date +%s)"

# Cleanup stale pending markers (session management)
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do
  [ -f "$_PF" ] && rm -f "$_PF" 2>/dev/null || true
  break
done
```

- [ ] **Step 3: 修改 preamble.ts - 更新 generateProactivePrompt 条件**

找到第 171-172 行，将：
```typescript
  return `If \`PROACTIVE_PROMPTED\` is \`no\` AND \`TEL_PROMPTED\` is \`yes\`: After telemetry is handled,
```

改为：
```typescript
  return `If \`PROACTIVE_PROMPTED\` is \`no\` AND \`LAKE_INTRO\` is \`yes\`: After lake intro is handled,
```

- [ ] **Step 4: 修改 preamble.ts - 更新 generateTelemetryPrompt 函数**

找到第 136-169 行的 `generateTelemetryPrompt` 函数，将整个函数改为返回空字符串：

```typescript
function generateTelemetryPrompt(_ctx: TemplateContext): string {
  // Telemetry disabled for internal network deployment
  return '';
}
```

- [ ] **Step 5: 修改 preamble.ts - 更新 generateSpawnsPrompt 中的说明**

找到第 279 行的：
```
- Do NOT run upgrade checks, telemetry prompts, routing injection, or lake intro.
```

改为：
```
- Do NOT run upgrade checks, routing injection, or lake intro.
```

- [ ] **Step 6: 修改 preamble.ts - 更新 eureka 日志说明**

找到第 439 行的：
```
jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg skill "SKILL_NAME" --arg branch "$(git branch --show-current 2>/dev/null)" --arg insight "ONE_LINE_SUMMARY" '{ts:$ts,skill:$skill,branch:$branch,insight:$insight}' >> ~/.gstack/analytics/eureka.jsonl 2>/dev/null || true
```

改为：
```
# Eureka logging disabled - external network dependent
```

- [ ] **Step 7: 修改 preamble.ts - 简化 Telemetry section（文件末尾）**

找到第 487-522 行的 Telemetry section，将整个 section 替换为：

```typescript
## Telemetry (DISABLED)

Telemetry is disabled for internal network deployment.
No external data reporting is performed.

Session timeline logging (local-only) is preserved.
```

- [ ] **Step 8: 运行测试确保 preamble.ts 修改正确**

```bash
bun test test/gen-skill-docs.test.ts
```

Expected: PASS - skill docs generation应正常工作

- [ ] **Step 9: Commit preamble.ts 修改**

```bash
git add scripts/resolvers/preamble.ts
git commit -m "chore: remove telemetry reporting from preamble

Disable telemetry data collection and reporting in preamble.ts:
- Remove local JSONL analytics logging (skill-usage.jsonl)
- Remove gstack-telemetry-log binary invocations
- Remove generateTelemetryPrompt content (disabled)
- Fix proactive prompt to not depend on telemetry
- Update eureka logging comment
- Preserve _SESSION_ID for timeline-log compatibility
- Preserve .pending-* cleanup for session management

Internal network deployments do not support external telemetry.
Proactive suggestions now trigger after lake intro instead of telemetry."
```

---

## Task 5: 修改 package.json 移除 analytics 脚本

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 从 package.json 中移除 analytics 脚本**

删除 package.json scripts 中的这一行：
```json
    "analytics": "bun run scripts/analytics.ts",
```

- [ ] **Step 2: Commit package.json 修改**

```bash
git add package.json
git commit -m "chore: remove analytics script from package.json

Remove the 'analytics' npm script that referenced the deleted
scripts/analytics.ts file."
```

---

## Task 6: 验证清理结果

- [ ] **Step 1: 运行基础测试确保核心功能正常**

```bash
bun test
```

Expected: 
- skill-validation.test.ts - PASS
- gen-skill-docs.test.ts - PASS
- 其他测试正常

- [ ] **Step 2: 检查是否还有残留的 analytics/telemetry 引用**

```bash
grep -r "gstack-telemetry-log\|gstack-telemetry-sync\|gstack-analytics\|telemetry-ingest\|community-pulse" \
  --include="*.ts" --include="*.js" --include="*.json" --include="*.sh" --include="SKILL.md" \
  . --exclude-dir=.worktrees --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null || echo "No external telemetry references found"
```

Expected: "No external telemetry references found" 或仅出现在 .worktrees 中

- [ ] **Step 3: 验证保留的关键文件存在**

```bash
ls -la bin/gstack-update-check bin/gstack-timeline-log bin/gstack-timeline-read 2>&1 | head -5
```

Expected: 三个文件都存在

- [ ] **Step 4: 验证生成的 SKILL.md 文件不包含 telemetry 上报指令**

```bash
grep -l "gstack-telemetry-log" */SKILL.md 2>/dev/null || echo "No telemetry references in SKILL.md - OK"
```

Expected: "No telemetry references in SKILL.md - OK"

---

## Task 7: 最终验证和总结

- [ ] **Step 1: 运行完整测试确保没有破坏核心功能**

```bash
bun run test:gate
```

Expected: 所有 gate-tier 测试通过

- [ ] **Step 2: 生成技能文档验证 preamble 修改正确**

```bash
bun run gen:skill-docs
```

Expected: 成功生成，无错误

- [ ] **Step 3: 检查 git 状态**

```bash
git status
```

Expected: 没有未提交的修改，所有删除和修改都已提交

- [ ] **Step 4: 查看提交历史**

```bash
git log --oneline HEAD~8..HEAD
```

---

## 清理清单总结

### 删除的文件 (12 个)

```
scripts/analytics.ts
bin/gstack-analytics
bin/gstack-telemetry-log
bin/gstack-telemetry-sync
bin/gstack-community-dashboard
test/analytics.test.ts
test/telemetry.test.ts
supabase/functions/telemetry-ingest/index.ts
supabase/functions/community-pulse/index.ts
supabase/migrations/001_telemetry.sql
supabase/config.sh
supabase/verify-rls.sh
```

### 修改的文件 (2 个)

```
scripts/resolvers/preamble.ts - 移除 telemetry 上报代码，修复 proactive prompt
package.json - 移除 analytics 脚本
```

### 保留的关键文件

```
bin/gstack-update-check - 已适配内网环境
bin/gstack-timeline-log - 本地 session 时间线
bin/gstack-timeline-read - 本地时间线读取
bin/gstack-learnings-log - 本地学习记录
bin/gstack-builder-profile - 本地 builder 档案
```

### 预期效果

- **空间节省**: ~50KB+ 脚本文件，~20KB+ 测试文件，数据库迁移和 edge functions
- **外网依赖**: 完全移除 Supabase 遥测、telemetry 上报、社区仪表板
- **功能保留**: 
  - 核心浏览器自动化 ✅
  - 技能系统 ✅
  - 本地 CLI 功能 ✅
  - Session 时间线记录 ✅
  - Learning 系统 ✅
  - Proactive 建议 ✅ (修复后)

---

**计划完成时间:** 2026-04-13
**版本:** v0.16.3.0
