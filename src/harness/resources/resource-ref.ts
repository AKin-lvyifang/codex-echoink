import type { ResourceRef } from "../contracts/run";

export function resourceRefToUri(ref: ResourceRef): string {
  const id = encodeResourcePart(ref.resourceId);
  if (ref.plane === "echoink-builtin") return `echoink://builtin/${id}`;
  if (ref.plane === "echoink-vault") return `echoink://vault/${id}`;
  if (ref.plane === "imported-copy") return `echoink://imported/${id}`;
  const backendId = encodeResourcePart(ref.backendId ?? "");
  if (!backendId) throw new Error("Agent native resource requires backendId.");
  return `native://${backendId}/${id}`;
}

export function parseResourceUri(uri: string): ResourceRef {
  const value = uri.trim();
  if (value.startsWith("echoink://builtin/")) {
    return { plane: "echoink-builtin", resourceId: decodeResourcePart(value.slice("echoink://builtin/".length)) };
  }
  if (value.startsWith("echoink://vault/")) {
    return { plane: "echoink-vault", resourceId: decodeResourcePart(value.slice("echoink://vault/".length)) };
  }
  if (value.startsWith("echoink://imported/")) {
    return { plane: "imported-copy", resourceId: decodeResourcePart(value.slice("echoink://imported/".length)) };
  }
  if (value.startsWith("native://")) {
    const rest = value.slice("native://".length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) throw new Error("Invalid native resource URI.");
    return {
      plane: "agent-native",
      backendId: decodeResourcePart(rest.slice(0, slash)),
      resourceId: decodeResourcePart(rest.slice(slash + 1))
    };
  }
  throw new Error(`Invalid resource URI: ${uri}`);
}

function encodeResourcePart(value: string): string {
  return encodeURIComponent(value.trim()).replace(/%2F/gi, "/");
}

function decodeResourcePart(value: string): string {
  return decodeURIComponent(value.trim());
}
