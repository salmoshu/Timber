# Timber 更新日志

## v0.8.0

- **Monaco 代码工作区**：非 Markdown 代码文件改用 Monaco 只读视图，支持语法高亮、代码折叠、括号匹配、Sticky Scroll、查找、主题与字体设置；编辑器按需加载，超大文件自动回退到轻量阅读器。
- **TypeScript / JavaScript 语义导航**：本地文件夹项目内置 TypeScript 语言服务，支持 TS、TSX、JS、JSX；语言服务器和标准库随安装包携带，无需额外安装 Node。
- **定义与引用**：F12 或 Ctrl/Cmd + 点击跳转到跨文件源码定义，Shift + F12 打开引用 Peek，Hover 展示类型与签名信息。
- **符号导航**：Ctrl/Cmd + Shift + O 打开当前文件符号大纲，Ctrl/Cmd + T 搜索工作区符号并直接定位。
- **跨文件历史**：Alt + ←/→ 在跳转位置间后退、前进；导航复用 Timber 标签系统并按项目隔离历史，保留光标与视图状态。
- **验证与降级**：代码导航通过真实 LSP、Monaco UI 及现有应用回归测试；当前代码文件保持只读，远程项目和其他语言暂以语法展示为主。
