import { createHash } from "node:crypto";
import type { RecordRootBindingRef } from "../../harness/storage/record-root-registry";

export function fixtureRecordRootBindingRef(
  rootId: string,
  seed = rootId
): RecordRootBindingRef {
  const registryHex = hex(`registry:${seed}`);
  return {
    registryId: `registry-${registryHex.slice(0, 24)}`,
    rootId,
    authority: "plugin-owned",
    boundaryPathDigest: digest(`boundary:${seed}`),
    rootPathDigest: digest(`root:${seed}`),
    rootIdentity: {
      dev: 1,
      ino: Number.parseInt(registryHex.slice(0, 12), 16) + 1
    },
    revision: 0,
    digest: digest(`binding:${seed}`)
  };
}

export function fixtureRecordMutationRootBindings(): RecordRootBindingRef[] {
  return [
    fixtureRecordRootBindingRef("conversation-store"),
    fixtureRecordRootBindingRef("record-trash")
  ];
}

function digest(value: string): string {
  return `sha256:${hex(value)}`;
}

function hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
