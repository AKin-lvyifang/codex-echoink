import {
  createUnavailableAccountAdapter,
  type AccountActions,
  type AccountMembershipViewModel,
  type MembershipState,
} from "../settings/account-membership-model";
import type {
  MembershipStorage,
  LocalAccountState,
  LeaseClaims,
  Capability,
  CapabilityAccess,
  MembershipApiResponses,
  MembershipProduct,
} from "./types";
import { hasProPluginAccess } from "./access";
import { signProof, verifyLease } from "./crypto";

const ERRORS: Record<string, string> = {
  AUTH_REQUIRED: "请重新登录账号。",
  AUTH_FAILED: "邮箱或登录凭据无效，请重试。",
  OTP_INVALID: "验证码无效、已使用或已过期，请重新获取对应验证码。",
  RATE_LIMITED: "请求较频繁，请稍后重试。",
  MAIL_UNAVAILABLE: "邮件服务暂不可用，请稍后重试。",
  DEVICE_LIMIT: "设备名额已满，请先解绑旧设备。",
  DEVICE_REVOKED: "本机已解绑，请重新启用设备。",
  PRO_REQUIRED: "此操作需要有效 PRO 权益。",
  REVOKED: "该授权已撤销，请联系支持核实。",
  SUBSCRIPTION_EXPIRED: "订阅已到期，已有资料仍可查看。",
  ENTITLEMENT_SCHEDULED: "权益尚未生效，请查看开始日期。",
  CODE_ALREADY_REDEEMED: "兑换码已被使用。",
  CODE_INVALID: "兑换码无效。",
  CODE_FOR_OTHER_ACCOUNT: "此内测激活码属于其他账号，请使用本人领取的激活码。",
  BETA_ENDED: "内测活动已结束，此激活码已不可兑换。已有资料仍可查看。",
  ALREADY_OWNED: "已拥有对应买断权益，无需重复购买。",
  PASSWORD_LENGTH: "密码需为10至128个字符。",
  PRODUCT_UNAVAILABLE: "购买待开放；已有激活码可在账号与会员中兑换。",
  SERVICE_UNAVAILABLE: "账号服务暂不可用。",
  OPERATION_CANCELLED: "账号已切换，本次操作已取消。",
};

export class MembershipApiError extends Error {
  constructor(readonly code: string) {
    super(ERRORS[code] || "账号请求未完成，请重试。");
  }
}
export type MembershipTransport = (
  path: string,
  method: string,
  body: unknown,
  token?: string,
) => Promise<unknown>;
interface Operation {
  generation: number;
  token?: string;
  accountId?: string;
}
function isMembershipState(state: string): state is MembershipState {
  return ["unavailable", "anonymous", "free", "active", "lifetime", "expired", "revoked", "scheduled", "verification-required", "device-required", "device-limit", "offline-valid"].includes(state);
}

export class AccountService implements CapabilityAccess {
  private state: LocalAccountState = {};
  private claims: LeaseClaims | null = null;
  private connected = false;
  private refreshError: string | null = null;
  private initializing = true;
  private listeners = new Set<() => void>();
  private refreshFlight: Promise<void> | null = null;
  private persistence: Promise<void> = Promise.resolve();
  private closed = false;
  private generation = 0;
  private refreshGeneration = -1;
  private products: MembershipProduct[] = [];
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  readonly actions: AccountActions;

