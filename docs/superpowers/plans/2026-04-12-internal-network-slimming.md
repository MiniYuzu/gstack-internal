# gstack 内网环境迁移瘦身评估计划

> **目标:** 在保证功能完整性的前提下，识别并移除内网环境不需要的文件，实现工程最小化

**评估基准:** 基于 `/docs/superpowers/architecture-review-2026-04-11.md` 架构文档中的"12. 内网环境适配改造"章节

**内网环境特征:**
- 无外网直连能力
- Windows 宿主环境（可能限制 .exe 执行）
- 使用 Node CLI 包装器 (`browse.js`) 而非编译二进制
- 使用 playwright-core 而非完整 playwright

---

## 评估方法论

### 核心原则
1. **保留:** 浏览器核心功能、CLI 基础命令、技能系统基础
2. **移除:** 外网依赖功能、非必要技能、开发/测试工具
3. **可裁剪:** CI/CD 工作流、扩展功能、可选技能

### 评估维度
| 维度 | 权重 | 评估标准 |
|------|------|----------|
| 功能必要性 | 40% | 是否为内网浏览器自动化所必需 |
| 外网依赖 | 30% | 是否需要外网连接才能工作 |
| 维护成本 | 20% | 文件大小、复杂度 |
| 平台兼容性 | 10% | 是否支持 Windows 内网环境 |

---

## 详细评估结果

### 第一类：可完全移除的目录/文件

#### 1.1 Chrome 扩展 (extension/) — **建议移除**

**文件清单:**
```
extension/
├── background.js       # 扩展后台脚本
├── content.css         # 内容脚本样式
├── content.js          # 内容脚本
├── icons/              # 扩展图标
├── inspector.css       # 检查器样式
├── inspector.js        # 检查器逻辑
├── manifest.json       # 扩展清单
├── popup.html          # 弹出窗口
├── popup.js            # 弹出窗口逻辑
├── sidepanel.css       # 侧边栏样式
├── sidepanel.html      # 侧边栏 HTML
└── sidepanel.js        # 侧边栏逻辑
```

**移除理由:**
1. Chrome 扩展需要 Chrome Web Store 或手动安装，内网环境难以部署
2. 扩展功能主要面向 Web UI 交互，非核心浏览器自动化功能
3. 扩展代码量约 150KB，占用空间且需要额外维护
4. 内网环境主要通过 CLI (`$B` 命令) 使用，无需扩展

**影响评估:** ⚠️ 中等
- 无扩展时，部分可视化功能缺失
- 但核心的 `goto`, `click`, `fill`, `snapshot` 等命令不受影响
- 可通过 `GSTACK_SKIP_EXTENSION=1` 禁用

---

#### 1.2 Design 模块 (design/) — **建议移除**

**文件清单:**
```
design/
├── dist/
│   └── design          # 编译后的设计二进制 (~58MB)
├── src/                # 18 个 TypeScript 源文件
├── test/               # 测试文件
└── prototype.ts        # 原型文件
```

**移除理由:**
1. Design 模块使用 GPT Image API 进行视觉设计，**需要外网连接**
2. 内网环境无法调用 OpenAI API，功能完全不可用
3. 编译后的二进制约 58MB，占用大量空间
4. 与浏览器自动化核心功能无关

**影响评估:** ✅ 低
- Design 模块是独立功能，移除不影响 browse 核心
- 相关技能 (`/design-review`, `/design-shotgun`, `/design-consultation`) 一并移除

---

#### 1.3 GitHub CI 工作流 (.github/) — **建议移除**

**文件清单:**
```
.github/
├── actionlint.yaml
├── docker/
│   └── Dockerfile.ci   # CI 专用 Docker 镜像
└── workflows/
    ├── actionlint.yml
    ├── evals.yml       # E2E 测试工作流
    └── skill-docs.yml  # 文档生成工作流
```

**移除理由:**
1. 内网环境通常无法连接 GitHub Actions
2. CI 工作流需要外网资源（Ubicloud runner、Docker Hub 等）
3. 内网应使用自建 CI 系统（如 Jenkins、GitLab CI）

**影响评估:** ✅ 低
- CI 配置与运行时功能无关
- 内网需自建 CI 流程

---

#### 1.4 高成本 E2E 测试文件 — **建议移除/精简**

**文件清单:**
```
test/
├── skill-e2e*.test.ts          # 15 个 E2E 测试文件
├── codex-e2e.test.ts           # Codex E2E 测试
├── gemini-e2e.test.ts          # Gemini E2E 测试
├── skill-llm-eval.test.ts      # LLM 评估测试
└── skill-routing-e2e.test.ts   # 路由 E2E 测试
```

