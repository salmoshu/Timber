<p align="center">
  <img src="resources/logo.svg" alt="Timber" width="128" height="128">
</p>

# Timber

看清每一次提交如何塑造你的项目 —— Git 历史 × 架构图 × 代码阅读 × 文档渲染

<img src="docs/screenshot-main.png" alt="Timber 历史视图" width="880">

[![Release](https://img.shields.io/github/v/release/salmoshu/Timber?style=flat-square)](https://github.com/salmoshu/Timber/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)

## 为什么

AI 时代，代码越写越快，但「项目是怎么一步步长成这样的」越来越模糊。Timber 把项目的**时间维度**（Git 历史）和**空间维度**（架构）放到同一个视图里：每次提交改了什么、对架构产生了什么影响，一眼看清。年轮即历史——这是 Timber 名字的由来。

## 三个视图

左侧项目列表贯穿全部视图，启动时默认展开，可随时确认当前项目并切换本地或远程工作区。

- **资源** —— 文档与源码共用多标签阅读区。Markdown 支持 GFM、公式和离线图表，可直接编辑、划词标注和导出 PDF，批注默认收起；源码支持语法高亮、行号与查找。文件树、搜索与 Git 在右侧，新建与重命名直接在树内完成。正文左缘是竖线目录，悬停或聚焦后按标题层级缩进展开。Mermaid 图卡按 GitHub 风格配色，点击可全屏缩放、平移查看。
- **架构** —— 以 [Archify](https://github.com/tt-a1i/archify) 静态分析结果作为初始图；右侧固定 AI 助手支持基于当前图调整、优化和问答。AI 更新通过渲染校验后覆盖项目的当前架构，重启后保留最新结果。另有 Git 版本对比、DSM 依赖矩阵、符号与循环依赖洞察。
- **历史** —— Git 及关联 Entire 记录位于右侧栏，中间呈现提交说明、架构影响和文件 diff；可直接跳转架构对比或资源阅读，右侧栏支持显隐与拖拽调宽。

AI 助手二选一后端：在 设置 → AI 配置 OpenAI 兼容接口（API 地址 / 密钥 / 模型，支持 OpenAI、DeepSeek、Moonshot、智谱、本地 Ollama 等，可一键测试连接），或使用项目所在机器安装并登录的 Kimi / Codex CLI（优先 Kimi）。接口模式自动附带源码静态分析产出的项目结构作为上下文；CLI 模式只读项目。架构结果保存在本机应用数据中，远程项目沿用对应远端 sidecar 的 AI 能力。

## 安装

从 [Releases](https://github.com/salmoshu/Timber/releases) 下载最新 `Timber-Setup-x.y.z.exe`（Windows 10/11 x64）。

> 安装包未做代码签名，首次运行 Windows SmartScreen 可能提示，点击"更多信息 → 仍要运行"即可。

## 技术架构

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 桌面壳 | Electron 33 + electron-vite | 单实例、外链浮层、自动更新 |
| 前端 | React 18 + Zustand + Vditor | 三视图切换；可纯 Web 预览（`pnpm dev:web`） |
| 本地服务 | Go（timberd sidecar） | Git 历史提取、仓库静态分析（目录→组件、import→连接）、文档扫描/批注/搜索、WSL/SSH 远端接入 |
| 架构渲染 | [Archify](https://github.com/tt-a1i/archify)（vendor 于 `vendor/archify`，MIT） | JSON IR → 自包含交互 HTML；`architecture-delta` 计算两版本架构差异 |

数据流：sidecar 从 Git 提取提交与代码结构 → 主进程调用 archify 渲染/比对 → 渲染层以 iframe 呈现交互架构图。

## 开发

```bash
pnpm install        # 安装依赖（含 sidecar 构建与 vditor 离线库注入）
pnpm dev            # Electron 开发模式
pnpm dev:web        # 纯 Web 预览（需先手动启动 sidecar）
pnpm build          # 构建
pnpm dist           # 打包 NSIS 安装包
```

## 许可

MIT。架构图渲染基于 MIT 许可的 [Archify](https://github.com/tt-a1i/archify)（见 `vendor/archify/LICENSE` 与 `THIRD_PARTY_NOTICES.md`）。