  constructor(
    readonly storage: MembershipStorage,
    private transport: MembershipTransport,
    readonly apiUrl: string,
    private openWebsite: (url: string) => void,
    private websiteUrl: string,
    private provider: () => AccountMembershipViewModel["provider"],
    private now = () => Date.now(),
  ) {
    this.actions = {
      signIn: (input) => this.signIn(input),
      requestCode: async (input) => {
        await this.call("/api/auth/code", "POST", input, this.operation());
      },
      signOut: () => this.signOut(),
      saveProfile: (input) => this.saveProfile(input),
      setPassword: (input) => this.password(input, "password-set"),
      resetPassword: (input) => this.password(input, "password-reset"),
      redeem: async (code) => {
        const operation = this.operation();
        await this.call("/api/redeem", "POST", { code }, operation);
        this.assertCurrent(operation);
        await this.refresh(true);
        this.assertCurrent(operation);
        if (!hasProPluginAccess(this)) {
          await this.deviceRequest("/api/devices/activate", operation, { name: "我的 Obsidian", platform: "Obsidian client" });
          await this.refresh(true);
          this.assertCurrent(operation);
        }
        if (!hasProPluginAccess(this))
          throw new MembershipApiError("PRO_REQUIRED");
      },
      verify: () => this.refresh(true),
      activateDevice: async (name) => {
        const operation = this.operation();
        await this.deviceRequest("/api/devices/activate", operation, {
          name: name || "我的 Obsidian",
          platform: "Obsidian client",
        });
        this.assertCurrent(operation);
        await this.refresh(true);
      },
      renameDevice: async (id, name) => {
        const operation = this.operation();
        await this.call(
          `/api/devices/${encodeURIComponent(id)}`,
          "PATCH",
          { name },
          operation,
        );
        this.assertCurrent(operation);
        await this.refresh(true);
      },
      removeDevice: async (id) => {
        const operation = this.operation();
        await this.call(
          `/api/devices/${encodeURIComponent(id)}`,
          "DELETE",
          {},
          operation,
        );
        this.assertCurrent(operation);
        if (id === this.state.deviceId) this.clearLease();
        await this.refresh(true);
      },
      selectPlan: async () => { throw new MembershipApiError("PRODUCT_UNAVAILABLE"); },
    };
  }

  private operation(): Operation {
    return {
      generation: this.generation,
      token: this.state.token,
      accountId: this.state.account?.id,
    };
  }
  private isCurrent(operation: Operation): boolean {
    return !this.closed && operation.generation === this.generation;
  }
  private assertCurrent(operation: Operation): void {
    if (!this.isCurrent(operation))
      throw new MembershipApiError("OPERATION_CANCELLED");
  }

  async initialize(): Promise<void> {
    const operation = this.operation();
    try {
      const saved = await this.storage.read();
      this.assertCurrent(operation);
      this.state = saved;
      await this.restoreClaims(operation);
    } catch {
      if (this.isCurrent(operation)) this.state = {};
    }
    if (!this.isCurrent(operation)) return;
    this.initializing = false;
    await this.refresh();
  }

