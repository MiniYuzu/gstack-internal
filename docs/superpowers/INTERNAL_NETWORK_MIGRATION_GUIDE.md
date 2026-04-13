# gstack 内网迁移安装指南（Windows）

> **目标**：将改造后的 gstack 工程迁移到 Windows 内网环境并完成安装。

**适用环境**：
- Windows 系统
- 内网无互联网连接
- 已安装 Bun 和 Node.js
- 已有 playwright-core-xxx.tgz 离线包

---

## 一、外网准备

### 1.1 打包工程

在外网机器上执行：

```bash
cd /path/to/gstack

# 创建压缩包（排除 node_modules 和二进制）
tar -czf gstack-internal.tar.gz \
  --exclude='docs' \
  --exclude='.git' \
  --exclude='test' \
  --exclude='.DS_Store' \
  .
```

### 1.2 传输到内网

通过 U 盘、邮件附件等方式将 `gstack-internal.tar.gz` 传输到内网机器。

---

## 二、内网部署（Git Bash）

### 2.1 解压工程

打开 Git Bash，执行：

```bash
# 创建目录并解压
mkdir -p /c/gstack
cd /c/gstack
tar -xzf /path/to/gstack-internal.tar.gz
```

### 2.2 安装 playwright-core

```bash
cd /c/gstack

# 从离线包安装
bun install /path/to/playwright-core-1.58.2.tgz
```

### 2.3 配置环境变量

```bash
export GSTACK_INTERNAL_NETWORK=1
export GSTACK_ENABLE_UPDATE_CHECK=0
export GSTACK_CHROMIUM_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe"
```

验证 Chrome 路径：

```bash
ls "$GSTACK_CHROMIUM_PATH"
```

### 2.4 执行安装脚本

```bash
cd /c/gstack
./setup --host claude --team
```

setup 脚本将自动：
- 执行 `bun install` 安装依赖
- 执行 `bun run build:node` 构建 Node CLI
- 注册技能到 Claude Code

---

## 三、内网部署（PowerShell）

### 3.1 解压工程

```powershell
# 创建目录
New-Item -ItemType Directory -Force -Path C:\gstack
Set-Location C:\gstack

# 解压（使用 tar，Windows 10+ 内置）
tar -xzf C:\path\to\gstack-internal.tar.gz
```

### 3.2 安装 playwright-core

```powershell
Set-Location C:\gstack
bun install C:\path\to\playwright-core-1.58.2.tgz
```

### 3.3 配置环境变量

```powershell
$env:GSTACK_INTERNAL_NETWORK = "1"
$env:GSTACK_ENABLE_UPDATE_CHECK = "0"
$env:GSTACK_CHROMIUM_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

验证 Chrome 路径：

```powershell
Test-Path $env:GSTACK_CHROMIUM_PATH
```

### 3.4 执行安装脚本

```powershell
Set-Location C:\gstack
.\setup --host claude --team
```

---

## 四、永久化环境变量

### Git Bash

将环境变量添加到 `~/.bashrc`：

```bash
echo 'export GSTACK_INTERNAL_NETWORK=1' >> ~/.bashrc
echo 'export GSTACK_ENABLE_UPDATE_CHECK=0' >> ~/.bashrc
echo 'export GSTACK_CHROMIUM_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe"' >> ~/.bashrc

# 重新加载
source ~/.bashrc
```

### PowerShell

将环境变量添加到用户配置：

```powershell
[Environment]::SetEnvironmentVariable("GSTACK_INTERNAL_NETWORK", "1", "User")
[Environment]::SetEnvironmentVariable("GSTACK_ENABLE_UPDATE_CHECK", "0", "User")
[Environment]::SetEnvironmentVariable("GSTACK_CHROMIUM_PATH", "C:\Program Files\Google\Chrome\Application\chrome.exe", "User")
```

重启 PowerShell 后生效。

---

## 五、Chrome CDP 启动脚本

### Git Bash 版本

创建 `chrome-cdp.sh`：

```bash
cat > ~/chrome-cdp.sh << 'EOF'
#!/bin/bash
PORT="${1:-9211}"
USER_DATA="${2:-$TEMP/chrome-cdp-$RANDOM}"
"$GSTACK_CHROMIUM_PATH" --remote-debugging-port="$PORT" --user-data-dir="$USER_DATA" &
echo "Chrome started on port $PORT"
EOF

chmod +x ~/chrome-cdp.sh
```

### PowerShell 版本

创建 `chrome-cdp.ps1`：

```powershell
$port = if ($args[0]) { $args[0] } else { 9211 }
$userData = "$env:TEMP\chrome-cdp-$([System.Random]::new().Next())"
$chromePath = $env:GSTACK_CHROMIUM_PATH
Start-Process $chromePath -ArgumentList "--remote-debugging-port=$port", "--user-data-dir=$userData"
Write-Host "Chrome started on port $port"
```

---

## 六、验证安装

### 检查关键文件

**Git Bash：**
```bash
ls /c/gstack/browse/dist/browse.js
ls /c/gstack/node_modules/playwright-core/package.json
ls ~/.claude/skills/gstack
```

**PowerShell：**
```powershell
Test-Path C:gstackrowsedistbrowse.js
Test-Path C:gstacknode_modulesplaywright-corepackage.json
Test-Path $env:USERPROFILE\.claudeskillsgstack
```

### 启动 Chrome

**Git Bash：**
```bash
~/chrome-cdp.sh 9211
```

**PowerShell：**
```powershell
.\chrome-cdp.ps1 9211
```

---

## 依赖清单

| 组件 | 来源 | 说明 |
|------|------|------|
| Bun | 内网已安装 | JavaScript 运行时 |
| Node.js | 内网已安装 | 备用运行时 |
| Chrome | 内网已安装 | 浏览器 |
| playwright-core | 离线包 | bun install 安装 |
| gstack 源码 | tar 包 | 外网打包传入 |

---

## 安装后目录结构

```
C:\gstack\
├── browse\
│   ├── dist\
│   │   ├── browse.js          # Node CLI
│   │   └── server.cjs         # 服务器
│   └── src\
├── bin\                        # 工具脚本
├── hosts\                      # 主机配置
├── node_modules\               # 依赖（setup 生成）
│   └── playwright-core\
├── scripts\                    # 构建脚本
├── setup                       # 安装脚本
└── package.json
```
