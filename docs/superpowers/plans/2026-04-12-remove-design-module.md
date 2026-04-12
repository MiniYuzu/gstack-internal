# gstack Design 模块移除实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 安全移除 design 模块（AI 图像生成功能），修改相关 skills 直接使用 HTML 降级方案，确保内网环境无需检测 design 二进制即可正常工作。

**Architecture:** 
1. 修改使用 {{DESIGN_SETUP}} 的 skill 模板，移除 design 二进制检测逻辑，直接使用 HTML wireframe 降级方案
2. 修改 package.json 构建脚本，移除 design 二进制编译步骤
3. 保留 scripts/resolvers/design.ts 中的 resolver 函数（向后兼容），但 skill 模板不再调用它们
4. 安全删除 design/ 目录及其内容

**Tech Stack:** TypeScript, Bun, SKILL.md 模板系统

---

## 影响分析

### 受影响的 Skill 模板（6个）

| Skill 模板 | 使用的宏 | 修改策略 |
|------------|----------|----------|
| `design-consultation/SKILL.md.tmpl` | {{DESIGN_SETUP}} | 移除检测，直接使用 HTML 预览 |
| `design-shotgun/SKILL.md.tmpl` | {{DESIGN_SETUP}} | 移除检测，直接使用 HTML wireframe |
| `design-html/SKILL.md.tmpl` | {{DESIGN_SETUP}} | 移除检测，直接使用 HTML |
| `design-review/SKILL.md.tmpl` | {{DESIGN_SETUP}} | 移除检测，简化流程 |
| `plan-design-review/SKILL.md.tmpl` | {{DESIGN_SETUP}} | 移除检测，使用文本描述 |
| `office-hours/SKILL.md.tmpl` | {{DESIGN_MOCKUP}}, {{DESIGN_SKETCH}} | 移除宏，直接使用 DESIGN_SKETCH 降级方案 |

### 关键原则

1. **不破坏其他 skills** - 只修改与 design 直接相关的 6 个技能
2. **保留 resolver 函数** - `scripts/resolvers/design.ts` 保留，但模板不再引用
3. **降级方案已存在** - 所有技能原本就有 DESIGN_NOT_AVAILABLE 时的降级逻辑
4. **直接删除 design/ 目录** - 移除 60MB+ 的二进制文件

---

## Task 1: 修改 design-consultation/SKILL.md.tmpl

**Files:**
- Modify: `design-consultation/SKILL.md.tmpl:74` (移除 DESIGN_SETUP)
- Modify: `design-consultation/SKILL.md.tmpl:78-82` (移除 Path A 逻辑)

**背景:** design-consultation 当前有 Path A (AI Mockups) 和 Path B (HTML Preview) 两条路径。需要移除 Path A，保留 Path B。

- [ ] **Step 1: 定位 Phase 5 区域**

读取文件，找到 "Phase 5: Design System Preview" 部分，确认 Path A 和 Path B 的结构：

```bash
grep -n "Phase 5\|Path A\|Path B\|DESIGN_SETUP" design-consultation/SKILL.md.tmpl
```

- [ ] **Step 2: 移除 DESIGN_SETUP 和相关检测逻辑**

**原始代码 (约第 72-82 行):**
```markdown
**Find the browse binary (optional — enables visual competitive research):**

{{BROWSE_SETUP}}

If browse is not available, that's fine — visual research is optional. The skill works without it using WebSearch and your built-in design knowledge.

**Find the gstack designer (optional — enables AI mockup generation):**

{{DESIGN_SETUP}}

If `DESIGN_READY`: Phase 5 will generate AI mockups of your proposed design system applied to real screens, instead of just an HTML preview page. Much more powerful — the user sees what their product could actually look like.

If `DESIGN_NOT_AVAILABLE`: Phase 5 falls back to the HTML preview page (still good).
```

