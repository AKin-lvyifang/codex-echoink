import type { EchoInkResource } from "./types";

export function buildBuiltinToolBundleResources(): EchoInkResource[] {
  return [
    {
      id: "echoink-local:tool-bundle:knowledge-base",
      kind: "tool-bundle",
      source: "echoink-local",
      name: "knowledge-base",
      description: "EchoInk knowledge-base guardrails, local search, report writing, and raw integrity checks",
      enabled: true,
      scopes: ["knowledge"],
      bridgeMode: "plugin-tool"
    },
    {
      id: "echoink-local:tool-bundle:editor-actions",
      kind: "tool-bundle",
      source: "echoink-local",
      name: "editor-actions",
      description: "EchoInk editor action candidate validation and Markdown preservation",
      enabled: true,
      scopes: ["editor-actions"],
      bridgeMode: "plugin-tool"
    }
  ];
}
