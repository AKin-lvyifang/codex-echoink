import {
  createModels,
  type AuthInteraction,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type MutableModels,
  type OAuthCredential
} from "@earendil-works/pi-ai";
import {
  openaiCodexProvider
} from "@earendil-works/pi-ai/providers/openai-codex";
import type { CodexForObsidianSettings } from "../settings/settings";
import { OpenAICodexAuthError, safeOpenAICodexAuthError } from "./codex-oauth-errors";

export { OPENAI_CODEX_RELOGIN_REQUIRED_MESSAGE, OpenAICodexAuthError } from "./codex-oauth-errors";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export type OpenAICodexAuthState =
  | "disconnected"
  | "connected"
  | "expired";

export interface OpenAICodexAuthStatus {
  readonly state: OpenAICodexAuthState;
  readonly expiresAt?: number;
}

export interface OpenAICodexOAuthHost {
  readonly settings: CodexForObsidianSettings;
  saveSettings(force?: boolean): Promise<void>;
}

/**
 * One app-owned serialized CredentialStore backed by plugin-local settings.
 * The store never exposes credentials through status/list operations and is
 * the only write path for login, refresh, and logout.
 */
export class OpenAICodexSettingsCredentialStore
implements CredentialStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly host: OpenAICodexOAuthHost) {}

  async read(providerId: string): Promise<Credential | undefined> {
    this.requireProvider(providerId);
    return cloneCredential(this.host.settings.openAICodexCredential);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.host.settings.openAICodexCredential
      ? [{ providerId: OPENAI_CODEX_PROVIDER_ID, type: "oauth" }]
      : [];
  }

  modify(
    providerId: string,
    fn: (
      current: Credential | undefined
    ) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    this.requireProvider(providerId);
    return this.enqueue(async () => {
      const previous = cloneCredential(
        this.host.settings.openAICodexCredential
      );
      const next = await fn(previous);
      if (next === undefined) return previous;
      if (next.type !== "oauth") {
        throw new Error("codex_oauth_credential_invalid");
      }
      this.host.settings.openAICodexCredential = cloneCredential(next) ?? null;
      try {
        await this.host.saveSettings(true);
      } catch {
        this.host.settings.openAICodexCredential = previous ?? null;
        throw new Error("codex_oauth_credential_persist_failed");
      }
      return cloneCredential(this.host.settings.openAICodexCredential);
    });
  }

  delete(providerId: string): Promise<void> {
    this.requireProvider(providerId);
    return this.enqueue(async () => {
      const previous = cloneCredential(
        this.host.settings.openAICodexCredential
      );
      this.host.settings.openAICodexCredential = null;
      try {
        await this.host.saveSettings(true);
      } catch {
        this.host.settings.openAICodexCredential = previous ?? null;
        throw new Error("codex_oauth_credential_persist_failed");
      }
    });
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const current = (async () => {
      await previous.catch(() => undefined);
      return await action();
    })();
    this.tail = current.then(() => undefined, () => undefined);
    return current;
  }

  private requireProvider(providerId: string): void {
    if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
      throw new Error("codex_oauth_provider_invalid");
    }
  }
}

export class OpenAICodexOAuthService {
  private readonly models: MutableModels;
  private readonly credentials: OpenAICodexSettingsCredentialStore;

  constructor(host: OpenAICodexOAuthHost) {
    this.credentials = new OpenAICodexSettingsCredentialStore(host);
    this.models = createModels({
      credentials: this.credentials
    });
    this.models.setProvider(openaiCodexProvider());
  }

  async status(): Promise<OpenAICodexAuthStatus> {
    const credential = await this.models
      .checkAuth(OPENAI_CODEX_PROVIDER_ID)
      .catch(() => undefined);
    if (credential?.type !== "oauth") {
      return Object.freeze({ state: "disconnected" });
    }
    const stored = await this.credentials.read(OPENAI_CODEX_PROVIDER_ID);
    if (stored?.type !== "oauth") {
      return Object.freeze({ state: "disconnected" });
    }
    return Object.freeze({
      state: Date.now() >= stored.expires ? "expired" : "connected",
      expiresAt: stored.expires
    });
  }

  async login(
    interaction: AuthInteraction
  ): Promise<OpenAICodexAuthStatus> {
    try {
      await this.models.login(
        OPENAI_CODEX_PROVIDER_ID,
        "oauth",
        interaction
      );
      return await this.status();
    } catch {
      throw new Error(interaction.signal?.aborted
        ? "codex_oauth_login_cancelled"
        : "codex_oauth_login_failed");
    }
  }

  async logout(): Promise<void> {
    try {
      await this.models.logout(OPENAI_CODEX_PROVIDER_ID);
    } catch {
      throw new Error("codex_oauth_logout_failed");
    }
  }

  async resolveAccessToken(): Promise<string> {
    try {
      const resolved = await this.models.getAuth(OPENAI_CODEX_PROVIDER_ID);
      const access = resolved?.auth.apiKey?.trim() ?? "";
      if (!access) throw new OpenAICodexAuthError("provider_oauth_relogin_required");
      return access;
    } catch (error) {
      throw safeOpenAICodexAuthError(error);
    }
  }

}

export async function logoutOpenAICodexAfterRuntimeSuspension(input: {
  readonly active: boolean;
  readonly suspendRuntime: () => Promise<void>;
  readonly logout: () => Promise<void>;
}): Promise<void> {
  if (input.active) await input.suspendRuntime();
  await input.logout();
}

function cloneCredential(
  credential: OAuthCredential | null | undefined
): OAuthCredential | undefined {
  return credential ? structuredClone(credential) : undefined;
}
