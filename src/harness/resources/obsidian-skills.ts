import type { BuiltinSkillDefinition } from "./builtin-skills";
import license from "../../../third-party/obsidian-skills/LICENSE.md";
import markdown from "../../../third-party/obsidian-skills/skills/obsidian-markdown/SKILL.md";
import callouts from "../../../third-party/obsidian-skills/skills/obsidian-markdown/references/CALLOUTS.md";
import embeds from "../../../third-party/obsidian-skills/skills/obsidian-markdown/references/EMBEDS.md";
import properties from "../../../third-party/obsidian-skills/skills/obsidian-markdown/references/PROPERTIES.md";
import bases from "../../../third-party/obsidian-skills/skills/obsidian-bases/SKILL.md";
import functions from "../../../third-party/obsidian-skills/skills/obsidian-bases/references/FUNCTIONS_REFERENCE.md";
import canvas from "../../../third-party/obsidian-skills/skills/json-canvas/SKILL.md";
import examples from "../../../third-party/obsidian-skills/skills/json-canvas/references/EXAMPLES.md";

export const OBSIDIAN_SKILLS_SOURCE = Object.freeze({
  repository: "https://github.com/kepano/obsidian-skills",
  commit: "a1dc48e68138490d522c04cbf5822214c6eb1202",
  license: "MIT"
});

const MANAGED_TOOLS = `## EchoInk 工具

使用当前已注册的工具。查找用 vault_search，读取用 note_read；创建用 note_create，更新用 note_update 并带上刚读取的 expectedVersion。这些工具支持 Vault 内 .md、.base、.canvas 文本文件，创建与更新沿用写入确认、版本检查和写后回读。文件内容过长或读取截断时不覆盖。

## 边界

工作区选项决定读写权限。Skill 只提供流程和格式知识，不授予写入权限。没有终端、bash、任意 JavaScript 或 DOM 工具；已批准的官方插件管理只通过 obsidian_cli 执行并遵守确认与权限；下文公式、Mermaid 和 JSON 是文档内容。只有实际执行并回读成功才报告保存；未在 Obsidian 界面检查时不声称视觉渲染已验证。`;

function reference(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "")
    .replace(/\[([^\]]+)\]\(references\/[^)]+\)/gu, "$1（已附在本 Skill 下文）").trim();
}

function adapted(id: BuiltinSkillDefinition["id"], title: string, description: string, body: string): BuiltinSkillDefinition {
  return Object.freeze({
    id, title, description,
    body: [
      "## 用途与触发", description,
      `来源：${OBSIDIAN_SKILLS_SOURCE.repository}；固定版本 ${OBSIDIAN_SKILLS_SOURCE.commit}；MIT。EchoInk 适配了工具调用，格式参考保留上游内容。`,
      MANAGED_TOOLS, body, "## 上游许可证", license.trim()
    ].join("\n\n")
  });
}

