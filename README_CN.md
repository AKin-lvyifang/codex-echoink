<p align="center">
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/latest">
    <img width="1024" alt="EchoInk Agent 2.3.2 发布图" src="assets/releases/echoink-agent-2.3.2-release.png">
  </a>
</p>

<h1 align="center">EchoInk Agent</h1>

<p align="center">管理你的 Obsidian 知识，也在每次使用中更懂你。</p>

<p align="center">
  <a href="#232-亮点">2.3.2 亮点</a> ·
  <a href="#主要功能">主要功能</a> ·
  <a href="#安装">安装</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#把图片文档和笔记加入对话">对话附件</a> ·
  <a href="#隐私与数据">隐私与数据</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/latest">
    <img src="https://img.shields.io/badge/platform-Obsidian_Desktop-7C3AED?style=flat-square&logo=obsidian&logoColor=white" alt="平台：Obsidian 桌面端">
    <img src="https://img.shields.io/badge/version-2.3.2-0EA5E9?style=flat-square" alt="版本 2.3.2">
    <img src="https://img.shields.io/badge/license-MIT-10B981?style=flat-square" alt="MIT 开源许可证">
  </a>
</p>

<p align="center">
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/tag/2.3.2"><strong>下载 2.3.2</strong></a>
</p>

EchoInk Agent 是一个运行在 Obsidian 中的个人知识 Agent。它能持续对话，整理和维护当前 Vault，把长期有用的信息保存为可查看、可修正的记忆，并随着使用逐渐形成自己的工作方式。无需安装 Codex CLI；连接一个支持的模型服务后即可开始使用。

## 2.3.2 亮点

包体更轻，下拉选择更顺手。

- **主文件减少约 46.4%：** 从 2.3.1 的约 9.27 MB 降至约 4.97 MB（4.74 MiB），低于 500 万字节。PDF 阅读、图片处理、完整中文拼音搜索及已有模型能力继续保留。
- **点击空白即可取消：** 设置页下拉和聊天模型、参数菜单支持点击外部收起；悬停只高亮，点击选项才确认，取消时保留原选择。独立窗口也适用。
- **模型品牌更好认：** “EchoInk 当前模型”的已选项和下拉列表显示与 Provider 页一致的品牌图标。