  private async discardSession(token?: string): Promise<void> {
    if (token && this.apiUrl) {
      await this.transport("/api/auth/logout", "POST", {}, token).catch(
        () => undefined,
      );
    }
  }
  private async signIn(input: {
    email: string;
    method: "code" | "password";
    credential: string;
  }): Promise<void> {
    const previousToken = this.state.token;
    ++this.generation;
    this.claims = null;
    this.state = {};
    const operation = this.operation();
    await this.persist();
    this.assertCurrent(operation);
    const result = await this.call("/api/auth/login", "POST", input, operation);
    if (!this.isCurrent(operation)) {
      await this.discardSession(result.token);
      return;
    }
    this.state = { token: result.token };
    await this.persist();
    await this.discardSession(previousToken);
    if (this.isCurrent(operation)) await this.refresh();
  }
  private async signOut(): Promise<void> {
    const token = this.state.token;
    ++this.generation;
    this.claims = null;
    this.state = {};
    await this.persist();
    await this.discardSession(token);
  }
  private async password(
    input: { email: string; code: string; next: string },
    purpose: "password-set" | "password-reset",
  ): Promise<void> {
    const operation = this.operation();
    const result = await this.call(
      "/api/auth/password",
      "POST",
      { ...input, purpose },
      operation,
    );
    if (!this.isCurrent(operation)) {
      await this.discardSession(result.token);
      return;
    }
    ++this.generation;
    this.claims = null;
    this.state = { token: result.token };
    await this.persist();
    await this.refresh();
  }
  private async saveProfile(input: {
    name: string;
    avatar?: File | null;
  }): Promise<void> {
    const operation = this.operation();
    await this.call("/api/account", "PATCH", { name: input.name }, operation);
    this.assertCurrent(operation);
    if (input.avatar !== undefined) {
      const body = new FormData();
      if (input.avatar === null) body.set("reset", "1");
      else body.set("avatar", input.avatar);
      await this.call("/api/account/avatar", "POST", body, operation);
      this.assertCurrent(operation);
    }
    await this.refresh();
  }
  private call<Path extends keyof MembershipApiResponses>(
    path: Path,
    method?: string,
    body?: unknown,
    operation?: Operation,
  ): Promise<MembershipApiResponses[Path]>;
  private call(path: string, method?: string, body?: unknown, operation?: Operation): Promise<unknown>;
  private async call(
    path: string,
    method = "GET",
    body?: unknown,
    operation = this.operation(),
  ): Promise<unknown> {
    this.assertCurrent(operation);
    if (!this.apiUrl) throw new MembershipApiError("SERVICE_UNAVAILABLE");
    // A multi-request action always keeps the token it started with.
    return await this.transport(path, method, body, operation.token);
  }

