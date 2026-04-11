# gstack 内网环境改造与落地执行方案

**文档目标**：针对严格受限的内网环境（无外网直连、拦截未经签名 `.exe`、Windows 宿主），依托全局已有的 Bun 环境，对 gstack 进行原生化改造。本方案旨在快速打通如 `/qa` 等核心 AI 工作流，为后续在研发团队内的实战分享与前端质量基建提供可落地的标准化指南。

---

## 1. 架构精简：Agent 依赖剥离

为缩减运行冗余并避免未配置 Agent 触发的异常报错，需对支持的配置层进行严格裁剪。

* **清理目标**：进入 `hosts/` 目录，仅保留 `claude.ts` 与 `opencode.ts`。
* **依赖擦除**：全局检索（主要集中在 `cli.ts` 与 `server.ts` 的命令分发注册表中），彻底移除被删配置文件的 `import` 语句与对应的初始化逻辑。

## 2. 运行模式降维：源码直驱替代二进制

内网安全策略会拦截由 `bun build --compile` 产出的 `.exe` 文件。鉴于系统已具备全局 Bun 环境，可直接利用其原生解析能力运行 TypeScript 代码，这能完全等价替代执行文件，并完美继承系统亚秒级的浏览器自动化体验。

* **执行命令替换**：定位到调用工具的底层封装脚本或 `SKILL.md.tmpl` 模板文件。
* **Browse 模块**：将原有的二进制调用 `./browse.exe goto <url>` 无缝替换为 `bun run 绝对路径/browse/src/cli.ts goto <url>`。
* **Design 模块**：将 `design.exe` 相关调用统一替换为 `bun run 绝对路径/design/src/cli.ts`。
* **其它模块**：将其它 .exe 文件按照上述方式做修改

## 3. 浏览器驱动内网化：Playwright-core 离线融合

由于标准 `playwright` 强依赖外网下载 Chromium，需替换为纯代码包 `playwright-core` 并将控制权交还给 Windows 本地浏览器。

* **依赖替换与搬运**：在外网开发机执行 `npm uninstall playwright` 并安装 `npm install playwright-core`。完成后，将包含完整 `node_modules` 的工程打包迁入内网。
* **本地路径硬编码注入**：打开 `browse/src/browser-manager.ts`，找到负责 Chromium 生命周期的核心代码（位于该 1187 行的模块中），重构如下：

```typescript
// 1. 将引入源修改为 core 版本
import { chromium } from 'playwright-core'; 

// 2. 注入内网 Windows 环境的本地 Chrome 路径
const browser = await chromium.launch({
  headless: true, // 调试阶段可设为 false 观察渲染
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', // 务必处理 Windows 反斜杠转义
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
```

## 4. 离线阻断：关闭自动检测更新
系统守护进程会在版本不匹配时触发自动重启机制。在内网环境下，请求外部 Releases 接口必然导致网络超时与进程崩溃。

逻辑剥离：在 browse/src/cli.ts 与 server.ts 中检索 checkUpdate 或版本对比逻辑。

强制绕过：注释掉相关网络请求，硬编码使得本地版本检测始终通过（即强制 localVersion === remoteVersion）。