**移除理由:**
1. E2E 测试依赖 `claude -p` 命令，需要外网 API 调用（成本 ~$4/次）
2. 内网环境无法调用 Claude API，测试无法运行
3. Codex/Gemini 测试需要对应平台凭证
4. LLM-as-judge 测试需要 Anthropic API Key

**建议替代方案:**
- 保留 Tier 1 测试：`skill-validation.test.ts`, `gen-skill-docs.test.ts`
- 保留单元测试：`worktree.test.ts`, `host-config.test.ts`, `timeline.test.ts`
- 移除 Tier 2/Tier 3 测试

**影响评估:** ⚠️ 中等
- 失去 E2E 测试覆盖，需依赖人工测试
- 但节省大量测试运行时间和成本

---

#### 1.5 外网依赖技能 — **建议移除**

**需要移除的技能目录:**

| 技能目录 | 外网依赖 | 移除理由 |
|----------|----------|----------|
| `codex/` | OpenAI API | `/codex` 需要调用 Codex CLI |
| `design-review/` | GPT Image API | 视觉分析需要外网 |
| `design-shotgun/` | GPT Image API | 图像生成需要外网 |
| `design-consultation/` | GPT Image API | 设计咨询需要外网 |
| `design-html/` | GPT Image API | HTML 生成需要外网 |
| `canary/` | 部署平台 | 需要外网部署目标 |
| `land-and-deploy/` | 部署平台 | 需要外网部署能力 |
| `setup-deploy/` | 部署配置 | 外网部署脚本 |
| `benchmark/` | 性能对比 | 需要外部基准数据 |

**保留的核心技能:**
```
/browse          - 浏览器核心 (必需)
/qa              - QA 测试工作流 (可保留)
/ship            - 发布工作流 (内网可适配)
/review          - 代码审查 (本地可运行)
/investigate     - 调试调查 (本地可运行)
/plan-*-review   - 规划审查 (本地可运行)
/office-hours    - YC Office Hours (咨询类)
/autoplan        - 自动规划 (本地可运行)
/cso             - 安全审计 (本地可运行)
```

---

### 第二类：需要裁剪/替换的文件

#### 2.1 脚本文件裁剪 (scripts/) — **部分保留**

**可移除:**
```
scripts/
├── eval-*.ts           # 评估相关脚本 (5 个文件)
│   ├── eval-compare.ts
│   ├── eval-list.ts
│   ├── eval-select.ts
│   ├── eval-summary.ts
│   └── eval-watch.ts
├── analytics.ts        # 分析脚本 (外网依赖)
├── dev-skill.ts        # 开发模式 (开发用)
├── app/                # App 构建脚本
└── build-app.sh        # App 构建脚本
```

**需保留:**
```
scripts/
├── gen-skill-docs.ts   # SKILL.md 生成 (必需)
├── skill-check.ts      # 技能健康检查 (有用)
├── host-config.ts      # 主机配置 (必需)
├── host-config-export.ts # 配置导出 (必需)
├── slop-diff.ts        # 代码质量检查 (可选)
├── build-node-cli.js   # Node CLI 构建 (内网必需)
├── resolvers/          # 模板解析器 (必需)
└── host-adapters/      # 主机适配器 (必需)
```

---

#### 2.2 Bin 工具裁剪 (bin/) — **部分保留**

**可移除 (外网依赖):**
```
bin/
├── gstack-analytics           # 分析上报
├── gstack-community-dashboard # 社区仪表板
├── gstack-telemetry-*         # 遥测日志/同步
├── gstack-builder-profile     # Builder 档案
├── gstack-update-check        # 更新检查
├── gstack-session-update      # 会话更新
└── gstack-global-discover     # 全局发现
```

**需保留:**
```
bin/
├── gstack-config              # 配置管理
├── gstack-relink              # 重链接
├── gstack-repo-mode           # 仓库模式
├── gstack-team-init           # 团队初始化
├── gstack-uninstall           # 卸载
├── gstack-slug                # slug 生成
├── gstack-diff-scope          # diff 范围
└── chrome-cdp                 # Chrome CDP
```

---

#### 2.3 Browse dist 文件 — **替换为 Node CLI**

**当前结构:**
```
browse/dist/
├── browse              # 编译后的 macOS 二进制 (~58MB)
├── find-browse         # 辅助二进制
├── browse.js           # Node CLI 包装器 (内网必需)
├── .version            # 版本文件
└── server.cjs          # 编译后的服务器
```

**内网建议:**
- 保留 `browse.js` (Node CLI 包装器)
- 移除 `browse` 二进制 (Mach-O arm64 不兼容 Windows/Linux)
- 使用 `bun run` 或 `node` 直接运行源码

---

### 第三类：需要条件编译/配置的文件

#### 3.1 技能模板调整

