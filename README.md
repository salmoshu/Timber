<p align="center">
  <img src="resources/logo.svg" alt="Timber" width="128" height="128">
</p>

# Timber

看清每一次提交如何塑造你的项目 —— Git 历史 × 架构图 × 代码阅读 × 文档渲染

<img src="docs/screenshot-main.png" alt="Timber 历史视图" width="880">

[![Release](https://img.shields.io/github/v/release/salmoshu/Timber?style=flat-square)](https://github.com/salmoshu/Timber/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue?style=flat-square)

## 为什么

AI 时代，代码越写越快，但「项目是怎么一步步长成这样的」越来越模糊。Timber 把项目的**时间维度**（Git 历史）和**空间维度**（架构）放到同一个视图里：每次提交改了什么、对架构产生了什么影响，一眼看清。年轮即历史——这是 Timber 名字的由来。

## 三个视图

左侧项目列表用于切换本地或远程工作区。通过标题栏下拉框切换资源、架构和历史。

- **资源** —— 文档与源码共用多标签阅读区。Markdown 支持 GFM、公式和离线图表，可直接编辑、划词添加笔记或标签；A4 分页预览与 PDF 共用分页结果，并可导出 Word、长图，图片拖拽调宽会同步到所有导出。Excel 工作簿支持只读表格与工作表切换。行首输入 `-` / `*` / `1.` / `#` 等标记加空格即时转为列表/标题，空列表项回车按 Typora / Obsidian 语义退出（嵌套先升父级）。源码支持语法高亮、行号与查找。文件树、最近打开与 Git 在右侧（文件名搜索框在文件页签内），树范围用过滤图标切换「仅文档 / 全部」，新建与重命名直接在树内完成。正文左缘是竖线目录，悬停或聚焦后按标题层级缩进展开。Mermaid 图卡按 GitHub 风格配色，点击可全屏缩放、平移查看。
- **架构** —— 以 [Archify](https://github.com/tt-a1i/archify) 静态分析结果作为初始图；右侧固定 AI 助手支持基于当前图调整、优化和问答。AI 更新通过渲染校验后覆盖项目的当前架构，重启后保留最新结果。另有 Git 版本对比、DSM 依赖矩阵、符号与循环依赖洞察。
- **历史** —— 按分支或标签浏览提交，按标题、作者或 SHA 搜索。选中提交后可复制完整 SHA、查看关联的 Entire 记录或架构对比，也可筛选变更文件、展开差异并逐块跳转。

在「设置 → AI」检测或登录 Kimi Code 和 Codex CLI，也可为各服务商配置默认模型和思考强度。Codex 还支持速度和沙箱权限。架构侧栏按项目保存多轮会话与草稿，可以按会话覆盖默认配置、切换问答或调整模式、查看执行步骤并停止或重试。远程项目使用对应机器上的 CLI。

## 安装

从发布页下载对应系统的安装包。 [GitHub Releases](https://github.com/salmoshu/Timber/releases)

| 系统 | 安装包 |
| --- | --- |
| Windows 10/11 x64 | `Timber-Setup-x.y.z.exe` |
| macOS Apple Silicon | `Timber-x.y.z-arm64.dmg` |
| macOS Intel | `Timber-x.y.z-x64.dmg` |

macOS 将 Timber 拖到「应用程序」，更新时下载新版 DMG 覆盖。Mac 安装包使用临时签名，首次打开可能需要在「系统设置 → 隐私与安全性」中批准。 [Apple 支持](https://support.apple.com/102445)

## C/C++ 代码阅读

Windows 和 macOS 版均内置 clangd。将源码目录作为本地项目导入，在「资源」中关闭「仅文档」，即可打开 C、C++、Objective-C/Objective-C++ 源码与头文件，也可以查看 CMake、Makefile、Meson、Ninja 和 MSBuild 构建文件。

| 操作 | 快捷键 |
| --- | --- |
| 跳到定义 | `F12` 或 `Ctrl/Cmd + 点击` |
| 查看引用并打开调用位置 | `Shift + F12`，双击引用条目 |
| 切换源文件与头文件 | `Alt + O` |
| 文件大纲 / 工作区符号 | `Ctrl/Cmd + Shift + O` / `Ctrl/Cmd + T` |
| 返回 / 前进 | `Alt + ←` / `Alt + →` |

clangd 使用编译数据库解析头文件搜索路径、宏和语言标准。把 `compile_commands.json` 放在项目根目录或 `build/` 下。CMake 项目可用 Ninja 或 Makefiles 生成器导出，MSVC 项目可从 Visual Studio 开发者终端使用 CMake + Ninja。 [CMake 编译数据库文档](https://cmake.org/cmake/help/latest/variable/CMAKE_EXPORT_COMPILE_COMMANDS.html)

```powershell
cmake -S . -B build -G Ninja -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

Meson 会在其构建目录生成数据库，Ninja 或 Make 项目也可用相应工具生成或导出。若构建目录为 `out/build/debug` 等自定义路径，在项目根目录的 `.clangd` 中指定它。尚未配置编译数据库的小型项目会在临时目录生成基础编译命令，支持常见的跨文件引用。 [clangd 项目配置](https://clangd.llvm.org/installation.html#project-setup)

```yaml
CompileFlags:
  CompilationDatabase: out/build/debug
```

MinGW 或交叉编译项目可以通过 `TIMBER_CLANGD_QUERY_DRIVER` 指定可查询的编译器绝对路径（多个路径用逗号分隔），或在编译参数中显式配置系统头文件目录。生成或更换数据库后，重新打开 Timber 可重新加载项目索引。 [clangd 编译器查询](https://clangd.llvm.org/design/compile-commands#query-driver)

## Markdown 写作

v0.7.0 将所见即所得编辑迁移到内置 MarkText/Muya 源码，保留 Timber 的目录、批注、自动保存与图片相对路径。源码模式使用 CodeMirror 5，继续提供智能续行、配对、快速插入、查找替换、专注 / 打字机 / 沉浸模式及字词统计。HTML、PDF、Word、长图和 A4 分页共用同一 Markdown 草稿。详见 [Markdown 写作指南](docs/markdown-writing.md)。

v0.7.1 增加 33 套应用配色、最近文件右键菜单、Ctrl+Y 重做和编辑历史恢复；阅读／源码与分页预览改为拨动开关，批注入口合并到 Muya 工具条。Windows 支持 Markdown 文件「打开方式 → Timber」，单文件专注于编辑、批注与导出，项目文件夹提供架构、历史与 Git。

v0.7.2 参考 MarkText 完善编辑器设置：正文与代码字体使用可搜索的下拉框，提供字形预览、内置离线字体、字号、行高、正文宽度，以及配对、行号与缩进设置。Markdown 任务使用方形勾选框；批注、阅读／源码及分页预览使用图标，批注与格式工具条共用选区显示条件。原有字体偏好与编辑状态保持兼容。

## 技术架构

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 桌面壳 | Electron 33 + electron-vite | 单实例、外链浮层、自动更新 |
| 前端 | React 18 + Zustand + Monaco + Muya + CodeMirror 5 | 三视图切换与源码导航；Muya 源码内置于 `vendor/marktext-muya`；可纯 Web 预览（`pnpm dev:web`） |
| 本地服务 | Go（timberd sidecar） | Git 历史提取、仓库静态分析（目录→组件、import→连接）、文档扫描/批注/搜索、WSL/SSH 远端接入 |
| 架构渲染 | [Archify](https://github.com/tt-a1i/archify)（vendor 于 `vendor/archify`，MIT） | JSON IR → 自包含交互 HTML；`architecture-delta` 计算两版本架构差异 |

数据流：sidecar 从 Git 提取提交与代码结构 → 主进程调用 archify 渲染/比对 → 渲染层以 iframe 呈现交互架构图。

## 开发

```bash
pnpm install        # 安装依赖并准备 Electron 原生运行时
pnpm dev            # Electron 开发模式
pnpm dev:web        # 纯 Web 预览（需先手动启动 sidecar）
pnpm build          # 构建
pnpm dist           # 在 Windows 上打包 NSIS，在 macOS 上打包当前架构的 DMG
```

首次构建代码工具时下载并校验 clangd，后续构建使用本地缓存。使用 Node.js 22 和 Go 1.23 构建。推送与 `package.json` 一致的 `vX.Y.Z` 标签后，GitHub Actions 会在 Windows x64、macOS arm64 和 macOS x64 上构建、验证并发布安装包。

## 许可

Timber 本体按 MIT 许可证开源，完整声明见根目录 `LICENSE`。在保留原作者版权及许可声明的前提下，可自由使用、复制、修改、发布、分发、再许可及销售软件副本；软件按“原样”提供，不附带任何明示或默示担保。

内置第三方组件沿用各自许可证：架构图渲染基于 MIT 许可的 [Archify](https://github.com/tt-a1i/archify)（见 `vendor/archify/LICENSE` 与 `THIRD_PARTY_NOTICES.md`）；Markdown 引擎来自 MIT 许可的 [MarkText/Muya](https://github.com/marktext/marktext)，许可证、来源与本地改动见 `vendor/marktext-muya/LICENSE` 和 `UPSTREAM.md`。

clangd 与随附的 Clang 头文件采用 Apache-2.0 with LLVM Exceptions。许可文件位于 Windows 的 `resources/sidecar/clangd/LICENSE.TXT` 或 macOS 的 `Timber.app/Contents/Resources/sidecar/clangd/LICENSE.TXT`。 [clangd 上游发布页](https://github.com/clangd/clangd/releases/tag/22.1.6)
