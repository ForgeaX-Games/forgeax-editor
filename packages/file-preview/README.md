# `@forgeax/editor-file-preview`

> forgeax editor 文件预览 — 一个「按文件类型注册预览渲染器」的注册表 + `<FilePreview>` 宿主组件。内置 shiki 代码高亮、图片 / 音频 / 视频 / 字体预览，并对外开放注册接口，供插件为自定义声明类型贡献预览表现。

## 心智模型

预览不是一堆 `if (family === 'image')` 的硬编码分支，而是一个**开放注册表**：

- 每个 `FilePreviewRenderer` 声明 `match(input)`（按 ext / mime / family 判定是否接管）+ `component`（真正渲染的 React 组件）+ 可选 `priority`。
- `<FilePreview input={...} />` 宿主按 `resolveFilePreviewRenderer` 选出「优先级最高、后注册者胜」的渲染器；无人接管则退回通用兜底（文本 → `<pre>`，二进制 → 提示）。
- 内置渲染器在包 import 时注册（`register-builtins`，`sideEffects` 保留）；插件在激活时调用 `registerFilePreviewRenderer` 贡献或以更高 `priority` 覆盖内置。

这套注册表范式对齐 editor 既有的 `registerBespokeEditor`（Inspector bespoke 编辑器）与 `registerEditorPreviewViewports`（3D 视口预览）。

## 用法

```ts
import { FilePreview, registerFilePreviewRenderer } from '@forgeax/editor-file-preview';

// 宿主渲染
<FilePreview input={{ path, name, family, ext, mime, size, content, rawUrl }} />;

// 插件注册自定义声明类型（更高 priority 覆盖内置）
registerFilePreviewRenderer({
  id: 'my-plugin:dialogue-graph',
  priority: 100,
  match: (i) => i.ext === 'dlg',
  component: DialogueGraphPreview,
});
```

## 内置渲染器

| id | 接管 | 表现 |
|---|---|---|
| `builtin:code` | 有文本内容且扩展名可识别语言 | shiki 高亮（懒加载、暗色主题、大文件退回纯文本） |
| `builtin:image` | `image/*` mime 或 image family | `<img>` |
| `builtin:audio` | `audio/*` mime 或 audio family | `<audio controls>` |
| `builtin:video` | `video/*` mime 或视频扩展名 | `<video controls>` |
| `builtin:font` | 字体扩展名或 font family | FontFace 实字样张 |

## 代码高亮

- 引擎用 shiki 的 **JavaScript 正则引擎**（无 WASM），核心高亮器 + 主题 + 语法均**动态 `import()` 懒加载**，不进宿主初始包。
- 性能护栏：内容 > 200KB 或 > 5000 行时跳过高亮，退回纯文本 `<pre>` 并提示（见 `code-preview-policy`）。

## known limitations

- 语言映射为白名单（`ext-language`）：未收录扩展名的文本按纯文本 `<pre>` 展示，不报错。
- Markdown 目前按源码高亮，不做富文本渲染（留作后续或插件贡献）。

## troubleshooting

- 高亮不生效：确认 `input.content` 非空（服务端仅对文本文件返回内容）且扩展名在 `ext-language` 白名单内。
- 想覆盖内置表现：注册同类 `match` 且 `priority` 更高的渲染器即可。