**需移除的占位符解析:**
- 移除与移除技能相关的占位符
- 保留核心技能模板生成功能

**文件:**
```
scripts/resolvers/
├── review.ts           # 保留
├── design.ts           # 移除
├── qa.ts               # 保留
└── ...
```

#### 3.2 Hosts 配置 (hosts/) — **已适配**

**当前状态:** ✅ 已完成适配
- 仅保留 `claude.ts` 和 `opencode.ts`
- 移除了其他 Agent 支持

**无需改动:** 当前配置已满足内网需求

---

## 瘦身效果预估

### 空间节省估算

| 类别 | 原大小 | 移除后 | 节省 |
|------|--------|--------|------|
| Design 模块 | ~60MB | 0MB | 60MB |
| 编译二进制 | ~120MB | 0MB | 120MB |
| Chrome 扩展 | ~150KB | 0KB | 150KB |
| E2E 测试 | ~2MB | 0.5MB | 1.5MB |
| 外网技能 | ~500KB | 0KB | 500KB |
| 脚本工具 | ~1MB | 0.3MB | 0.7MB |
| **总计** | **~184MB** | **~1MB** | **~183MB** |

### 功能保留率

| 功能模块 | 保留状态 | 说明 |
|----------|----------|------|
| 浏览器核心 | 100% | CLI + Server + Commands |
| 基础技能 | 70% | 保留 15/21 个技能 |
| 测试覆盖 | 40% | 仅保留 Tier 1 测试 |
| 平台支持 | 100% | macOS/Linux/Windows |
| 安全功能 | 100% | 7 层防御全部保留 |

---

## 迁移检查清单

### Phase 1: 移除外网依赖组件
- [ ] 删除 `design/` 目录
- [ ] 删除 `.github/workflows/` (保留 Docker 如需要)
- [ ] 删除外网依赖技能目录 (`codex/`, `design-*/`, `canary/`, `land-and-deploy/`, `setup-deploy/`, `benchmark/`)
- [ ] 删除高成本 E2E 测试 (`test/skill-e2e*.test.ts`, `codex-e2e.test.ts`, `gemini-e2e.test.ts`)

### Phase 2: 裁剪辅助工具
- [ ] 删除 `extension/` 目录
- [ ] 删除外网依赖 bin 工具 (`gstack-analytics`, `gstack-telemetry-*`, `gstack-update-check`)
- [ ] 删除评估脚本 (`scripts/eval-*.ts`, `scripts/analytics.ts`)
- [ ] 删除 `scripts/app/` 和 `build-app.sh`

### Phase 3: 保留并验证核心功能
- [ ] 验证 `browse/src/` 完整保留
- [ ] 验证核心技能模板可生成
- [ ] 验证 `bun run build:node` 可生成 Node CLI
- [ ] 验证基础测试通过 (`bun test` 排除 E2E)

### Phase 4: 内网配置
- [ ] 设置 `GSTACK_INTERNAL_NETWORK=1`
- [ ] 设置 `GSTACK_CHROMIUM_PATH` 指向内网 Chrome
- [ ] 禁用更新检查 `GSTACK_ENABLE_UPDATE_CHECK=0`
- [ ] 配置内网 npm 镜像 (如需要)

---

## 风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| 移除过多导致功能残缺 | 中 | 高 | 严格遵循评估矩阵，保留核心功能 |
| Node CLI 性能下降 | 低 | 中 | 使用 Bun 运行，性能接近原生 |
| 内网测试覆盖不足 | 高 | 中 | 建立内网专用的测试流程 |
| 用户习惯改变 | 中 | 低 | 提供清晰的迁移文档 |

---

## 附录：保留文件完整清单

### 核心运行时 (必需)
```
browse/src/           - 完整保留
├── cli.ts
├── server.ts
├── browser-manager.ts
├── tab-session.ts
├── commands.ts
├── read-commands.ts
├── write-commands.ts
├── meta-commands.ts
├── snapshot.ts
├── content-security.ts
├── url-validation.ts
├── cookie-*.ts
├── error-handling.ts
├── config.ts
└── ... (所有 .ts 文件)
```

### 技能系统 (必需)
```
*/SKILL.md.tmpl       - 保留核心技能模板
scripts/gen-skill-docs.ts
scripts/resolvers/
hosts/
```

### 构建工具 (必需)
```
scripts/build-node-cli.js
scripts/host-config.ts
scripts/host-config-export.ts
browse/scripts/build-node-server.sh
```

### 基础测试 (保留)
```
test/skill-validation.test.ts
test/gen-skill-docs.test.ts
test/worktree.test.ts
test/touchfiles.test.ts
test/helpers/
browse/test/
```

---

**计划完成时间:** 2026-04-12  
**评估者:** Claude Code  
**版本:** v0.16.2.0  