  private emit(): void {
    if (!this.closed) for (const listener of this.listeners) listener();
  }
  private async persist(): Promise<void> {
    const generation = this.generation;
    const value = structuredClone(this.state);
    this.persistence = this.persistence
      .catch(() => undefined)
      .then(async () => {
        if (!this.closed && generation === this.generation)
          await this.storage.write(value);
      });
    await this.persistence;
    this.emit();
    this.scheduleExpiry();
  }
  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (!this.claims || this.closed) return;
    const remaining = this.claims.exp - this.now();
    if (remaining > 0) {
      this.expiryTimer = setTimeout(
        () => {
          this.expiryTimer = null;
          this.emit();
        },
        Math.min(remaining + 10, 2147483647),
      );
      this.expiryTimer.unref?.();
    }
  }
  private trustedNow(): number {
    const wall = this.now();
    if (this.state.observedTime && wall < this.state.observedTime - 300000) {
      throw new Error("CLOCK_UNCERTAIN");
    }
    return Math.max(wall, this.state.verifiedTime || 0);
  }
  private clearLease(): void {
    this.claims = null;
    delete this.state.lease;
    delete this.state.deviceId;
  }
  private async restoreClaims(operation = this.operation()): Promise<void> {
    this.claims = null;
    const saved = this.state;
    if (!saved.lease || !saved.account || !saved.keys) return;
    try {
      const identity = await this.storage.identity();
      const claims = await verifyLease(
        saved.lease,
        saved.keys,
        saved.account.id,
        identity,
        this.trustedNow(),
      );
      if (this.isCurrent(operation) && saved.deviceId === claims.deviceId)
        this.claims = claims;
    } catch {
      /* Keep the purchase; request online verification. */
    }
  }
  private async deviceRequest(
    path: "/api/devices/activate" | "/api/devices/lease",
    operation: Operation,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const identity = await this.storage.identity();
    this.assertCurrent(operation);
    const challenge = await this.call(
      "/api/devices/challenge",
      "POST",
      { publicKey: identity.publicKey },
      operation,
    );
    this.assertCurrent(operation);
    const signature = await signProof(
      identity,
      challenge.challengeId,
      challenge.nonce,
    );
    const result = await this.call(
      path,
      "POST",
      {
        publicKey: identity.publicKey,
        challengeId: challenge.challengeId,
        signature,
        ...extra,
      },
      operation,
    );
    this.assertCurrent(operation);
    const keys = await this.call("/api/keys", "GET", undefined, operation);
    const claims = await verifyLease(
      result.lease,
      keys.keys,
      this.state.account!.id,
      identity,
      Math.max(this.now(), result.serverTime),
    );
    this.assertCurrent(operation);
    this.state = {
      ...this.state,
      lease: result.lease,
      keys: keys.keys,
      deviceId: result.deviceId,
      verifiedTime: result.serverTime,
      observedTime: this.now(),
    };
    this.claims = claims;
    await this.persist();
  }

  refresh(strict = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshFlight) {
      if (this.refreshGeneration === this.generation) return strict ? this.refreshFlight : this.refreshFlight.catch(() => undefined);
      return this.refreshFlight.catch(() => undefined).then(() => this.refresh(strict));
    }
    this.refreshGeneration = this.generation;
    this.refreshFlight = this.refreshOnce().finally(() => {
      this.refreshFlight = null;
    });
    return strict ? this.refreshFlight : this.refreshFlight.catch(() => undefined);
  }
  private async refreshOnce(): Promise<void> {
    const operation = this.operation();
    if (!operation.token) {
      this.connected = !!this.apiUrl;
      if (this.apiUrl) {
        try {
          const products = await this.call(
            "/api/products",
            "GET",
            undefined,
            operation,
          );
          this.assertCurrent(operation);
          this.products = products.products;
        } catch {
          /* Unauthenticated free use remains available. */
        }
      }
      if (this.isCurrent(operation)) await this.persist();
      return;
    }
    try {
      const [account, rights, products] = await Promise.all([
        this.call("/api/account", "GET", undefined, operation),
        this.call("/api/membership", "GET", undefined, operation),
        this.call("/api/products", "GET", undefined, operation),
      ]);
      this.assertCurrent(operation);
      this.products = products.products;
      this.connected = true;
      this.refreshError = null;
      this.state = {
        ...this.state,
        account,
        rights,
        observedTime: this.now(),
        verifiedTime: rights.serverTime,
      };
      if (!["active", "lifetime"].includes(rights.state)) this.clearLease();
      else if (this.state.deviceId)
        await this.deviceRequest("/api/devices/lease", operation);
      this.assertCurrent(operation);
      await this.persist();
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      this.connected = false;
      this.refreshError = error instanceof Error ? error.message : "会员验证失败，请重试。";
      if (
        error instanceof MembershipApiError &&
        error.code === "AUTH_REQUIRED"
      ) {
        this.state = {};
        this.claims = null;
      } else if (
        error instanceof MembershipApiError &&
        [
          "REVOKED",
          "SUBSCRIPTION_EXPIRED",
          "DEVICE_REVOKED",
          "VERSION_NOT_COVERED",
          "ENTITLEMENT_SCHEDULED",
        ].includes(error.code)
      ) {
        this.clearLease();
        const state =
          error.code === "SUBSCRIPTION_EXPIRED"
            ? "expired"
            : error.code === "DEVICE_REVOKED"
              ? "device-required"
              : error.code === "ENTITLEMENT_SCHEDULED"
                ? "scheduled"
                : "revoked";
        this.state.rights = { ...this.state.rights, state };
      } else {
        await this.restoreClaims(operation);
        try {
          this.trustedNow();
          this.state.observedTime = Math.max(
            this.state.observedTime || 0,
            this.now(),
          );
        } catch {
          /* Preserve the last trusted clock observation. */
        }
      }
      if (this.isCurrent(operation)) await this.persist();
      throw error;
    }
  }

  read(): AccountMembershipViewModel {
    const empty = createUnavailableAccountAdapter(this.provider()).read();
    const rights = this.state.rights;
    const reportedState = !this.apiUrl
      ? "unavailable"
      : !this.state.account
        ? "anonymous"
        : rights?.state === "version-not-covered"
          ? "verification-required"
          : rights?.state || "free";
    let state: MembershipState = isMembershipState(reportedState) ? reportedState : "verification-required";
    let knownExpired = false;
    try {
      const expiry = typeof rights?.expiresAt === "number" ? rights.expiresAt : Date.parse(rights?.expiresAt ?? "");
      knownExpired = Number.isFinite(expiry) && expiry <= this.trustedNow();
    } catch { /* Uncertain time still requires online verification. */ }
    if (this.state.account && (rights?.state === "active" || rights?.state === "lifetime") && knownExpired) state = "expired";
    if (this.state.account && (rights?.state === "active" || rights?.state === "lifetime") && !knownExpired) {
      state = hasProPluginAccess(this)
        ? this.connected
          ? rights.state
          : "offline-valid"
        : this.state.lease && this.state.deviceId
          ? "verification-required"
          : this.connected
            ? Number(rights.devices?.length) >= Number(rights.deviceLimit)
              ? "device-limit"
              : "device-required"
            : "verification-required";
    }
    if (
      this.state.account &&
      !this.connected &&
      !knownExpired &&
      (rights?.state === "active" || rights?.state === "lifetime") &&
      rights?.capabilities?.length &&
      !hasProPluginAccess(this)
    )
      state = "verification-required";
    return {
      ...empty,
      identity: this.state.account
        ? {
            ...this.state.account,
            joinedAt: new Date(
              this.state.account.joinedAt,
            ).toLocaleDateString(),
            avatar: this.state.account.avatar
              ? { url: new URL(this.state.account.avatar, this.apiUrl).href }
              : "initial",
          }
        : null,
      membership: {
        ...empty.membership,
        state,
        planId: rights?.planId || null,
        planName: rights?.planName || null,
        expiresAt: rights?.expiresAt
          ? new Date(rights.expiresAt).toLocaleString()
          : null,
        startsAt: rights?.startsAt
          ? new Date(rights.startsAt).toLocaleString()
          : null,
        verifiedAt: this.state.verifiedTime
          ? new Date(this.state.verifiedTime).toLocaleString()
          : null,
        offlineUntil: this.claims
          ? new Date(this.claims.exp).toLocaleString()
          : null,
        devices:
          rights?.devices?.map((device) => ({
            id: device.id,
            name: device.name,
            description: `${device.platform} · ${new Date(device.verified).toLocaleDateString()}`,
            current: device.id === this.state.deviceId,
          })) || null,
        deviceLimit: rights?.deviceLimit || null,
      },
      products: this.products,
      activityGifts: rights?.activityGifts ?? [],
      betaOffer: rights?.betaOffer ?? null,
      serviceAvailable: !!this.apiUrl && !this.initializing,
      storageNotice: this.storage.persistent
        ? null
        : "当前设备仅在本次运行中保留登录和授权；重启后需联网重新登录。",
      verificationError: this.refreshError,
      provider: this.provider(),
    };
  }
  checkCapability(capability: Capability): boolean {
    try {
      return (
        !!this.claims &&
        this.claims.sub === this.state.account?.id &&
        this.claims.exp > this.trustedNow() &&
        this.claims.capabilities.includes(capability)
      );
    } catch {
      return false;
    }
  }
  requireCapability(capability: Capability): void {
    if (this.checkCapability(capability)) return;
    const state = this.read().membership.state;
    throw new Error(
      state === "verification-required"
        ? "需要联网验证会员，已有资料仍可查看。"
        : state === "device-required"
          ? "已拥有 PRO，请在账号与会员中启用本机。"
          : state === "device-limit"
            ? "设备名额已满，请管理旧设备后启用本机。"
            : state === "scheduled"
              ? "权益尚未生效，请查看开始日期。"
              : "此操作需要有效 PRO；已有资料仍可查看。",
    );
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose(): void {
    this.closed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    ++this.generation;
    this.listeners.clear();
    this.claims = null;
    this.state = {};
  }
}
