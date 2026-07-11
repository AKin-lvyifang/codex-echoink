#!/usr/bin/env python3
"""Heuristic Markdown checker for common Chinese 'AI style' patterns.

The checker reports editing signals, not objective errors. By default it exits 0.
Use --strict to return exit code 1 when the weighted warning score is high.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Rule:
    label: str
    pattern: re.Pattern[str]
    weight: int = 1
    threshold: int = 1
    advice: str = ""


RULES = [
    Rule("文档自我定位", re.compile(r"文档定位|这是一份[^。\n]{0,40}(文档|说明|白皮书)"), 3, 1, "把受众和用途放进元数据，正文直接进入主题。"),
    Rule("模板化开头", re.compile(r"一句话说明|一文读懂|首先[，,]|本文将|下面(?:将|会)"), 2, 1, "删除预告，直接写事实或问题。"),
    Rule("不是而是句式", re.compile(r"不是[^。！？\n]{0,80}而是"), 1, 2, "只保留真正需要对比的一处，其余改为正面陈述。"),
    Rule("解释型过渡", re.compile(r"简单来说|换句话说|可以(?:把|将).{0,25}理解为|需要明确的是|值得注意的是|这意味着"), 1, 2, "检查前句是否已经足够清楚，通常可直接删除或合并。"),
    Rule("抽象强调词", re.compile(r"核心(?:是|能力|理念|回答|重点)|真正(?:完成|重要|被|的)|重点(?:是|不在)|本质上"), 1, 5, "用具体事实代替反复强调。"),
    Rule("口号式三连", re.compile(r"[\u4e00-\u9fff]{1,6}、[\u4e00-\u9fff]{1,6}、[\u4e00-\u9fff]{1,6}"), 1, 5, "确认三项是否都有具体含义，避免只为节奏凑齐。"),
    Rule("模板化收束", re.compile(r"总的来说|综上所述|最后需要说明|未来可期"), 2, 1, "多数说明文不需要总结全文。"),
]

LEAD_INS = [
    "它会", "用户可以", "EchoInk 会", "EchoInk 的", "目标是", "适合这些情况", "这是为了", "当前", "这里的", "这能", "它用于",
]

META_HEADINGS = re.compile(
    r"^#{2,4}\s*(?:\d+[.、]\s*)?(一句话说明|文档定位|核心理念|适合谁使用|不要误解成什么|未来方向|总结|术语表)\s*$",
    re.M,
)


def strip_code(text: str) -> str:
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    text = re.sub(r"`[^`\n]+`", "", text)
    return text


def visible_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.strip()]


def sentence_starts(text: str) -> Counter[str]:
    sentences = re.split(r"[。！？!?]\s*|\n+", text)
    counter: Counter[str] = Counter()
    for sentence in sentences:
        s = re.sub(r"^[\s>*#\-+\d.、()（）]+", "", sentence).strip()
        for lead in LEAD_INS:
            if s.startswith(lead):
                counter[lead] += 1
    return counter


def max_bullet_run(lines: list[str]) -> int:
    longest = current = 0
    for line in lines:
        if re.match(r"^\s*(?:[-*+] |\d+[.)、]\s)", line):
            current += 1
            longest = max(longest, current)
        elif line.strip():
            current = 0
    return longest


def check(path: Path) -> tuple[int, list[str]]:
    raw = path.read_text(encoding="utf-8")
    text = strip_code(raw)
    lines = visible_lines(text)
    warnings: list[str] = []
    score = 0

    for rule in RULES:
        hits = rule.pattern.findall(text)
        count = len(hits)
        if count >= rule.threshold:
            weighted = rule.weight * max(1, count - rule.threshold + 1)
            score += weighted
            warnings.append(f"[{rule.label}] {count} 处。{rule.advice}")

    headings = re.findall(r"^##\s+.+$", text, flags=re.M)
    meta = META_HEADINGS.findall(text)
    if meta:
        score += 2 * len(meta)
        warnings.append(f"[模板章节] {len(meta)} 个：{'、'.join(meta)}。确认是否真的服务读者，而非补齐格式。")

    if len(headings) > 12:
        score += 3
        warnings.append(f"[章节过多] 二级标题 {len(headings)} 个。长文可能混合了多个任务，优先拆文档。")

    bullet_lines = sum(bool(re.match(r"^\s*(?:[-*+] |\d+[.)、]\s)", line)) for line in lines)
    if lines and bullet_lines / len(lines) > 0.35:
        score += 2
        warnings.append(f"[列表密度] {bullet_lines}/{len(lines)} 个非空行是列表。检查是否在机械盘点功能。")

    run = max_bullet_run(lines)
    if run >= 9:
        score += 1
        warnings.append(f"[长列表] 最长连续列表 {run} 项。考虑分组、删减或改为专题参考页。")

    starts = sentence_starts(text)
    repeated = [(lead, count) for lead, count in starts.items() if count >= 4]
    if repeated:
        score += sum(count - 3 for _, count in repeated)
        details = "、".join(f"“{lead}”×{count}" for lead, count in repeated)
        warnings.append(f"[重复句首] {details}。调整主语或直接省略。")

    han_count = len(re.findall(r"[\u4e00-\u9fff]", text))
    if han_count > 5000 and len(headings) > 10:
        score += 2
        warnings.append(f"[篇幅与结构] 约 {han_count} 个汉字、{len(headings)} 个二级标题。入口文档通常不应同时承担百科职责。")

    return score, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="检查中文 Markdown 中常见的 AI 写作痕迹")
    parser.add_argument("path", type=Path, help="Markdown 文件路径")
    parser.add_argument("--strict", action="store_true", help="分数达到 6 时返回失败状态")
    args = parser.parse_args()

    if not args.path.exists() or not args.path.is_file():
        print(f"文件不存在：{args.path}", file=sys.stderr)
        return 2

    try:
        score, warnings = check(args.path)
    except UnicodeDecodeError:
        print("文件必须是 UTF-8 编码。", file=sys.stderr)
        return 2

    print(f"{args.path}: AI 风格提示分 {score}")
    if not warnings:
        print("未发现明显模式。仍需人工判断内容取舍和事实准确性。")
    else:
        for item in warnings:
            print(f"- {item}")

    if args.strict and score >= 6:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
