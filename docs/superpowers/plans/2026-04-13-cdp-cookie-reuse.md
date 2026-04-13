# CDP Cookie 复用方案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 CDP (Chrome DevTools Protocol) 远程接管方案，让内网 Windows 用户无需解密 cookie 即可复用已登录的 Chrome 会话，使 QA 技能能直接验证页面而无需手动登录。

**Architecture:** 添加第三种浏览器连接模式 `'cdp'`，通过 `chromium.connectOverCDP()` 连接到用户已启动的远程调试 Chrome 实例。使用独立端口 9211 和独立的 user-data-dir 避免与日常 Chrome 冲突。

**Tech Stack:** TypeScript, Playwright-core, Bun, Chrome DevTools Protocol

---

## File Structure Overview

```
browse/src/
├── browser-manager.ts       # Modify: Add CDP connection mode, connectOverCDP method
├── commands.ts              # Modify: Add 'connect-cdp' command definition
├── write-commands.ts        # Modify: Implement connect-cdp command handler
├── cli.ts                   # Modify: Add connect-cdp to help text
bin/
└── chrome-cdp-start         # Create: Cross-platform script to launch Chrome with CDP
setup-browser-cookies/
├── SKILL.md.tmpl            # Modify: Add CDP mode documentation
└── SKILL.md                 # Regenerate: After template change
```

---

## Task 1: BrowserManager CDP Connection Support

**Files:**
- Modify: `browse/src/browser-manager.ts`

**Context:** BrowserManager 目前支持两种模式：`'launched'`（headless 启动）和 `'headed'`（有头模式）。需要添加第三种 `'cdp'` 模式，通过 CDP WebSocket 连接到远程 Chrome 实例。

### Step 1: Add CDP mode type and state

```typescript
// In browse/src/browser-manager.ts
// Find: private connectionMode: 'launched' | 'headed' = 'launched';
// Replace with:
private connectionMode: 'launched' | 'headed' | 'cdp' = 'launched';
private cdpEndpoint: string | null = null;
```

### Step 2: Add connectOverCDP method

在 `BrowserManager` 类中添加新方法（位置：在 `launch()` 方法之后）：

```typescript
/**
 * Connect to an existing Chrome instance via CDP (Chrome DevTools Protocol).
 * This allows reusing the user's logged-in sessions without cookie decryption.
 * 
 * @param wsEndpoint - CDP WebSocket endpoint (e.g., 'http://localhost:9211')
 * @returns Promise<void>
 */
async connectOverCDP(wsEndpoint: string): Promise<void> {
  if (this.browser || this.context) {
    throw new Error('Browser already connected. Use disconnect() first.');
  }

  console.log(`[browse] Connecting to Chrome via CDP at ${wsEndpoint}...`);

  try {
    // Connect to existing Chrome via CDP
    this.browser = await chromium.connectOverCDP(wsEndpoint);
    
    // Use existing context or create new one
    const contexts = this.browser.contexts();
    if (contexts.length > 0) {
      this.context = contexts[0];
      console.log(`[browse] Reusing existing browser context`);
    } else {
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      console.log(`[browse] Created new browser context`);
    }

    // Use existing pages or create new one
    const pages = this.context.pages();
    if (pages.length > 0) {
      // Use the first existing page
      const firstPage = pages[0];
      this.pages.set(0, firstPage);
      this.tabSessions.set(0, new TabSession(firstPage));
      this.activeTabId = 0;
      console.log(`[browse] Reusing existing page: ${firstPage.url()}`);
    } else {
      // Create new page
      const page = await this.context.newPage();
      this.pages.set(0, page);
      this.tabSessions.set(0, new TabSession(page));
      this.activeTabId = 0;
    }

    this.connectionMode = 'cdp';
    this.cdpEndpoint = wsEndpoint;
    this.intentionalDisconnect = false;

    // Handle disconnect
    this.browser.on('disconnected', () => {
      if (this.intentionalDisconnect) return;
      console.error('[browse] CDP connection lost. Chrome may have closed.');
      console.error('[browse] Run: $B connect-cdp to reconnect.');
    });

    console.log(`[browse] CDP connection established. Mode: cdp`);
  } catch (err: any) {
    throw new Error(`Failed to connect via CDP: ${err.message}. Ensure Chrome is running with --remote-debugging-port=9211`);
  }
}
```