查看 [2.3.2 更新介绍与用法](https://github.com/AKin-lvyifang/codex-echoink/releases/tag/2.3.2)。升级无需重新初始化仓库或重设模型。头图为功能示意。

## 主要功能

### 持久会话与清楚的对话过程

- 支持新建、重命名、归档、恢复和软删除会话；读取本地历史不依赖 Provider。
- 模型思考、工具过程、授权请求、任务计划、文件变化和最终回答显示在同一条时间线中。
- 思考过程可实时展开。手动上滚后不会被强制拉到底部，回到底部时会恢复跟随。
- 从输入区 `+` 打开 **计划模式**，让复杂任务先列出步骤；工具需要权限时，可直接在对话中批准或拒绝。
- 已归档会话在 **设置 → EchoInk Agent → 复盘 → 已归档会话** 中管理。

### Agent 身份与长期成长

- 新版五步引导会带你找到 Agent 画像入口，可在基础设置中选择风格、名称和头像。名称最多 24 个字符；头像可使用 15 个内置选项或自定义 SVG。
- 长期记忆默认开启。Agent 可以在普通对话中新增或更新值得长期保留的信息，不需要每次手动要求“记住”。
- **离线记忆整理（做梦）** 默认每天运行 3 次，可设为 1–6 次。它会连接相关经历，并逐步更新 Agent 画像、用户画像和长期相处习惯。
- 在 **设置 → EchoInk Agent → 基础设置 → 长期记忆 / 身份与用户画像** 中查看画像、调整频率或更换起始风格。修改名称和头像不会重置人格或记忆。
- 关闭离线整理后，普通的记忆写入和召回仍然可用；关闭长期记忆后，名称、头像和基础风格仍会保留。

### 图片、文档与笔记背景

- 粘贴或拖入图片，或者从输入区 `+` 添加图片和文件。
- 支持 PNG、JPEG、GIF、WebP；BMP、HEIC、HEIF、SVG 会在可转换时转成 PNG。当前模型不支持图片时，发送前会明确提示。
- 支持 PDF、DOC、DOCX、Markdown 和 HTML。每轮最多 8 个文档，单文件不超过 20 MiB，合计不超过 50 MiB。
- 加密、损坏或超出当前模型剩余上下文的文档会被拒绝，不会静默丢失内容。扫描版 PDF 暂不支持 OCR。
- 输入 `@` 可按文件名、路径、别名、拼音或首字母搜索当前 Vault 的 Markdown 笔记。
- 发送后的图片和文档会保留为缩略图或文件卡片，并可从对话中打开原文件。

### Provider 与模型

- 内置 OpenAI Codex Beta、通义千问、通义千问 Token Plan、智谱开放平台、Kimi 中国版、MiniMax 中国版、DeepSeek、Ollama 本地和 Custom 入口。
- 支持 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages 协议。
- 同一种 Provider 可以保存多个实例；每个实例可以启用多个模型、选择默认模型、获取模型列表或手动添加 Model ID。
- 深度思考选项会按当前模型的实际能力显示，避免把不支持的参数发送给 Provider。
- 普通 Provider 的 API Key 与 OpenAI Codex Beta 的登录凭据保存在当前 Vault 的插件设置中；Ollama 本地入口默认不需要 API Key。

### Vault 知识维护

- `/ask` 优先围绕当前知识库回答，并显示本轮使用的知识来源。
- `/maintain` 提炼 Raw 笔记，把可复用内容写入 Wiki 或 Projects，再回读确认结果。
- 维护开始前会锁定目标版本；生成期间笔记发生变化时，本轮不会覆盖新内容。
- 是否写入由工作区读写设置和你的要求决定，`/ask` 与 `/maintain` 不授予或收回文件权限；普通对话也可以按你的明确要求保存日记。
- 初始化可选默认方案，将现有资料整理到 Raw；也可选自定义方案，先查看并调整笔记分配。点击“开始初始化”后才执行整理。缺少固定目录时可以只补目录，不移动、删除或重写已有笔记。

### 可查看、可修正的长期记忆

- 当前记忆按事实、观点、决定、进行中和经历五类展示，每条记录包含标题、内容和“何时可能想起”。
- 修正时会同时保留原记忆、你的纠正说明和修正后预览。生成预览不会改动原记录，只有点击保存才会创建新版本。
- 停止、关闭、生成失败、迟到结果或版本冲突都不会覆盖当前记忆。

### 复盘、Skills 与 MCP

- 手动生成 Agent 周报或知识库周报，可选择上一完整周或本周至今、Vault 内输出目录，以及生成后是否打开 HTML。
- 在设置中管理当前 Vault 可用的插件资源、Skills 与 MCP 连接。
- 只读 MCP 工具通过当前对话执行，并遵循各连接的启用和信任设置。
- 在编辑器中选中文本后，可通过右键菜单使用当前默认 Provider 翻译成英文。

## 安装

### Obsidian 社区插件

如果 EchoInk Agent 已出现在 Obsidian 社区插件目录中：

1. 打开 **设置 → 第三方插件 → 浏览**。
2. 搜索 `EchoInk Agent`。
3. 安装并启用插件。

### 手动安装

1. 从 [2.3.2 Release](https://github.com/AKin-lvyifang/codex-echoink/releases/tag/2.3.2) 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 在 Vault 中创建目录：

```text
<vault>/.obsidian/plugins/codex-echoink/
```

3. 将三个文件放入该目录。
4. 重启 Obsidian，在第三方插件中启用 `EchoInk Agent`。

> **同步说明：** 2.3.2 的 `main.js` 约为 4.74 MiB，已低于 Obsidian Sync Standard 的 5 MiB 单文件上限。是否同步插件仍取决于你的同步设置。

## 快速开始

首次使用时，五步引导会带你找到下面这些入口；可以返回、跳步或随时退出：

1. 点击 Obsidian 左侧栏的羽毛图标，打开首页和 EchoInk Agent 侧栏。
2. 点击 EchoInk 侧栏右上角的齿轮，进入设置。
3. 在 **API Provider** 中连接一个模型服务。
4. 在 **知识库管理** 中选择默认或自定义方案；自定义方案可先调整笔记分配，再点击“开始初始化”。
5. 在 **基础设置** 中选择 Agent 的起始风格、名称和头像。

完成后即可新建会话。普通会话第一次发送前，需要用输入区的文件夹按钮选择一个本机工作区。输入 `/ask` 查询知识库，输入 `/maintain` 提炼笔记；需要图片、文档、笔记背景或计划模式时，使用输入区 `+` 或 `@`。

## 把图片、文档和笔记加入对话

| 操作 | 结果 |
| --- | --- |
| 粘贴或拖入图片 | 把图片加入当前输入 |
| `+ → 添加图片` | 从本机选择图片 |
| `+ → 文件和文件夹` | 从本机选择一个或多个受支持文件；当前版本不读取整个文件夹 |
| `+ → 添加当前笔记` | 加入编辑器中当前打开的 Markdown 笔记 |
| 输入 `@` | 搜索并加入当前 Vault 的 Markdown 笔记 |
| `+ → 计划模式` | 让复杂任务先显示任务计划 |

附件只属于当前发送内容。发送前移除卡片即可取消；处理失败时整轮会停下并显示原因，不会偷偷发送残缺内容。

## 配置 Provider 与模型

打开 **设置 → EchoInk Agent → API Provider → 添加模型**：

- 使用 API Key 时，选择对应 Provider，填写 API URL、API Key，获取或添加模型，勾选需要启用的模型并指定默认模型。
- 使用 **OpenAI Codex Beta** 时，进入 **登录账户** 分组，选择该入口并点击 **使用 OpenAI 登录**。浏览器没有自动返回时，把回调地址或授权码粘贴回设置弹窗，然后点击 **完成授权**。
- 通义千问普通 API 与通义千问 Token Plan 是两个独立入口，请按自己的账号方式选择。
- 需要退出 OpenAI Codex Beta 时，在同一 Provider 弹窗中点击 **退出登录**。

## 知识维护

`/maintain` 有三种定位方式：

| 输入方式 | 作用范围 |
| --- | --- |
| `/maintain` | 全局检查当前可维护的 Raw 笔记 |
| 在输入区选择一篇 `raw/**.md`，再执行 `/maintain` | 只维护这篇 Raw 笔记 |
| `/maintain 笔记名称` | 模糊搜索相关 Raw 笔记，并在候选范围内维护 |

单篇模式一次只接受一篇当前 Vault 内的 Raw Markdown。名称没有可靠匹配时不会自动回退到全局维护。已经提炼且没有新变化的内容会正常结束，不会重复写入。

## 复盘与记忆修正

进入 **设置 → EchoInk Agent → 复盘**：

- 在“生成周报”中选择统计周期、输出文件夹和生成后是否打开 HTML。
- 在“已归档会话”中搜索、恢复或软删除会话；原始会话记录仍会保留。
- 在“记忆修正”中按类别查看记录，生成修正后预览，再决定是否保存。

## 升级说明

### 从 2.1.0 或 2.0.3 升级

- 可直接覆盖升级，无需重建会话、知识库或长期记忆；已保存的 Provider 与模型配置会自动升级。
- 2.3.2 不会改写旧会话中已经保存的内容。如果某个旧会话已经留下重复回答或失败记录，升级后建议新建会话继续。
- 已完成引导的旧用户不一定会在升级后再次看到引导；需要重看时，在 Obsidian 社区插件中禁用再启用 EchoInk，完成页也支持“再看一遍”。

### 从 1.x 升级

- 2.x 直接保存 Provider API Key。如果旧配置只有已退役的 Credential 引用，需要在 Provider 设置中重新输入一次 API Key。
- 2.x 不读取或迁移已退役的 Codex、OpenCode、Hermes 会话，以及旧 Cognitive、Reflection 或 Memory 数据，也不会主动删除这些旧文件。
- 建议升级前按自己的 Vault 备份习惯保留一份快照。

## 隐私与数据

- EchoInk 仅支持桌面端，并通过 Obsidian API 访问当前 Vault。
- 会话、知识文件、记忆和周报保存在本地 Vault 中。
- API Key、Provider 配置与 OpenAI Codex Beta 登录凭据保存在当前 Vault 的插件设置中。请只在可信设备和可信 Vault 中配置。
- 你为会话选择的本机工作区可以位于 Vault 外。输入区的文件权限可设为“只读”“工作区可写”或“完全访问权限”；完全访问会解除工作区文件边界，只应在可信任务中使用。EchoInk 还会读取你明确选择、拖入或粘贴的 Vault 外附件。
- 远程 Provider 会接收完成当前请求所需的 Prompt、会话、知识、记忆、笔记、附件和工具结果；EchoInk 不会默认上传整个 Vault 或整个工作区。
- Custom Provider 与 MCP 连接还受对应服务、服务器和命令的条款约束。只配置你信任的服务和本机命令。
- EchoInk 没有自己的遥测服务。

## 使用要求

- Obsidian Desktop 1.11.4 或更高版本。
- 云端 Provider 需要自己的 API Key 或账号，并可能产生 Provider 费用。
- 图片输入需要当前模型支持视觉能力。
- 当前不支持 Obsidian Mobile。
- Node.js 只用于本地开发，不是普通安装的前置条件。

## 本地开发

推荐使用 Node.js 22.19.0 或更高版本：

```bash
npm install
npm run test
npm run typecheck
npm run build
```

生成本地手动安装包：

```bash
npm run package
```

## 许可证

EchoInk 使用 [MIT License](LICENSE) 开源，第三方组件署名见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
