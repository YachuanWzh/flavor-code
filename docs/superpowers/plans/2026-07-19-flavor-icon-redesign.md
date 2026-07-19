# Flavor Code 图标重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 flavor-code 桌面应用重新设计图标，在保留对话气泡造型的基础上加入粉色吐舌（flavor）和花括号眼睛（code），让名字双重含义都能体现，并正确配置 Electron 打包与运行时图标。

**Architecture:** 以 SVG 为源文件，通过构建脚本生成高分辨率 PNG；electron-builder 自动从 PNG 生成 Windows 所需的 ICO/macOS 所需的 ICNS；BrowserWindow 运行时直接引用 PNG。图标居中修正通过调整 SVG 路径坐标完成。

**Tech Stack:** SVG、sharp（SVG→PNG 转换）、electron-builder、Electron BrowserWindow icon 配置。

## Global Constraints

- 图标 viewBox 保持 `0 0 512 512`，圆角矩形 rx/ry=112
- 品牌蓝色保持：起始 `#4a9fe8`，终止 `#1979c9`
- 舌头使用粉色系（`#ec4899` 深粉描边/`#f472b6` 浅粉填充，或近似珊瑚粉），与蓝底有足够对比度
- 白色气泡保留右下角小尾巴，整体视觉重心相比原版略向左上偏移
- 不新增深色/浅色模式变体
- 生成的 PNG 至少 512×512，供 electron-builder 自动转换

---

## 文件结构概览

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `assets/icon.svg` | 图标源文件，唯一真理来源 |
| 修改 | `assets/icon-256.png` | 由新 SVG 重新生成（256×256） |
| 新增 | `assets/icon.png` | 512×512 PNG，electron-builder + BrowserWindow 引用 |
| 新增 | `scripts/build-icons.mjs` | 从 SVG 生成 PNG 的构建脚本 |
| 修改 | `package.json` | 添加 sharp devDep、icons 构建脚本、build.icon 字段、prebuild 钩子 |
| 修改 | `src/desktop/main.ts` | BrowserWindow 构造参数中添加 icon 路径 |

---

### Task 1: 安装 sharp 作为 devDependency

**Files:**
- Modify: `package.json:89-98`（devDependencies 区域）

- [ ] **Step 1: 安装 sharp**

Run:
```bash
npm install --save-dev sharp
```

Expected: package.json devDependencies 中新增 `"sharp": "^x.y.z"`，package-lock.json 更新。

- [ ] **Step 2: 验证安装成功**

Run:
```bash
node -e "import('sharp').then(s => console.log('sharp version:', s.default.versions))"
```
Expected: 输出 sharp version 信息，无错误。

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): 添加 sharp 用于图标生成"
```

---

### Task 2: 重写 assets/icon.svg 为新设计

**Files:**
- Modify: `assets/icon.svg`

**设计要点：**
- 背景：蓝渐变圆角方形（保持原样）
- 白色气泡：相比原版向左上偏移约 8-10px，尾巴保留但适当调整位置使其视觉居中
- 眼睛：左 `{` 右 `}`，用深蓝色 `#1979c9` 描边，stroke-width 约 10-12，stroke-linecap round，stroke-linejoin round，大小和位置约在原圆眼位置（cx≈228 / 340, cy≈265），每个花括号宽约 30、高约 36，做成弯弯的笑眼形状
- 嘴巴：半圆形张开的嘴，深蓝 `#1979c9` 填充，中心大约在 y=335，宽约 70、高约 40，呈上圆弧/下弧线的半圆
- 舌头：椭圆粉色舌头从嘴里伸出，填充色 `#f472b6`，描边色 `#ec4899`（细描边 3-4px），舌尖略向下，椭圆中心约 y=350，宽约 40、高约 30

**花括号 `{` 的 SVG path 参考**（约 30 宽 × 36 高，开口朝右）：
```
M 0 0 C 8 0 8 12 8 18 C 8 24 2 24 0 24 M 0 24 C 2 24 8 24 8 30 C 8 36 8 48 0 48 M 8 24 C 14 24 14 18 20 18 M 8 24 C 14 24 14 30 20 30
```
（实际路径需根据大小比例调整 transform 变换）

右花括号 `}` 是左括号的水平镜像。