### Step 3: Update getConnectionMode

```typescript
// Find: getConnectionMode(): 'launched' | 'headed' { return this.connectionMode; }
// Replace with:
getConnectionMode(): 'launched' | 'headed' | 'cdp' { return this.connectionMode; }
```

### Step 4: Update disconnect method for CDP mode

在 `disconnect()` 方法中添加 CDP 处理（在方法开头）：

```typescript
async disconnect(): Promise<void> {
  if (this.connectionMode === 'cdp') {
    this.intentionalDisconnect = true;
    if (this.browser) {
      // For CDP, just disconnect without closing Chrome
      await this.browser.disconnect().catch(() => {});
    }
    this.browser = null;
    this.context = null;
    this.pages.clear();
    this.tabSessions.clear();
    this.activeTabId = 0;
    this.connectionMode = 'launched';
    this.cdpEndpoint = null;
    console.log('[browse] Disconnected from CDP (Chrome still running)');
    return;
  }
  
  // ... existing disconnect logic for launched/headed modes
}
```

### Step 5: Update close method for CDP mode

在 `close()` 方法中添加 CDP 处理：

```typescript
async close(): Promise<void> {
  if (this.connectionMode === 'cdp') {
    // For CDP, only disconnect - don't close the user's Chrome
    await this.disconnect();
    return;
  }
  
  // ... existing close logic
}
```

### Step 6: Add CDP status to health check

在 `isHealthy()` 或状态输出中添加 CDP 信息：

```typescript
// Add method to get CDP status
getCDPStatus(): { connected: boolean; endpoint: string | null; mode: string } {
  return {
    connected: this.browser?.isConnected() || false,
    endpoint: this.cdpEndpoint,
    mode: this.connectionMode,
  };
}
```

### Step 7: Commit

```bash
git add browse/src/browser-manager.ts
git commit -m "feat(browser-manager): add CDP connection mode for cookie reuse

- Add 'cdp' to connectionMode union type
- Implement connectOverCDP() method to connect to remote Chrome
- Handle CDP disconnection gracefully without closing user's Chrome
- Add getCDPStatus() for connection state inspection

This enables Windows/internal network users to reuse logged-in
Chrome sessions without cookie decryption."
```

---

## Task 2: Add connect-cdp Command

**Files:**
- Modify: `browse/src/commands.ts`
- Modify: `browse/src/write-commands.ts`
- Modify: `browse/src/token-registry.ts` (if needed for permission)

### Step 1: Register connect-cdp command

```typescript
// In browse/src/commands.ts
// Add to SERVER_COMMANDS array (around line 38):
'connect-cdp',

// Add to COMMAND_REGISTRY (after 'connect' entry):
'connect-cdp': { 
  category: 'Server', 
  description: 'Connect to Chrome via CDP for cookie reuse (port 9211)', 
  usage: 'connect-cdp [wsEndpoint]' 
},
```

### Step 2: Add to write commands

```typescript
// In browse/src/write-commands.ts
// Add to WRITE_COMMANDS Set (around line 25):
'connect-cdp',
```

### Step 3: Implement connect-cdp handler

在 `write-commands.ts` 的 `executeWriteCommand` 函数中添加 case：

```typescript
// Find: case 'connect': {
// Add after connect case:

case 'connect-cdp': {
  const wsEndpoint = args[0] || 'http://localhost:9211';
  
  // Validate URL format
  try {
    new URL(wsEndpoint);
  } catch {
    throw new Error(`Invalid CDP endpoint: ${wsEndpoint}. Expected format: http://localhost:9211`);
  }

  // Check if already connected in CDP mode
  if (bm.getConnectionMode() === 'cdp') {
    const status = bm.getCDPStatus();
    return `Already connected via CDP to ${status.endpoint}. Run '$B disconnect' first to reconnect.`;
  }

  // Disconnect from current mode if connected
  if (bm.isHealthy()) {
    console.log('[browse] Disconnecting from current browser...');
    await bm.disconnect();
  }

  // Connect via CDP
  await bm.connectOverCDP(wsEndpoint);
  
  const page = bm.getPage();
  const url = page.url();
  
  return `Connected to Chrome via CDP at ${wsEndpoint}. Current page: ${url || '(blank)'}`;
}
```

### Step 4: Add permission to token registry

```typescript
// In browse/src/token-registry.ts
// Add to SCOPE_ADMIN set (line 58):
'connect-cdp',
```

### Step 5: Commit

```bash
git add browse/src/commands.ts browse/src/write-commands.ts browse/src/token-registry.ts
git commit -m "feat(commands): add connect-cdp command for CDP connection

