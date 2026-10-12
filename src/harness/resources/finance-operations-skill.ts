export const FINANCE_OPERATIONS_SKILL = `## 用途
处理日常财务查询、记账、明确修改或删除、预算调整、账单创建与关联。用户用自然话即可，不需要手选 Skill。财务报告交给 finance-analysis，微信/支付宝批量导入交给 finance-bill-import，不混用它们处理日常操作。

## 操作
先用 finance_query 或 finance_budget.get / finance_bill.list 读取需要的真实分类、对象、版本和原值。金额传整数分。分类只能匹配全局已有启用名称及别名；候选不唯一先澄清，不能偷偷创建目录。

用户说“记一下，我今天早餐吃了12块钱”：finance_record.create 保存1200分支出、说明早餐、已有餐饮分类，日期省略即本地今日。商户、账户未说就省略，保存为空；这两项不是追问理由，不能编造早餐店或取第一账户。金额缺失才问。

修改和整理只传用户指定的 patch 字段，以及查询所得精确 targets/id/expectedVersion；保留其他字段。多候选、模糊批量或删除范围不清先列对象与影响并澄清。明确范围内的单笔操作直接执行。

“这个月”用 scope current，“以后每个月”用 default。先读真实额度再用 allocations 绝对调整或 deltas 相对调整；未设额度不等于0。只改指定分类，保留总额和其他类。超额不写，说明超出多少并请用户选择；不能代改总额、其他类。回报原额→新额及未分配的实际变化，真实消费超预算仍能记账。

账单用 finance_bill.create，name/budgetCents 必填，allocations 可省略。update 与新增分开；不存在不能 upsert。比如杭州旅行总3000、餐饮800、交通700、住宿1500。关联“刚才那笔高铁票”先从当前对话真实工具回执定位唯一记录和账单，再读最新版本后 associate；多候选先问，不批量关联历史。

## 权限与结果
沿本条消息冻结的工作区权限、Agent/Plan、插件和会员能力。只读和 Plan 仅查询、讨论，不写。明确的用户操作指令已表达本次意图，不重复索要相同确认；工具不接受模型自报 confirmed。

只有工具 completed 且 readbackVerified 才说保存完成，简短回报实际字段。失败、版本冲突、取消和批量部分完成逐项说明。uncertain 或响应中断先 finance_query.operations 核对原操作身份与持久回读，再按原 id 查询；不能重新 create、换字段重试或按相似金额合并真实的第二次消费。查询和模型回复不是保存证据。`;