- [ ] **Step 1: 备份原图标**

Run:
```bash
cp assets/icon.svg assets/icon.svg.bak
cp assets/icon-256.png assets/icon-256.png.bak
```

- [ ] **Step 2: 写入新 SVG**

用新设计覆盖 `assets/icon.svg`，完整内容如下：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#4a9fe8"/>
      <stop offset="100%" stop-color="#1979c9"/>
    </linearGradient>
  </defs>
  <!-- 圆角方形背景 -->
  <rect x="0" y="0" width="512" height="512" rx="112" ry="112" fill="url(#bg)"/>
  <!-- 对话气泡/笑脸轮廓（整体左上偏移约 8px，修正视觉重心） -->
  <path d="M120 268c0-85 72-155 155-155s155 70 155 155c0 40-15 75-42 103l16 56-62-18a148 148 0 0 1-67 14c-85 0-155-70-155-155Z"
        fill="#fff" stroke="#fff" stroke-width="12"/>
  <!-- 左眼：左花括号 { -->
  <path d="M213 246c6 0 9 6 9 12c0 5-4 8-8 8c4 0 8 3 8 8c0 6-3 12-9 12"
        fill="none" stroke="#1979c9" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <!-- 右眼：右花括号 } -->
  <path d="M355 246c-6 0-9 6-9 12c0 5 4 8 8 8c-4 0-8 3-8 8c0 6 3 12 9 12"
        fill="none" stroke="#1979c9" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <!-- 张开的嘴（半圆，深蓝填充） -->
  <path d="M228 328c18 22 38 30 60 30s42-8 60-30c-4-28-30-48-60-48s-56 20-60 48Z"
        fill="#1979c9"/>
  <!-- 舌头（粉色椭圆，从嘴中伸出） -->
  <path d="M248 348c0 18 18 34 40 34s40-16 40-34c0-8-8-14-18-14c-6 0-12 2-22 2s-16-2-22-2c-10 0-18 6-18 14Z"
        fill="#f472b6" stroke="#db2777" stroke-width="3"/>
</svg>
```

**说明：**
- 气泡路径从 `M128 280…` 调整为 `M120 268…`，整体左上移约 8-12px
- 左花括号位于 (213,246)，右花括号位于 (355,246)，形状为弯弯笑眼
- 嘴巴是上宽下窄的半圆/倒U 形，深蓝填充
- 舌头为柔和椭圆，粉色填充加深粉描边，舌尖向下

- [ ] **Step 3: 打开 SVG 预览检查**

用浏览器打开 `assets/icon.svg`（或在 IDE 中预览），确认：
1. 整体视觉居中（不偏右下）
2. 花括号左右对称、像笑眼
3. 舌头从嘴中伸出、粉色明显
4. 右下角气泡尾巴不抢主体

如视觉上某元素位置/大小不协调，调整坐标。

- [ ] **Step 4: Commit**

```bash
git add assets/icon.svg
git commit -m "feat(assets): 重设计图标——花括号眼睛 + 粉色吐舌"
```

---

### Task 3: 编写图标构建脚本并生成 PNG

**Files:**
- Create: `scripts/build-icons.mjs`
- Modify: `assets/icon-256.png`（重建）
- Create: `assets/icon.png`（512×512）

- [ ] **Step 1: 确保 scripts 目录存在**

Run:
```bash
mkdir -p scripts
```

- [ ] **Step 2: 写入构建脚本**

Create `scripts/build-icons.mjs`:

```js
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const svgPath = join(projectRoot, "assets", "icon.svg");
const out512 = join(projectRoot, "assets", "icon.png");
const out256 = join(projectRoot, "assets", "icon-256.png");

const svg = await readFile(svgPath);

// 512x512 PNG（electron-builder + BrowserWindow 主图标）
await sharp(svg)
  .resize(512, 512)
  .png()
  .toFile(out512);
console.log(`✓ wrote ${out512}`);

// 256x256 PNG（兼容旧引用）
await sharp(svg)
  .resize(256, 256)
  .png()
  .toFile(out256);
