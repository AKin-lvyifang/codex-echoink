import type { MobileServices } from "./services";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { loadKnowledgeHealth } from "../knowledge-base/knowledge-health";

export async function loadMobileKnowledgeHealth(
  services: MobileServices,
  bindings: KnowledgeFolderBindings,
  check: () => void,
) {
  check();
  return loadKnowledgeHealth(services.app, { ...services.settings.knowledgeBase, folderBindings: bindings });
}
