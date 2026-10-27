<p align="center">
  <a href="https://echoink.cn">
    <img width="1024" alt="EchoInk 2.8.1：从资料生成与手机平板新工作台" src="assets/releases/echoink-agent-2.8.1-release.png">
  </a>
</p>

<h1 align="center">EchoInk Agent</h1>

<p align="center">你的笔记，有了 AI 搭档。住在 Obsidian 里。</p>

<p align="center">
  <a href="https://echoink.cn">官方网站</a> ·
  <a href="https://echoink.cn/install">下载与安装</a> ·
  <a href="#281-更新">2.8.1 更新</a> ·
  <a href="#隐私与数据">隐私与数据</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Desktop%20%2B%20Mobile%20Beta-7C3AED?style=flat-square" alt="桌面端与移动端 Beta">
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/tag/2.8.1"><img src="https://img.shields.io/badge/version-2.8.1-0EA5E9?style=flat-square" alt="版本 2.8.1"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT%20base%20%2B%20Commercial%20PRO-475569?style=flat-square" alt="MIT 基础版 + 商业许可 PRO，范围见 LICENSE"></a>
</p>

<p align="center"><a href="https://echoink.cn"><strong>访问官网 echoink.cn</strong></a></p>

EchoInk 是住在 Obsidian 里的个人知识 Agent。和笔记对话、整理知识、保留可查看和修正的长期记忆，也记录自己的日常。笔记留在你的 Vault，AI 功能连接你自己的模型服务；正常安装无需 Codex CLI。

## 2.8.1 更新

**从资料生成与手机平板新工作台。** 桌面端可从选定笔记生成报告与 Canvas 思维导图，使用内置或自己的模板，并从结果回到来源笔记。

**全新工作台与多 Agent 任务。** 桌面首页集中展示等你回应、正在进行和已完成的事项。待办、资料和 PDF 等提醒可以直接带着相关内容交给 Agent。

- 创建不同的 Agent，分别配置身份、模型和可用能力；从各自的任务列表查看进度、处理审批和继续对话。
- 中断任务保留原因与最后阶段，点击“从这里继续”前会核对操作和文件变化；结果不确定时先提示核对。任务不会在退出 Obsidian 后继续运行或自动重跑。
- 日记、待办、财务、知识库、英文日记和 PDF 各有模块页面。按日期编辑日记、关联项目待办，浏览知识目录，回看英文稿、PDF 原件和处理成果。
- 设置重组为“通用、模型、Agent、能力、模块、账号与会员”六个标签，同步更新新手引导。Agent、个人画像、记忆与模块目录都有集中入口。
- 知识召回增加正文、章节与引用定位，记忆更贴近当前问题和明确提及的项目；知识检索排除私有记忆与插件内部数据。重要信息仍需核对来源。
- 自定义知识目录、目录图谱、选文提问与标注，以及回答存为笔记，让阅读和整理可以接着对话进行。英文日记改善原生编辑、表达复习与首页每日表达。