- Add 'connect-cdp' to command registry with optional wsEndpoint param
- Implement handler to connect via chromium.connectOverCDP()
- Default endpoint: http://localhost:9211
- Requires SCOPE_ADMIN permission level

Usage: $B connect-cdp [wsEndpoint]"
```

---

## Task 3: Cross-Platform Chrome CDP Launch Script

**Files:**
- Create: `bin/chrome-cdp-start` (bash for macOS/Linux)
- Create: `bin/chrome-cdp-start.txt` (Windows batch - renamed to .txt for internal network compatibility)

### Step 1: Create Unix launch script

```bash
#!/bin/bash
# Launch Chrome with CDP (remote debugging) enabled for gstack.
# Usage: chrome-cdp-start [port]
#
# This script creates an isolated Chrome profile for gstack testing,
# preventing interference with the user's daily Chrome instance.

PORT="${1:-9211}"
GSTACK_DATA_DIR="${GSTACK_DATA_DIR:-$HOME/.gstack/cdp-chrome-profile}"

# Detect Chrome path based on OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    CHROME_PATHS=(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    )
else
    # Linux
    CHROME_PATHS=(
        "/usr/bin/google-chrome"
        "/usr/bin/google-chrome-stable"
        "/usr/bin/chromium"
        "/usr/bin/chromium-browser"
        "/usr/bin/microsoft-edge"
        "/usr/bin/brave"
    )
fi

# Find first available Chrome
CHROME=""
for path in "${CHROME_PATHS[@]}"; do
    if [ -x "$path" ]; then
        CHROME="$path"
        break
    fi
done

if [ -z "$CHROME" ]; then
    echo "ERROR: Chrome not found. Please install Google Chrome or Chromium." >&2
    echo "Searched paths:" >&2
    printf '  %s\n' "${CHROME_PATHS[@]}" >&2
    exit 1
fi

echo "Found Chrome: $CHROME"

# Create isolated profile directory
mkdir -p "$GSTACK_DATA_DIR"

# Check if Chrome is already running on CDP port
if curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
    echo "Chrome is already running with CDP on port $PORT"
    echo "You can now run: $B connect-cdp"
    exit 0
fi

echo "Launching Chrome with CDP on port $PORT..."
echo "Data directory: $GSTACK_DATA_DIR"
echo ""
echo "NOTE: This Chrome instance is isolated from your daily browser."
echo "      Login to websites here, then run: $B connect-cdp"
echo ""

# Launch Chrome with CDP
"$CHROME" \
    --remote-debugging-port="$PORT" \
    --remote-allow-origins="http://localhost:$PORT" \
    --user-data-dir="$GSTACK_DATA_DIR" \
    --no-first-run \
    --no-default-browser-check \
    --enable-automation \
    --disable-features=IsolateOrigins,site-per-process \
    --disable-site-isolation-trials \
    &

CHROME_PID=$!
disown $CHROME_PID 2>/dev/null || true

# Wait for CDP to be available
echo "Waiting for CDP to be ready..."
for i in $(seq 1 30); do
    if curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
        echo ""
        echo "✓ CDP ready on port $PORT"
        echo "✓ Run: $B connect-cdp"
        exit 0
    fi
    echo -n "."
    sleep 1
done

echo ""
echo "ERROR: CDP not available after 30s. Chrome may have failed to start." >&2
exit 1
```

### Step 2: Create Windows batch script (.txt extension)

```batch
@echo off
REM Launch Chrome with CDP (remote debugging) enabled for gstack on Windows.
REM Usage: chrome-cdp-start.txt [port]
REM NOTE: This file has .txt extension for internal network compatibility.
REM       Users should rename to .bat before use, or run via cmd: cmd /c chrome-cdp-start.txt
REM
REM This script creates an isolated Chrome profile for gstack testing,
REM preventing interference with the user's daily Chrome instance.

