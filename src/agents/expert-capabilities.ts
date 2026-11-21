import type { AgentModuleId } from "./types";

/** The official catalog's advertised scenarios. Ordinary notes, workspace and web are shared. */
export const OFFICIAL_EXPERT_MODULES: Readonly<Partial<Record<string, readonly AgentModuleId[]>>> = {
  socrates: ["journal", "knowledge-base"],
  aurelius: ["journal", "review"],
  wangyangming: ["knowledge-base", "todos"],
  sushi: ["journal"],
  sunzi: ["knowledge-base", "todos"],
  davinci: ["knowledge-base"],
  franklin: ["journal", "todos", "review"],
  zengguofan: ["journal", "knowledge-base", "todos", "review"],
  "qiao-bangzhu": ["knowledge-base"],
  fangge: ["knowledge-base"],
};
