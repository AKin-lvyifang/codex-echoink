import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { KnowledgeMaintenancePreferenceRepository } from "../knowledge-base/knowledge-maintenance-preferences";
import {
  proposeKnowledgePreferences,
  type KnowledgePreferenceWizardHost,
} from "../knowledge-base/knowledge-preference-wizard";

export async function runKnowledgePreferenceWizardTests(root: string) {
  await fs.mkdir(root, { recursive: true });
  const store = new KnowledgeMaintenancePreferenceRepository(
    await fs.mkdtemp(path.join(root, "wizard-preferences-")),
  );
  const baseline = await store.read();
  let available = true;
  let requests = 0;
  const host: KnowledgePreferenceWizardHost = {
    read: () => store.read(),
    save: (content, expectedRevision) =>
      store.save({ content, expectedRevision }),
    available: () => available,
    generate: async (prompt) => {
      requests++;
      assert.ok(prompt.includes("学习备考"));
      return JSON.stringify({
        granularity: ["围绕可复习的问题分组。", "保留概念边界与易错区别。"],
        expression: ["先写核心结论。", "例子要有来源依据。"],
      });
    },
  };
  const draft = await proposeKnowledgePreferences(
    host,
    baseline,
    "study",
    "zh-CN",
    new AbortController().signal,
  );
  assert.equal(
    await fs.stat(store.filePath).then(
      () => true,
      () => false,
    ),
    false,
    "Generation and cancellation leave no preference file",
  );
  assert.ok(draft.content.includes("## 关注维度"));
  assert.ok(
    draft.content.includes("## 颗粒度与组织\n- 围绕可复习的问题分组。"),
  );
  const saved = await host.save(draft.content, draft.expectedRevision);
  assert.equal(saved.state, "custom");
  assert.equal((await store.read()).content, draft.content);
  await assert.rejects(
    host.save(baseline.content, draft.expectedRevision),
    (error) => (error as { code: string }).code === "revision_conflict",
  );
  assert.equal((await store.read()).content, saved.content);
  available = false;
  await assert.rejects(
    proposeKnowledgePreferences(
      host,
      saved,
      "study",
      "zh-CN",
      new AbortController().signal,
    ),
    /连接模型/,
  );
  assert.equal(requests, 1, "Missing model is rejected without a request");
  available = true;
  const custom = ["---", "owner: ' exact ' # 用户属性", "---", "# 我的偏好", "",
    "## 自定义前段", "保持标点和缩进。  ", "", "## 颗粒度与组织", "旧颗粒度。", "",
    "## 表达风格", "旧表达。", "", "## 私人补充", "这个自定义小节不可重写。  ", "", "  "].join("\r\n");
  await fs.writeFile(store.filePath, custom);
  const customBaseline = await store.read();
  const customDraft = await proposeKnowledgePreferences(host, customBaseline, "study", "zh-CN", new AbortController().signal);
  await host.save(customDraft.content, customDraft.expectedRevision);
  const customAfter = await fs.readFile(store.filePath, "utf8");
  assert.ok(customAfter.startsWith(custom.slice(0, custom.indexOf("## 颗粒度与组织"))),
    "Redo preserves the custom prefix and CRLF bytes");
  assert.ok(customAfter.endsWith(custom.slice(custom.indexOf("## 私人补充"))),
    "Redo preserves all custom suffix bytes, including trailing whitespace");
  await fs.rm(store.rootPath, { recursive: true });
  console.log(
    "PASS preference wizard: read-only generation, unchanged other sections, explicit existing CAS save, custom preservation, conflict and missing-model zero requests.",
  );
}
