import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { withPersonalMemoryFixture } from "./personal-memory-fixture";
import type { PersonalMemoryWriteRequest } from "../harness/memory/personal-memory-contracts";

export async function runPersonalMemoryWriteValidation(): Promise<void> {
  await withPersonalMemoryFixture(async ({ repository, runtime, reopen }) => {
    const context = runtime();
    const create = {
      operation: "create", kind: "view", title: "原有观点", content: "喜欢用表格对比方案", basis: "observed"
    } as const;
    const original = (await repository.write(create, context)).record!;
    const update = {
      operation: "supersede", targetId: original.id, title: "新的观点", content: "比较三个方案时用表格",
      basis: "inferred", reason: "补充适用条件"
    } as const;
    const { layout } = repository;
    const persisted = () => Promise.all([layout.manifest, layout.audit, layout.searchIndex, layout.memory].map(file => readFile(file, "utf8")));
    const before = await persisted();
    const invalidRequests: Record<string, unknown>[] = [
      { ...create, title: "非法类型", kind: "active", basis: "explicit" },
      { ...create, title: "非字符串类型", kind: ["view"] },
      { ...create, basis: "unknown" },
      { ...create, contentOrigin: "unknown" },
      { ...update, kind: "active" },
      { ...update, basis: "unknown" },
      { ...update, contentOrigin: "unknown" },
      { operation: "profile_update", profileKey: "identity.family", text: "测试画像", basis: "observed" },
      { operation: "update", targetId: original.id }
    ];
    for (const request of invalidRequests) {
      await assert.rejects(
        repository.write(request as PersonalMemoryWriteRequest, context),
        { code: "invalid_request" },
        JSON.stringify(request)
      );
    }
    assert.deepEqual(await persisted(), before);
    assert.deepEqual(await readdir(layout.active), []);
    assert.equal((await readdir(layout.views)).length, 1);

    const reopened = await reopen();
    assert.deepEqual((await reopened.read(original.id, context)).record, original);
    const replacement = (await reopened.write(update, context)).record!;
    assert.equal(replacement.kind, "view");
    assert.equal(replacement.basis, "inferred");
    assert.equal((await reopened.read(replacement.id, context)).record.content, update.content);
  }, { watchExternalChanges: false });
  console.log("PASS Personal Memory rejects invalid write enums and remains readable and writable after reopen");
}