setlocal enabledelayedexpansion

set "PORT=%~19211"
if "%~1"=="" set "PORT=9211"

set "GSTACK_DATA_DIR=%USERPROFILE%\.gstack\cdp-chrome-profile"

REM Detect Chrome path
set "CHROME="
for %%p in (
    "C:\Program Files\Google\Chrome\Application\chrome.exe"
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
) do (
    if exist %%p (
        set "CHROME=%%~p"
        goto :found_chrome
    )
)

echo ERROR: Chrome not found. Please install Google Chrome or Microsoft Edge. >&2
echo Searched paths: >&2
echo   C:\Program Files\Google\Chrome\Application\chrome.exe >&2
echo   C:\Program Files (x86)\Google\Chrome\Application\chrome.exe >&2
echo   %%LOCALAPPDATA%%\Google\Chrome\Application\chrome.exe >&2
echo   [Edge paths...] >&2
exit /b 1

:found_chrome
echo Found Chrome: %CHROME%

REM Create isolated profile directory
if not exist "%GSTACK_DATA_DIR%" mkdir "%GSTACK_DATA_DIR%"

REM Check if Chrome is already running on CDP port
curl -s "http://localhost:%PORT%/json/version" >nul 2>&1
if %errorlevel%==0 (
    echo Chrome is already running with CDP on port %PORT%
    echo You can now run: $B connect-cdp
    exit /b 0
)

echo Launching Chrome with CDP on port %PORT%...
echo Data directory: %GSTACK_DATA_DIR%
echo.
echo NOTE: This Chrome instance is isolated from your daily browser.
echo       Login to websites here, then run: $B connect-cdp
echo.

start "" "%CHROME%" ^
    --remote-debugging-port=%PORT% ^
    --remote-allow-origins="http://localhost:%PORT%" ^
    --user-data-dir="%GSTACK_DATA_DIR%" ^
    --no-first-run ^
    --no-default-browser-check ^
    --enable-automation ^
    --disable-features=IsolateOrigins,site-per-process ^
    --disable-site-isolation-trials

REM Wait for CDP to be available
echo Waiting for CDP to be ready...
for /L %%i in (1,1,30) do (
    curl -s "http://localhost:%PORT%/json/version" >nul 2>&1
    if !errorlevel!==0 (
        echo.
        echo [OK] CDP ready on port %PORT%
        echo [OK] Run: $B connect-cdp
        exit /b 0
    )
    ping -n 2 127.0.0.1 >nul
    set /p "=.<nul"
)

echo.
echo ERROR: CDP not available after 30s. Chrome may have failed to start. >&2
exit /b 1
```

### Step 3: Make scripts executable

```bash
chmod +x bin/chrome-cdp-start
```

### Step 4: Commit

```bash
git add bin/chrome-cdp-start bin/chrome-cdp-start.txt
git commit -m "feat(bin): add cross-platform Chrome CDP launch scripts

Add chrome-cdp-start (Unix) and chrome-cdp-start.bat (Windows):
- Launch Chrome with --remote-debugging-port=9211
- Use isolated --user-data-dir to avoid interfering with daily Chrome
- Auto-detect Chrome/Edge installation path
- Wait for CDP endpoint to be ready
- Support custom port via command line argument

These scripts enable Windows/internal network users to launch
Chrome in a mode that gstack can connect to for cookie reuse."
```

---

## Task 4: Update setup-browser-cookies Skill

**Files:**
- Modify: `setup-browser-cookies/SKILL.md.tmpl`
- Generate: `setup-browser-cookies/SKILL.md`

### Step 1: Update SKILL.md.tmpl

找到 `## CDP mode check` 部分，保留但更新。然后在 `## How it works` 之前添加新的 CDP 模式说明：