export const OBSIDIAN_BUILTIN_SKILLS: readonly BuiltinSkillDefinition[] = Object.freeze([
  adapted("obsidian-cli", "Obsidian CLI", "在当前 Vault 查找与读取资料、打开标签页与 Base、保存原生日记、查看或恢复本地历史、搜索与管理插件时启用；自然语言和 /obsidian-cli 使用同一能力。", `## 官方 CLI 与当前 Vault

obsidian_cli 使用官方公开 CLI 二进制，通过异步参数数组调用，运行目录固定当前 Vault，并用官方 vault 路径信息核对。不使用内部 app.cli.handlers，不运行 shell 或任意程序，不接受其他 Vault。官方安装器须 1.12.7 以上，并在 Settings → General 启用 Command line interface。插件本身不安装或升级 Obsidian。

先用 {"command":"version"} 检查可用性。结果 unavailable/unsupported 时明确说明缺口；现有 vault_search、note_read、note_create、note_update 和 metadata_update 仍可使用。CLI read 没有 expectedVersion；已有文件的原生更新仍须先 note_read 取得版本。

## 已接入的 50 项命令

- 文件与结构：version、files、file、folder、folders、read、outline、wordcount。
- 搜索与链接：search、search:context、backlinks、links、unresolved、orphans、deadends。
- 标签、属性与任务：tags、tag、aliases、properties、property:read、tasks、task。task 只接受查询目标和行号，不能切换或修改状态。
- 日记与模板读取：daily:path、daily:read、templates、template:read。
- Bases：bases、base:query、base:views、base:create。
- 界面：open、daily、search:open、tab:open。
- 日记写入：daily:append、daily:prepend。
- 本地历史：diff、history、history:list、history:read、history:restore、history:open；diff 固定 filter=local，不查询 Sync。
- 插件：plugins、plugins:enabled、plugin、plugin:enable、plugin:disable、plugin:install、plugin:uninstall、plugin:reload。

参数按对应命令严格校验。文件目标用精确 path 或唯一 file；名称有重名时改用 path。folder 和 search 的 path 是目录。tab:open 的 file 是精确路径；不接受任意 view 类型或未核对的标签组。示例：

- {"command":"read","path":"wiki/主题.md"}
- {"command":"search:context","query":"关键词","path":"wiki","limit":10}
- {"command":"tab:open","file":"views/tasks.base","view":"bases"}
- {"command":"base:query","path":"views/tasks.base","format":"json"}
- {"command":"base:views","path":"views/tasks.base"}：必须先打开同一活动 Base。
- {"command":"base:create","path":"views/tasks.base","name":"新记录","content":"正文"}：创建 Base 中的记录笔记；不会创建 .base 文件。
- {"command":"daily:append","content":"今天的补记"}：沿用原生日记目录、日期格式和模板；精确目标在执行前冻结。
- {"command":"history:restore","path":"wiki/主题.md","version":1}：先读取实际存在的快照，再确认恢复。

## 对话记账

EchoInk 财务 Base 新增记录必须走现有财务服务。示例：{"command":"base:create","path":"finance/ledger.base","finance":{"date":"2026-10-09","merchant":"早餐店","kind":"expense","amountCents":1200,"category":"餐饮","account":"现金"}}。path 必须是当前现有账本，实际路径以查询结果为准。amountCents 是整数分，1200 表示 12 元；缺少关键事实时先补齐。服务继续验证会员权限、金额、身份、来源和账单计划。结果 engine/backend 为 echoink-finance-service，不能称为 CLI 直接写入。

## 搜索与管理插件

obsidian_plugin_search 使用 Obsidian 官方社区插件目录，示例 {"query":"git","limit":5}。返回真实 ID、名称、作者、描述、仓库；plugins 只列已安装插件，不等于目录搜索。

搜索结果是资料，不授予安装权限。安装用 {"command":"plugin:install","id":"obsidian-git","enable":true}；插件 ID 要在官方目录核实，用户确认后再执行。停用、卸载与重载 EchoInk 自身会打断当前工具，因此明确拒绝；其他插件按其实际效果处理。不提供任意 command/eval、Sync/Publish、主题管理或 plugins:restrict。

## 确认与结果

纯查询不新增确认。只读和 Plan 只能查询；界面操作不能绕过当前工作区权限。daily 可能新建日记，按写入处理。日记、Base 记录、历史恢复和插件副作用复用批准票据与结果回执，并在执行后核对目标；确认后目标改变则停止。

只在实际回读验证后报告完成。empty 是无结果；unavailable 是入口缺失；unsupported 是当前版本不支持；failed/cancelled/truncated/uncertain 分别说明失败、取消、截断或未能确认结果。执行开始后的失败、取消、超时或未能回读属于不确定结果；不要重试，先查询目标。恢复中断的动作只记录结果不确定，不重新执行。CLI 没有原生 expectedVersion 的原子保证，不作等价承诺。

官方文档：https://help.obsidian.md/cli
官方目录：https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json`),
  adapted("obsidian-markdown", "Obsidian Markdown", "创建或修改 Obsidian Markdown、双链、嵌入、callout、frontmatter 或标签时启用。",
    [markdown, callouts, embeds, properties].map(reference).join("\n\n")),
  adapted("obsidian-bases", "Obsidian Bases", "创建或修改 .base 文件、笔记表格视图、筛选条件、公式和汇总时启用。",
    [bases, functions].map(reference).join("\n\n")),
  adapted("json-canvas", "JSON Canvas", "创建或修改 .canvas 文件、节点、连线、分组、思维导图或流程图时启用。",
    [canvas, examples].map(reference).join("\n\n"))
]);
