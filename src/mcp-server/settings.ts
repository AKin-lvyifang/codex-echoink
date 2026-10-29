/** Stored separately from the MCP client connections used by the in-app Agent. */
export interface EchoInkMcpServerSettings {
  enabled: boolean;
  knowledge: boolean;
  memory: boolean;
  token: string;
  tokenVault: string;
  port: number;
}

export function normalizeEchoInkMcpServerSettings(value: unknown): EchoInkMcpServerSettings {
  const input = value && typeof value === "object" ? value as Partial<EchoInkMcpServerSettings> : {};
  return {
    enabled: input.enabled === true,
    knowledge: input.knowledge === true,
    memory: input.memory === true,
    token: typeof input.token === "string" && /^[a-f0-9]{64}$/u.test(input.token) ? input.token : "",
    tokenVault: typeof input.tokenVault === "string" ? input.tokenVault : "",
    port: Number.isInteger(input.port) && input.port! >= 1024 && input.port! <= 65535 ? input.port! : 0
  };
}