console.log(`✓ wrote ${out256}`);
```

- [ ] **Step 3: 运行脚本生成 PNG**

Run:
```bash
node scripts/build-icons.mjs
```

Expected:
```
✓ wrote ...\assets\icon.png
✓ wrote ...\assets\icon-256.png
```

- [ ] **Step 4: 验证生成的 PNG**

在文件管理器或浏览器中打开 `assets/icon.png`，确认图案清晰、颜色正确。

- [ ] **Step 5: Commit**

```bash
git add scripts/build-icons.mjs assets/icon.png assets/icon-256.png
git commit -m "build: 添加图标构建脚本并生成 PNG"
```

---

### Task 4: 更新 package.json——配置 icon 路径与构建脚本

**Files:**
- Modify: `package.json`

当前 `build` 块（第 34-64 行）中没有 `icon` 字段。需要：
1. 在 `build` 下添加 `"icon": "assets/icon"`，让 electron-builder 自动找到 `assets/icon.png`
2. 在 `scripts` 中添加 `"build:icons": "node scripts/build-icons.mjs"`
3. 在 `build:desktop` 前加入图标构建，保证打包前总是最新图标

- [ ] **Step 1: 在 build 块添加 icon 字段**

在 `package.json` 第 38 行 `"directories": {` 之前，加入 `"icon": "assets/icon",`：

```json
    "asar": true,
    "icon": "assets/icon",
    "directories": {
      "output": "release"
    },
```

electron-builder 会自动解析为 `assets/icon.png` 并生成 .ico/.icns。

- [ ] **Step 2: 添加 build:icons 脚本并挂到 build 链**

修改 `scripts` 段：

```json
    "build": "npm run build:icons && npm run build:cli && npm run build:desktop",
    "build:icons": "node scripts/build-icons.mjs",
    "build:cli": "tsup && node -e \"require('fs').cpSync('src/init/codeisland','dist/codeisland',{recursive:true})\"",
    "build:desktop": "npm run build:desktop:main && npm run build:desktop:renderer",
```

即：在 `build` 开头加上 `npm run build:icons &&`，并新增 `build:icons` 脚本行。其他脚本（`desktop:start`、`desktop:dist`、`desktop:pack`）已经依赖 `build`，所以会自动包含图标生成。

- [ ] **Step 3: 验证 package.json 合法**

Run:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).build.icon)"
```
Expected: 输出 `assets/icon`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(electron): 配置 electron-builder icon 路径并接入构建链"
```

---

### Task 5: 在 BrowserWindow 中设置运行时图标

**Files:**
- Modify: `src/desktop/main.ts`

`createWindow()` 函数中 BrowserWindow 构造选项当前没有 `icon` 字段（第 139-155 行），Windows 下会显示默认 Electron 图标。

- [ ] **Step 1: 确定图标路径**

在 `main.ts` 顶部已有 `moduleDirectory`，图标位于 `dist/` 同级的 `assets/` 目录？不，打包后图标会被 electron-builder 处理，运行时应该使用 `app.getAppPath()` 下的路径。但是在开发模式下，图标在项目根 `assets/icon.png`；打包后图标路径由 electron-builder 自动设置（它会把正确格式的图标放到 Electron 能自动发现的位置，`icon` 设置在开发模式下生效即可）。

最稳妥的方式：判断是否打包，打包后不手动设置 icon（让 Electron 使用嵌入的 exe 图标），开发时指向 `assets/icon.png`。但更简单的做法是直接设置 `icon` 为打包后的路径，electron-builder 会自动把 icon 放在 resources 下，并且 BrowserWindow 的 icon 选项在 Windows 上如果不设置就用 exe 自己的图标，设置了就用指定的。

实际上最简洁的做法：使用一个相对 app 路径的 PNG 路径，开发和打包都指向同一个位置。electron-builder 打包时不会把 `assets/` 带进 asar（看 files 配置只包含 dist/、README.md、技术方案报告.md、LICENSE）。

**方案：** 把 icon.png 复制到 dist 目录，并通过 `join(app.getAppPath(), "dist", "icon.png")` 引用。或者更简单：使用 `process.resourcesPath`？不。

最可靠的方案：**将 icon.png 复制到 dist 目录**，并在 BrowserWindow 中引用。

但为了避免增加构建步骤复杂度，更简单做法是：**在开发模式下用路径连接到项目 assets，在打包模式下不设置 icon（Electron 会自动使用 exe 图标）**。这是因为 electron-builder 设置了 `icon` 后，打包出的 exe 自带图标，任务栏/窗口会自动显示 exe 图标，不需要 BrowserWindow.icon。

- [ ] **Step 2: 修改 main.ts**

在 `main.ts` 的 `createWindow()` 函数中，构造 BrowserWindow 前加入 icon 判断，并修改 BrowserWindow 配置：

在第 137 行 `async function createWindow()` 内，`const rendererUrl = ...` 之后、`mainWindow = new BrowserWindow({` 之前加入：

```ts
const isPackaged = app.isPackaged;
const windowIcon = isPackaged ? undefined : join(moduleDirectory, "..", "..", "assets", "icon.png");
```

然后在 BrowserWindow 构造选项对象中的 `title: "Flavor Code",` 之后加入：

```ts
    icon: windowIcon,
```

具体修改：在 `src/desktop/main.ts` 找到 `mainWindow = new BrowserWindow({` 块（第 139-155 行），将第 140 行：

```ts
    title: "Flavor Code",
```

改为：

```ts
    title: "Flavor Code",
    icon: isPackaged ? undefined : join(moduleDirectory, "..", "..", "assets", "icon.png"),
```

并在 `const rendererUrl = ...`（第 138 行）之后添加 `isPackaged` 常量：

```ts
  const isPackaged = app.isPackaged;
```

（`join` 已经在文件顶部 import 了，无需额外 import。）

- [ ] **Step 3: 类型检查**

Run:
```bash
npm run typecheck
```
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/desktop/main.ts
git commit -m "feat(desktop): 开发模式下窗口使用自定义 icon.png"
```

---

### Task 6: 构建并启动桌面应用验证图标效果

**Files:** 无新文件修改。

- [ ] **Step 1: 构建桌面应用**

Run:
```bash
npm run desktop:pack
```

Expected: 构建成功，在 `release/` 目录生成 win-unpacked 目录。

如果 sharp 的原生模块对 Electron 版本有 ABI 不匹配问题：sharp 只在构建时（Node 环境）用，运行时不需要，所以不会有问题。

- [ ] **Step 2: 启动打包后的 exe 检查图标**

在文件管理器中找到 `release/win-unpacked/Flavor Code.exe`，确认：
1. exe 文件本身的图标是新设计的（蓝底+花括号眼+吐舌）
2. 双击启动后，窗口标题栏左上角图标是新图标
3. Windows 任务栏图标是新图标
4. Alt-Tab 切换时图标是新图标

- [ ] **Step 3: 启动开发模式验证**

Run:
```bash
npm run desktop:start
```

确认开发模式下窗口图标也正确显示。

- [ ] **Step 4: 清理备份文件**

Run:
```bash
rm assets/icon.svg.bak assets/icon-256.png.bak
```

- [ ] **Step 5: 最终 commit**

```bash
git add -A
git status  # 确认无意外文件
git commit -m "chore: 完成图标重设计验证" --allow-empty
```

---

### Task 7: 清理 .bak 文件（gitignore 可选）

这是可选优化：之前步骤里如果 .bak 文件被误提交，需要处理。但我们在 Task 6 已经删除，所以跳过。仅确保 `release/` 在 `.gitignore` 中。

- [ ] **Step 1: 检查 .gitignore**

Run:
```bash
cat .gitignore 2>/dev/null | grep -E "release|assets.*\.bak" || echo "需要检查"
```

如果 `release/` 不在 .gitignore 中，添加它。

- [ ] **Step 2: 如有必要更新 .gitignore**

添加：
```
release/
*.bak
```

---

## 自检清单

- [x] SVG 源文件包含：蓝底、白气泡+尾巴、花括号眼睛、张嘴、粉色吐舌
- [x] 图标路径在 electron-builder 中配置（`build.icon: "assets/icon"`）
- [x] BrowserWindow 开发模式下设置 icon 路径
- [x] 图标构建脚本 `build:icons` 接入 `build` 链，打包前自动生成最新 PNG
- [x] 生成 512px PNG 供 electron-builder 自动转 ICO/ICNS
- [x] 视觉重心相对原版向左上修正