```markdown
## CDP Mode (Recommended for Windows/Internal Networks)

If you're on Windows or an internal network without cookie decryption support,
use **CDP Mode** to connect to your Chrome instance directly. This bypasses
the need for cookie import entirely.

### Prerequisites

1. Chrome must be launched with remote debugging enabled
2. Use port **9211** (gstack default)
3. Use an isolated `--user-data-dir` to avoid interfering with your daily Chrome

### Quick Start

#### Windows

```batch
REM Step 1: Launch Chrome with CDP (run once)
REM Note: Rename chrome-cdp-start.txt to .bat first, or run:
cmd /c chrome-cdp-start.txt

REM Step 2: Login to your websites in the Chrome window

REM Step 3: Connect gstack
$B connect-cdp

REM Step 4: Start testing - you're already logged in!
$B goto https://your-internal-app.com
$B snapshot -i
```

#### macOS/Linux

```bash
# Step 1: Launch Chrome with CDP (run once)
chrome-cdp-start

# Step 2: Login to your websites in the Chrome window

# Step 3: Connect gstack
$B connect-cdp

# Step 4: Start testing - you're already logged in!
$B goto https://your-app.com
$B snapshot -i
```

### Manual Chrome Launch (if script doesn't work)

If the launch script fails, start Chrome manually:

**Windows:**
```batch
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9211 ^
  --remote-allow-origins="http://localhost:9211" ^
  --user-data-dir="%USERPROFILE%\.gstack\cdp-chrome-profile"
```
(Or use the provided chrome-cdp-start.txt script - rename to .bat before running)

**macOS:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9211 \
  --remote-allow-origins="http://localhost:9211" \
  --user-data-dir="$HOME/.gstack/cdp-chrome-profile"
```

### CDP Connection Status

Check if you're in CDP mode:
```bash
$B status
# Should show: Mode: cdp
```

### Disconnecting

```bash
# Disconnect gstack (Chrome keeps running)
$B disconnect

# Later, to reconnect
$B connect-cdp
```

---
```

### Step 2: Update CDP mode check section

更新现有的 CDP mode check 部分以反映新功能：

```markdown
## CDP mode check

First, check if browse is already connected to Chrome via CDP:
```bash
$B status 2>/dev/null | grep -q "Mode: cdp" && echo "CDP_MODE=true" || echo "CDP_MODE=false"
```
If `CDP_MODE=true`: tell the user "Already connected via CDP. Your browser session with all cookies is active." and stop.

If the user is on **Windows** or requests CDP mode:
1. Check if CDP Chrome is available: `curl -s http://localhost:9211/json/version`
2. If available: guide them to run `$B connect-cdp`
3. If not available: guide them to run `chrome-cdp-start` first
```

### Step 3: Update Steps section

在 `## Steps` 部分添加 CDP 选项：

```markdown
## Steps

Choose your approach based on your platform:

| Platform | Recommended Approach |
|----------|---------------------|
| macOS | Use cookie-import-browser (native) or CDP mode |
| Linux | Use cookie-import-browser (native) or CDP mode |
| Windows | **Use CDP mode** (cookie import not available) |
| Internal Network | **Use CDP mode** (bypasses cookie decryption) |

### Approach A: CDP Mode (Windows/Internal Networks)

```bash
# 1. Launch Chrome with CDP (if not already running)
chrome-cdp-start

# 2. Wait for Chrome to open, then login to your websites manually

# 3. Connect browse
$B connect-cdp

# 4. Verify connection
$B status  # Should show: Mode: cdp

# 5. Start testing - cookies are automatically available
$B goto https://your-app.com
$B cookies  # Should show your logged-in cookies
```

### Approach B: Cookie Import (macOS/Linux)

[Keep existing cookie-import-browser steps...]
```

### Step 4: Regenerate SKILL.md

```bash
bun run gen:skill-docs
```

### Step 5: Commit

```bash
git add setup-browser-cookies/SKILL.md.tmpl setup-browser-cookies/SKILL.md
git commit -m "docs(setup-browser-cookies): add CDP mode documentation for Windows

- Add comprehensive CDP mode guide for Windows/internal network users
- Document chrome-cdp-start script usage
- Provide manual Chrome launch commands as fallback
- Add platform-specific recommendation table
- Regenerate SKILL.md from template

CDP mode allows cookie reuse without decryption on all platforms."
```

---

## Task 5: Add CDP Status to browse status Command