极简黑白外观免费，荧光笔记和黄白宣言需要有效 PRO。配套主题另行提供，请从[官网配套主题页](https://echoink.cn/theme)下载并安装到 Obsidian。

财务、英文日记和 PDF 精读需要有效 PRO，**PRO 不包含模型调用额度**。活动与订阅说明以[官网](https://echoink.cn/plans)为准。完整更新与使用方法见 [CHANGELOG](CHANGELOG.md)。

## 下载与说明

前往 [echoink.cn](https://echoink.cn) 查看[安装方法](https://echoink.cn/install)、[功能介绍](https://echoink.cn/features)和[帮助与支持](https://echoink.cn/support)。仓库的 [Releases](https://github.com/AKin-lvyifang/codex-echoink/releases) 继续提供官方插件文件。

需要 **Obsidian 1.11.4 及以上**。**升级前请完整备份 Vault、插件设置和数据。** 手动升级时，只替换官方 `main.js`、`manifest.json` 和 `styles.css`，保留原有设置和数据文件，再重新启用插件。如需回退，请将升级前的完整备份与匹配的旧版插件一起恢复，不能只替换旧插件文件降级。

移动 Beta 新增分别为 iPhone、iPad 设计的工作台、多 Agent 任务、六组设置和日记、待办、财务、知识库、英文日记页面；中断任务由你确认后继续，“交给”只准备内容。资料生成、生成模板设置与 PDF 精读仅在电脑端提供，任务不会跨设备同步。附件、CLI 和桌面后台知识任务尚未接通；Skills 只使用移动端已有工具，MCP 暂只保存配置。iPhone、Android 与部分 iPad 原生流程，以及 Windows、Linux 原生环境的验证仍未完成。

插件文件超过 Obsidian Sync Standard 的单文件 5 MB 限制。请在各设备上通过官方下载或社区插件分别安装、更新，不要依赖 Sync Standard 传输该文件。

## 隐私与数据

- 对话、笔记、知识、记忆、日记和财务记录保存在本地；插件不会默认上传整个 Vault。
- **https://echoink.cn** 提供注册、登录、邮箱验证、兑换、订阅与设备授权服务，接收完成这些请求所需的账号资料和授权数据，包括生成的设备标识。PRO 插件需要 EchoInk 账号与有效权益；普通对话和知识库无需 EchoInk 账号。
- 工作台签到是联网账号操作。已登录时打开工作台会查询该账号在本地日期的签到状态；只有手动下拉晴天娃娃或按 ↓ 才提交签到，通过现有登录凭据将账号身份、本地日期和时区发送到 **https://echoink.cn**。签到跟随服务端账号保存，插件仅在内存缓存结果。不自动签到，不上传 Agent 使用天数、笔记或对话内容。
- 桌面端的账号会话和设备授权加密保存在 Vault 外的 **`~/.echoink/membership/`**。同一设备的授权由系统安全存储保护，各 Vault 的账号会话分别由 Obsidian 安全存储保护；安全存储不可用时无法完成持久设备授权，已有凭据会保留。
- 移动端的账号会话和授权使用当前 Vault 的 Obsidian 安全存储，不写入普通插件设置。移动端按笔记库的客户端实例激活，同一设备上的不同库可能占用不同名额，可在设备管理中解绑不再使用的实例。安全存储不可用时仅保留本次会话状态。
- Provider API Key 与 OpenAI Codex Beta 登录凭据保存在当前 Vault 的插件设置中，请在可信设备和 Vault 中配置。
- 你选择的模型服务会接收当前 AI 请求所需的提示词、笔记、附件、记忆和工具结果。模型服务可能要求独立账号并另行收费；图片输入需要支持视觉的模型。
- 桌面对话可以选择 Vault 外的本地工作区。文件访问遵循所选权限；“完全访问”会解除工作区边界。Vault 外附件仅在你明确选择、拖入或粘贴时读取。
- Tavily 联网搜索默认关闭。开启后，搜索词发送至 `api.tavily.com`，返回的摘要与链接交给当前模型。Tavily 需要单独账号和 Key；连接测试也会执行一次 basic 搜索并消耗 1 credit，详见[官方计费说明](https://docs.tavily.com/documentation/api-credits)。
- 知识检索排除“私有记忆”和插件内部数据目录；这不构成对所有文件工具或第三方服务的全局访问限制。
- PDF 本地文字提取在设备上进行；使用 MinerU 增强解析时，PDF 会发送给 MinerU，需要独立凭据与第三方额度，留存政策由该服务决定。生成精读或译文所需的提取内容会交给所选模型。
- 收藏链接使用插件内置抓取，访问你主动提交的页面。
- 自定义 Provider 与 MCP 会访问你配置的服务或本机命令。本地 MCP 进程使用当前用户的系统权限，并继承应用环境；插件内的工具确认不会将该进程限制在工作区内。
- 插件不采集客户端使用遥测；官网与账号服务的数据处理见[隐私政策](https://echoink.cn/support#privacy)。

## 许可声明

EchoInk 按组件分别授权：基础部分采用标准的 [MIT 开源许可](licenses/MIT.txt)；财务、英文日记、会员与激活服务，以及 [LICENSE](LICENSE) 列明的其他 PRO 文件，采用 [EchoInk PRO 商业许可](licenses/PRO-LICENSE.txt)。整个插件包并非全部采用 MIT，也不能整体称为 OSI 开源软件。两套许可分别约束对应内容，不是对整套产品任选其一。

MIT 基础部分允许修改、再分发和商用。PRO 源码允许个人、非商业阅读与学习；持有有效 PRO 权益的用户，可以正常使用未经修改的官方发行版处理个人事务、工作和企业内部业务，但不得绕过激活，也不因此获得修改、分发 PRO 代码或将其用于其他商业产品的权利。这些用途须另行取得书面授权。订阅或激活码授予的是产品使用权，不是源码转售权。

两部分由同一个官方插件包提供，激活无需再次安装。此前的 MIT 授权和第三方许可继续有效。你的笔记及独立创作的成果，不会仅因使用 EchoInk 而自动受到 PRO 许可约束。完整范围、素材例外与既有权利见 [LICENSE](LICENSE)，第三方材料见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