**修改为:**
```markdown
**Find the browse binary (optional — enables visual competitive research):**

{{BROWSE_SETUP}}

If browse is not available, that's fine — visual research is optional. The skill works without it using WebSearch and your built-in design knowledge.
```

- [ ] **Step 3: 简化 Phase 5，移除 Path A，保留 Path B**

**原始代码结构:**
```markdown
### Path A: AI Mockups (if DESIGN_READY)
...
### Path B: HTML Preview Page (default)
...
```

**修改为只保留 Path B 内容，移除 Path A:**

```markdown
## Phase 5: Design System Preview (default ON)

This phase generates an HTML preview page showing the proposed design system applied to sample components.

Generate a self-contained HTML file with:
- **Typography showcase** — display font, body font at various sizes
- **Color palette** — primary, secondary, neutrals with hex values
- **Component gallery** — buttons, inputs, cards in the proposed style
- **Sample layout** — a simple page layout demonstrating the system

Write to:
```bash
_PREVIEW_HTML="/tmp/design-system-preview-$(date +%s).html"
```

Open in browser:
```bash
$B goto "file://$_PREVIEW_HTML"
```

Or if browse is not available, output the file path for the user to open manually.

After the user reviews the preview, ask: "Does this design system feel right? Want to adjust anything before I write DESIGN.md?"
```

- [ ] **Step 4: 验证修改**

```bash
grep -c "DESIGN_SETUP\|\$D " design-consultation/SKILL.md.tmpl
```

Expected: 0 (确认没有 DESIGN_SETUP 和 $D 引用)

- [ ] **Step 5: Commit**

```bash
git add design-consultation/SKILL.md.tmpl
git commit -m "refactor(design-consultation): remove design binary dependency, use HTML preview only

- Remove DESIGN_SETUP macro and detection logic
- Remove Path A (AI mockups), keep Path B (HTML preview)
- Simplify Phase 5 to always use HTML wireframe approach"
```

---

## Task 2: 修改 design-shotgun/SKILL.md.tmpl

**Files:**
- Modify: `design-shotgun/SKILL.md.tmpl:29` (移除 DESIGN_SETUP)
- Modify: `design-shotgun/SKILL.md.tmpl:136-250` (移除并行生成逻辑，替换为 HTML)

**背景:** design-shotgun 当前依赖 design 二进制生成多个变体，然后使用 $D compare 创建看板。需要替换为静态 HTML wireframe 生成。

- [ ] **Step 1: 定位并移除 DESIGN_SETUP**

**原始代码 (第 29 行附近):**
```markdown
{{DESIGN_SETUP}}
```

**修改为:** 直接删除这一行。

- [ ] **Step 2: 修改 Step 3 (生成变体部分)**

**原始逻辑:**
- 使用 `$D variants` 生成多个 PNG
- 使用 `$D compare` 创建看板
- 使用 `$D serve` 启动 HTTP 服务

**新逻辑:**
- 生成静态 HTML wireframe 展示不同设计方向
- 使用 `$B goto` 打开（如果 browse 可用）
- 否则输出文件路径

**修改为:**

找到 "## Step 3: Generate Variants" 部分，替换为：

```markdown
## Step 3: Generate Design Direction Variants

Generate N distinct design direction concepts as HTML wireframes. Each variant should be a different creative direction, not minor variations.

**Step 3a: Concept Generation**

Before generating, present N text concepts describing each variant's design direction:

```
I'll explore 3 directions:

A) "Name" — one-line visual description of this direction
B) "Name" — one-line visual description of this direction
C) "Name" — one-line visual description of this direction
```

**Step 3b: Concept Confirmation**

Use AskUserQuestion to confirm before generating:

> "These are the {N} directions I'll generate as HTML wireframes. Each will be a self-contained HTML file you can view in your browser."
>
> Options:
> - A) Generate all {N} — looks good
> - B) I want to change some concepts (tell me which)
> - C) Add more variants
> - D) Fewer variants

**Step 3c: Generate HTML Wireframes**

For each confirmed concept, generate a rough HTML wireframe:
- Use system fonts, thin gray borders, minimal styling
- Show the core layout and interaction flow
- Include realistic placeholder content
- Self-contained (inline CSS, no external dependencies)

Write to:
```bash
_DESIGN_DIR=~/.gstack/projects/$SLUG/designs/<screen-name>-$(date +%Y%m%d)
mkdir -p "$_DESIGN_DIR"
```

Create comparison board HTML:
```bash
# Create a comparison board showing all variants side-by-side
# Write to $_DESIGN_DIR/comparison-board.html
```

**Step 3d: Present Variants**

Show each variant HTML file path to the user. If browse is available:
```bash
$B goto "file://$_DESIGN_DIR/comparison-board.html"
```

Otherwise, provide the file path for manual opening.
```

- [ ] **Step 3: 修改 Step 4 (反馈循环)**

简化反馈循环，移除 $D compare/serve 依赖：

```markdown
## Step 4: Feedback Loop

Present all variants to the user:
1. List each variant with its concept description
2. Show the HTML file path for each
3. Open comparison board if browse available

Use AskUserQuestion to collect feedback:

> "Review the design variants. Which direction feels right? Any specific feedback on layout, spacing, or visual hierarchy?"

Options:
- A) Variant X is my favorite — proceed with it
- B) Mix elements — take [element] from [variant], [element] from [variant]
- C) Generate new directions based on feedback: [user feedback]
- D) Iterate on a specific variant: [which one + changes]

If C or D: Update the design brief with feedback and regenerate variants.
If A or B: Proceed to Step 5.
```

- [ ] **Step 4: 验证无 design 引用**

```bash
grep -c "\$D\|DESIGN_SETUP\|design.*binary" design-shotgun/SKILL.md.tmpl
```

Expected: 0

- [ ] **Step 5: Commit**

```bash
git add design-shotgun/SKILL.md.tmpl
git commit -m "refactor(design-shotgun): remove design binary dependency

- Remove DESIGN_SETUP macro
- Replace AI mockup generation with HTML wireframes
- Simplify comparison board to static HTML
- Remove $D command dependencies"
```

---

## Task 3: 修改 design-html/SKILL.md.tmpl

**Files:**
- Modify: `design-html/SKILL.md.tmpl:38` (移除 DESIGN_SETUP)

**背景:** design-html 当前检测 design 二进制，但应该直接生成 HTML。

- [ ] **Step 1: 读取并分析当前模板**

```bash
head -100 design-html/SKILL.md.tmpl
```

- [ ] **Step 2: 移除 DESIGN_SETUP 并简化逻辑**

**原始:**
```markdown
{{DESIGN_SETUP}}

If `DESIGN_READY`: ...
If `DESIGN_NOT_AVAILABLE`: ...
```

**修改为:**
直接删除 DESIGN_SETUP 和相关条件逻辑，保留 HTML 生成部分的内容。

- [ ] **Step 3: Commit**

```bash
git add design-html/SKILL.md.tmpl
git commit -m "refactor(design-html): remove design binary detection

- Remove DESIGN_SETUP macro and conditional logic
- Always use HTML generation path"
```

---

## Task 4: 修改 design-review/SKILL.md.tmpl

**Files:**
- Modify: `design-review/SKILL.md.tmpl:83` (移除 DESIGN_SETUP)

**背景:** design-review 技能使用 DESIGN_SETUP 检测 design 二进制来生成 mockup 对比。

- [ ] **Step 1: 分析当前使用方式**

```bash
grep -B5 -A20 "DESIGN_SETUP" design-review/SKILL.md.tmpl
```

- [ ] **Step 2: 移除 DESIGN_SETUP**

如果 design-review 使用 design 二进制进行视觉对比，修改为：
- 使用 browse 截图进行视觉对比
- 或者使用文本描述进行设计审查

- [ ] **Step 3: Commit**