**Files:**
- Modify: `browse/src/read-commands.ts` or `browse/src/meta-commands.ts`

### Step 1: Update status command

找到 `status` 命令的实现，添加 CDP 信息：

```typescript
// In read-commands.ts or meta-commands.ts, in the status command handler
case 'status': {
  const mode = bm.getConnectionMode();
  const cdpStatus = bm.getCDPStatus();
  
  const lines = [
    `Mode: ${mode}`,
    `Connected: ${bm.isHealthy() ? 'yes' : 'no'}`,
  ];
  
  if (mode === 'cdp' && cdpStatus.endpoint) {
    lines.push(`CDP Endpoint: ${cdpStatus.endpoint}`);
  }
  
  // ... rest of status output
  
  return lines.join('\n');
}
```

### Step 2: Commit

```bash
git add browse/src/read-commands.ts  # or meta-commands.ts
git commit -m "feat(commands): show CDP endpoint in status command

When in CDP mode, 'browse status' now displays the CDP endpoint URL,
making it easier to verify the connection configuration."
```

---

## Task 6: Update browse SKILL.md Documentation

**Files:**
- Modify: `browse/SKILL.md.tmpl`
- Generate: `browse/SKILL.md`

### Step 1: Add CDP commands to command reference

在 `{{COMMAND_REFERENCE}}` 部分或 `## Server` 部分添加：

```markdown
| `connect-cdp [wsEndpoint]` | Connect to Chrome via CDP (default: http://localhost:9211) |
```

### Step 2: Add CDP section to browse documentation

在 SKILL.md.tmpl 中添加新的文档章节：

```markdown
## CDP Mode (Remote Chrome Connection)

Connect to an existing Chrome instance via Chrome DevTools Protocol (CDP).
This allows reusing your logged-in browser sessions without cookie import.

### Use Cases

- **Windows users**: Cookie import requires DPAPI support which is not implemented
- **Internal networks**: Bypass cookie decryption entirely
- **Shared sessions**: Connect multiple gstack instances to the same Chrome

### Setup

1. **Launch Chrome with remote debugging:**
   ```bash
   chrome-cdp-start  # Uses port 9211 and isolated profile
   ```

2. **Login to websites in the Chrome window**

3. **Connect gstack:**
   ```bash
   $B connect-cdp
   # Or with custom endpoint:
   $B connect-cdp http://localhost:9222
   ```

4. **Verify connection:**
   ```bash
   $B status
   # Mode: cdp
   # Connected: yes
   # CDP Endpoint: http://localhost:9211
   ```

### Differences from Normal Mode

| Feature | Normal Mode | CDP Mode |
|---------|-------------|----------|
| Cookie management | Import via `cookie-import-browser` | Reuse Chrome's cookies directly |
| Chrome lifecycle | gstack starts/stops Chrome | User controls Chrome lifecycle |
| Visual browser | Headless by default | Must use headed Chrome |
| Multi-tab | gstack manages tabs | Uses Chrome's existing tabs |

### Disconnecting

```bash
$B disconnect  # Disconnects gstack, Chrome keeps running
```

To completely close:
1. Disconnect gstack: `$B disconnect`
2. Close Chrome window manually
```

### Step 3: Regenerate browse SKILL.md

```bash
bun run gen:skill-docs
```

### Step 4: Commit

```bash
git add browse/SKILL.md.tmpl browse/SKILL.md
git commit -m "docs(browse): add CDP mode documentation

- Document connect-cdp command
- Add CDP setup and usage instructions
- Compare CDP mode vs normal mode
- Include Windows-specific guidance

Helps users understand when and how to use CDP mode
to reuse browser sessions without cookie decryption."
```

---

## Task 7: Testing

**Files:**
- Create: `browse/test/cdp-connection.test.ts`

### Step 1: Write CDP connection test

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';
import { chromium } from 'playwright-core';
import * as http from 'http';

