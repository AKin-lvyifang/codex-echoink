import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackendKind } from "../agent/types";
import { ENHANCE_PROMPT_AGENT_NAME } from "./meta-prompt";

export interface PromptEnhancerRuntimeWorkspace {
  cwd: string;
  cleanup(): Promise<void>;
}

export async function createPromptEnhancerRuntimeWorkspace(backend: AgentBackendKind): Promise<PromptEnhancerRuntimeWorkspace> {
  const cwd = await mkdtemp(join(tmpdir(), "echoink-prompt-enhancer-"));
  try {
    if (backend === "opencode") await writeOpenCodeAgentConfig(cwd);
    return {
      cwd,
      cleanup: async () => {
        await rm(cwd, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function promptEnhancerOpenCodeConfig(): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    plugin: [],
    default_agent: ENHANCE_PROMPT_AGENT_NAME,
    agent: {
      [ENHANCE_PROMPT_AGENT_NAME]: {
        description: "EchoInk built-in prompt enhancement sub-agent",
        mode: "primary",
        prompt: [
          "You are EchoInk's dedicated prompt enhancement sub-agent.",
          "The complete prompt enhancement instructions are supplied as the system prompt for each run.",
          "Do not inspect project files, load skills, call tools, or add commentary."
        ].join(" "),
        tools: { "*": false },
        permission: { "*": "deny" }
      }
    }
  };
}

async function writeOpenCodeAgentConfig(cwd: string): Promise<void> {
  const configDir = join(cwd, ".opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "opencode.json"),
    `${JSON.stringify(promptEnhancerOpenCodeConfig(), null, 2)}\n`,
    "utf8"
  );
}