```bash
git add design-review/SKILL.md.tmpl
git commit -m "refactor(design-review): remove design binary dependency

- Remove DESIGN_SETUP macro
- Use browse screenshots or text descriptions instead"
```

---

## Task 5: 修改 plan-design-review/SKILL.md.tmpl

**Files:**
- Modify: `plan-design-review/SKILL.md.tmpl:132` (移除 DESIGN_SETUP)

- [ ] **Step 1: 分析当前使用方式**

```bash
grep -B5 -A20 "DESIGN_SETUP" plan-design-review/SKILL.md.tmpl
```

- [ ] **Step 2: 移除 DESIGN_SETUP 并简化**

修改为直接使用 HTML sketch 或文本描述，不依赖 design 二进制。

- [ ] **Step 3: Commit**

```bash
git add plan-design-review/SKILL.md.tmpl
git commit -m "refactor(plan-design-review): remove design binary dependency

- Remove DESIGN_SETUP macro
- Use HTML wireframes for design exploration"
```

---

## Task 6: 修改 office-hours/SKILL.md.tmpl

**Files:**
- Modify: `office-hours/SKILL.md.tmpl:397-399` (移除 DESIGN_MOCKUP, DESIGN_SKETCH)

- [ ] **Step 1: 分析当前使用方式**

```bash
grep -B10 -A30 "DESIGN_MOCKUP\|DESIGN_SKETCH" office-hours/SKILL.md.tmpl
```

- [ ] **Step 2: 替换宏为直接的 HTML sketch 逻辑**

如果 office-hours 使用 DESIGN_MOCKUP 和 DESIGN_SKETCH，找到 generateDesignSketch 函数的内容，将其实现直接内联到模板中。

从 `scripts/resolvers/design.ts` 复制 generateDesignSketch 的内容到模板中。

- [ ] **Step 3: Commit**

```bash
git add office-hours/SKILL.md.tmpl
git commit -m "refactor(office-hours): inline design sketch logic, remove macros

- Remove DESIGN_MOCKUP and DESIGN_SKETCH macros
- Inline HTML wireframe generation logic"
```

---

## Task 7: 修改 package.json 构建脚本

**Files:**
- Modify: `package.json:11` (build 脚本)

- [ ] **Step 1: 移除 design 二进制编译命令**

**原始 build 脚本:**
```json
"build": "bun run gen:skill-docs --host all; bun build --compile browse/src/cli.ts --outfile browse/dist/browse && bun build --compile browse/src/find-browse.ts --outfile browse/dist/find-browse && bun build --compile design/src/cli.ts --outfile design/dist/design && bun build --compile bin/gstack-global-discover.ts --outfile bin/gstack-global-discover && bash browse/scripts/build-node-server.sh && git rev-parse HEAD > browse/dist/.version && git rev-parse HEAD > design/dist/.version && chmod +x browse/dist/browse browse/dist/find-browse design/dist/design bin/gstack-global-discover && rm -f .*.bun-build || true"
```

**修改为:**
```json
"build": "bun run gen:skill-docs --host all; bun build --compile browse/src/cli.ts --outfile browse/dist/browse && bun build --compile browse/src/find-browse.ts --outfile browse/dist/find-browse && bun build --compile bin/gstack-global-discover.ts --outfile bin/gstack-global-discover && bash browse/scripts/build-node-server.sh && git rev-parse HEAD > browse/dist/.version && chmod +x browse/dist/browse browse/dist/find-browse bin/gstack-global-discover && rm -f .*.bun-build || true"
```

**变更点:**
1. 移除 `bun build --compile design/src/cli.ts --outfile design/dist/design`
2. 移除 `git rev-parse HEAD > design/dist/.version`
3. 从 `chmod +x` 中移除 `design/dist/design`

- [ ] **Step 2: 移除 dev:design 脚本**

**原始:**
```json
"dev:design": "bun run design/src/cli.ts",
```

