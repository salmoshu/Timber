# MarkText / Muya 内置源码说明

- 上游项目：[MarkText](https://github.com/marktext/marktext)
- 源码路径：`packages/muya`
- 包名与版本：`@muyajs/core` `0.2.0`
- 许可证：MIT，完整文本见同目录 `LICENSE`；字体等附随许可证保留在源码对应目录。
- 内置日期：2026-11-09
- 来源快照：用户提供的 `tmp/marktext` 工作区快照。该快照未包含可确认的 Git 提交元数据，因此不记录或推测上游 commit。

Timber 直接以源码形式内置 Muya，根项目通过 `file:./vendor/marktext-muya` 消费 `@muyajs/core`，不依赖预编译的 `lib` 产物。

## Timber 本地改动

- 包入口直接指向 TypeScript 源码，并显式导出 `markdownToState` 与 `ScrollPage`，供编辑器和导出管线复用。
- 移除 `@marktext/file-icons` 运行时依赖，代码语言选择使用纯文本标签。
- 增加 `resolveImageSrc` 显示地址钩子：编辑器内通过 Timber `/raw/` 地址加载图片，Markdown 仍只保存项目相对路径。
- 增加导出选项透传，修复 Front Matter 参数遗漏，并支持 Timber 便携 HTML 的 KaTeX 样式与字体内嵌。
- 补充源码导出的类型声明及 Prism 只读兼容修复。
- Prism 语言模块改为显式、按需加载映射，保持依赖顺序，并兼容 Vite 与 esbuild。
- 将编辑器选择相关样式限定在 `.mu-editor`，移除会污染 Timber 全局页面的 `html, body` 字体规则。
- 行内工具栏增加可选的宿主批注图标与回调，保留选区后交给 Timber 创建批注；批注与常规格式工具共用同一文本块的显示条件，跨段落不显示独立批注工具条。
- 任务清单使用方形勾选框，保留上游勾选、编辑与撤销逻辑。
- Timber 应用配色来自同一快照的 `packages/desktop/src/renderer/src/assets/themes` 及其 Prism 配色；已提取到 `src/renderer/src/utils/themePalettes.ts`，由 `scripts/import-marktext-themes.mjs` 重新生成，许可证同为 MIT。
- 字体与编辑器设置参考同一快照的 `prefComponents/common/fontTextBox` 与编辑器排版分组；字体列表经主进程读取本机字体，按用户指定的 MarkText 界面采用可搜索的单选下拉框，并保留旧字体回退偏好的兼容。字体栈解析与序列化适配到 `src/shared/fontFamilies.ts`。代码行号、缩进、分项配对与空行提示通过 Muya 选项实时生效。
- Open Sans 的常规、粗体、斜体及 DejaVu Sans Mono 字形继续使用本目录自带字体；Windows 字体枚举使用与 MarkText 相同的 WPF 字体列表，并隐藏辅助控制台。安装包保留 MarkText 及随附字体的许可证。

上游修改应优先回到本目录核对；升级 Muya 时需要重新检查以上适配，不能只替换文件后沿用旧测试结果。