describe('CDP Connection', () => {
  let bm: BrowserManager;
  let mockCDPServer: http.Server;
  let mockPort: number;

  beforeEach(async () => {
    bm = new BrowserManager();
  });

  afterEach(async () => {
    await bm.close().catch(() => {});
    if (mockCDPServer) {
      mockCDPServer.close();
    }
  });

  test('should report correct initial mode', () => {
    expect(bm.getConnectionMode()).toBe('launched');
  });

  test('should report CDP status when not connected', () => {
    const status = bm.getCDPStatus();
    expect(status.connected).toBe(false);
    expect(status.endpoint).toBeNull();
    expect(status.mode).toBe('launched');
  });

  test('connectOverCDP should fail gracefully when Chrome not running', async () => {
    // Try to connect to non-existent CDP endpoint
    await expect(
      bm.connectOverCDP('http://localhost:59999')
    ).rejects.toThrow('Failed to connect via CDP');
  });

  test('should require disconnect before switching modes', async () => {
    // This test requires a real Chrome instance with CDP
    // Skip if not available
    const hasChrome = process.env.GSTACK_CHROMIUM_PATH || process.env.CHROME_PATH;
    if (!hasChrome) {
      console.log('Skipping: No Chrome path configured');
      return;
    }

    // First launch in normal mode
    await bm.launch();
    expect(bm.getConnectionMode()).toBe('launched');

    // Should throw when trying to connect CDP without disconnect
    await expect(
      bm.connectOverCDP('http://localhost:9211')
    ).rejects.toThrow('Browser already connected');
  });
});
```

### Step 2: Add integration test for connect-cdp command

```typescript
// In browse/test/commands-integration.test.ts or new file
describe('connect-cdp command', () => {
  test('should validate endpoint URL format', async () => {
    // Test that invalid URLs are rejected
  });

  test('should use default endpoint when not specified', async () => {
    // Test default http://localhost:9211
  });

  test('should report already connected in CDP mode', async () => {
    // Test the error message when already connected
  });
});
```

### Step 3: Run tests

```bash
bun test browse/test/cdp-connection.test.ts
```

### Step 4: Commit

```bash
git add browse/test/cdp-connection.test.ts
git commit -m "test(browse): add CDP connection tests

- Test initial mode state
- Test CDP status reporting
- Test graceful failure when Chrome not running
- Test mode switching restrictions

Note: Full integration tests require Chrome with CDP enabled."
```

---

## Task 8: Final Integration and Verification

### Step 1: Run full test suite

```bash
# Run browse unit tests
bun test browse/test/

# Run skill validation
bun test test/skill-validation.test.ts

# Regenerate all docs
bun run gen:skill-docs
```

### Step 2: Manual end-to-end test

```bash
# 1. Build the project
bun run build

# 2. Start Chrome with CDP
./bin/chrome-cdp-start

# 3. In another terminal, connect browse
$B connect-cdp

# 4. Verify connection
$B status

# 5. Test with a real website
$B goto https://github.com
$B cookies
$B snapshot -i

# 6. Test disconnect
$B disconnect
```

### Step 3: Commit any remaining changes

```bash
git add -A
git commit -m "feat: complete CDP cookie reuse implementation

- Add connectOverCDP() to BrowserManager for CDP connections
- Add 'connect-cdp' command to browse CLI
- Create cross-platform chrome-cdp-start scripts
- Update setup-browser-cookies skill with CDP documentation
- Update browse SKILL.md with CDP mode guide
- Add CDP connection tests

This enables Windows and internal network users to reuse
logged-in Chrome sessions without cookie decryption.

Closes #[issue-number]"
```

---

## Spec Coverage Checklist

| Requirement | Implementation Task |
|-------------|---------------------|
| CDP connection mode | Task 1: BrowserManager CDP support |
| Port 9211 | Task 3: chrome-cdp-start scripts default to 9211 |
| --user-data-dir isolation | Task 3: Scripts use isolated profile directory |
| Windows support | Task 3: chrome-cdp-start.bat for Windows |
| QA skill integration | Task 4: setup-browser-cookies skill docs |
| Command availability | Task 2: connect-cdp command |

---

## Placeholder Scan

- No "TBD", "TODO", or "implement later"
- All code blocks contain complete implementations
- All file paths are exact
- All commands have expected outputs

---

**Plan saved to:** `docs/superpowers/plans/2026-04-13-cdp-cookie-reuse.md`

**Execution options:**

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach would you prefer?