**修改为:** 删除整行

- [ ] **Step 3: 验证 JSON 语法**

```bash
bun run --help 2>&1 | head -5 || cat package.json | python3 -m json.tool > /dev/null && echo "JSON valid"
```

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build: remove design module from build scripts

- Remove design binary compilation from build script
- Remove design version file generation
- Remove dev:design script
- Design module is being removed as it requires OpenAI API"
```

---

## Task 8: 删除 design/ 目录

**Files:**
- Delete: `design/` directory

- [ ] **Step 1: 确认 design 目录内容**

```bash
ls -la design/
ls -la design/src/
ls -la design/dist/
```

- [ ] **Step 2: 删除 design 目录**

```bash
rm -rf design/
```

- [ ] **Step 3: 确认删除成功**

```bash
ls design/ 2>&1 || echo "design directory removed successfully"
```

Expected: "No such file or directory"

- [ ] **Step 4: Commit**

```bash
git add -A design/
git commit -m "chore: remove design module

Remove the design/ directory containing AI image generation functionality.
This module required OpenAI API access which is not available in internal
network environments. Related skills have been updated to use HTML
wireframes instead.

Removed:
- design/src/ (TypeScript source files)
- design/dist/ (Compiled binaries)
- design/prototype.ts (Prototype validation)"
```

---

## Task 9: 重新生成 SKILL.md 文件

**Files:**
- Modify: 多个 `*/SKILL.md` 文件（自动重新生成）

- [ ] **Step 1: 运行 gen:skill-docs**

```bash
bun run gen:skill-docs --host all
```

- [ ] **Step 2: 验证生成的 SKILL.md 文件**

检查主要技能的 SKILL.md 是否正确生成：

```bash
ls -la */SKILL.md | head -20
grep -l "DESIGN_SETUP\|\$D " */SKILL.md 2>/dev/null || echo "No DESIGN_SETUP found in generated files"
```

Expected: 应该没有 DESIGN_SETUP 或 $D 引用（因为模板已修改）

- [ ] **Step 3: Commit 生成的文件**

```bash
git add */SKILL.md
git commit -m "chore: regenerate SKILL.md files after design module removal

- Regenerate all SKILL.md files from updated templates
- Remove DESIGN_SETUP references from generated docs"
```

---

## Task 10: 运行测试验证

**Files:**
- Test: `test/skill-validation.test.ts`
- Test: `test/gen-skill-docs.test.ts`

- [ ] **Step 1: 运行基础测试**

```bash
bun test
```

Expected: 所有测试通过（Tier 1 测试不应该依赖 design 模块）

- [ ] **Step 2: 验证技能解析**

```bash
bun run skill:check
```

Expected: 没有与 design 相关的错误

- [ ] **Step 3: 验证构建**

```bash
bun run build
```

Expected: 构建成功，不报错

- [ ] **Step 4: Commit（如有必要）**

如果测试或构建过程中有修复，提交这些修复。

---

## Task 11: 创建迁移说明文档

**Files:**
- Create: `docs/designs/DESIGN_MODULE_REMOVAL.md`

- [ ] **Step 1: 创建迁移说明**

```markdown
# Design 模块移除说明

## 背景

gstack design 模块（位于 `design/` 目录）提供了基于 OpenAI GPT Image API 的 AI 图像生成功能。由于该功能：

1. 完全依赖外网 OpenAI API (`https://api.openai.com`)
2. 需要有效的 OpenAI API Key 和组织验证
3. 按量付费（~$0.04-0.12/张图像）
4. 在内网环境完全不可用

因此决定移除 design 模块，相关技能已更新为使用 HTML wireframe 作为降级方案。

## 变更内容

### 移除的文件/目录
- `design/` - 整个 design 模块（源代码、编译二进制、测试）

### 修改的文件
1. `design-consultation/SKILL.md.tmpl` - 移除 DESIGN_SETUP，使用 HTML 预览
2. `design-shotgun/SKILL.md.tmpl` - 移除 $D 命令，使用 HTML wireframes
3. `design-html/SKILL.md.tmpl` - 移除 design 检测逻辑
4. `design-review/SKILL.md.tmpl` - 移除 DESIGN_SETUP
5. `plan-design-review/SKILL.md.tmpl` - 移除 DESIGN_SETUP
6. `office-hours/SKILL.md.tmpl` - 内联 DESIGN_SKETCH 逻辑
7. `package.json` - 移除 design 构建步骤

### 技能行为变更

| 技能 | 原行为 (DESIGN_READY) | 新行为 |
|------|----------------------|--------|
| design-consultation | AI 生成 mockup 图片 | HTML 预览页面 |
| design-shotgun | AI 生成多版本对比 | HTML wireframe 对比 |
| design-html | 尝试 AI 生成 | 直接生成 HTML |
| design-review | AI 辅助视觉对比 | browse 截图对比 |
| plan-design-review | AI mockup | HTML sketch |
| office-hours | AI 视觉探索 | HTML wireframe |

## 迁移影响

### 对用户的影响
- **功能降级**: 不再有 AI 生成的真实 mockup 图片
- **替代方案**: 使用 HTML wireframes 进行视觉探索
- **速度提升**: 无需等待 AI API 调用（60-120秒/图）
- **成本节省**: 无 API 调用费用

### 对开发者的影响
- 构建时间缩短（无需编译 58MB design 二进制）
- 构建产物减小 60MB
- 内网环境完全可用

## 保留的代码

以下代码被保留但不再被模板使用：
- `scripts/resolvers/design.ts` - resolver 函数（向后兼容）
- `DESIGN_*` 宏定义 - 在 `RESOLVERS` 映射中保留

这些代码可以在未来如果需要重新引入 design 功能时使用。

## 相关提交

- 任务 1-6: 修改 skill 模板
- 任务 7: 修改 package.json 构建脚本
- 任务 8: 删除 design/ 目录
- 任务 9: 重新生成 SKILL.md

## 日期

2026-04-12
```

- [ ] **Step 2: Commit 文档**

```bash
git add docs/designs/DESIGN_MODULE_REMOVAL.md
git commit -m "docs: add design module removal migration guide

Document the removal of design module and behavior changes
in related skills."
```

---

## 验证清单

所有任务完成后，确认以下内容：

- [ ] `design/` 目录已删除
- [ ] `package.json` 中无 design 相关脚本
- [ ] 6 个 skill 模板已修改（无 DESIGN_SETUP 或 $D）
- [ ] `bun run build` 成功
- [ ] `bun test` 通过
- [ ] `bun run skill:check` 无错误
- [ ] 重新生成的 SKILL.md 文件无 design 二进制引用
- [ ] 迁移文档已创建

---

## 风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| Skill 模板语法错误 | 中 | 高 | 每次修改后运行 `bun run gen:skill-docs` 验证 |
| 其他 skill 被意外修改 | 低 | 高 | 使用 `git diff` 仔细检查每次提交 |
| 测试失败 | 中 | 中 | 运行完整测试套件，修复任何失败 |
| 用户习惯改变 | 中 | 低 | 迁移文档说明替代方案 |

---

## 附录：保留的 Resolver 函数

以下函数保留在 `scripts/resolvers/design.ts` 中，但不再被 skill 模板使用：

- `generateDesignMethodology`
- `generateDesignHardRules`
- `generateDesignOutsideVoices`
- `generateDesignReviewLite`
- `generateDesignSketch`
- `generateDesignSetup`
- `generateDesignMockup`
- `generateDesignShotgunLoop`

这些函数保留在 `RESOLVERS` 映射中，但模板不再引用对应的占位符。

---

**计划完成时间:** 2026-04-12  
**计划版本:** v1.0.0  
**适用范围:** gstack v0.16.2.0+
