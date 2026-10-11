import { deviceIdentity } from "./crypto";
import type { DeviceIdentity, LocalAccountState, MembershipStorage } from "./types";

export interface MembershipSecretPort {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}
export const MOBILE_ACTIVATION_NOTICE = "移动端按当前笔记库的客户端实例激活；同一设备在不同笔记库可能占用不同名额。可在设备管理中解绑不再使用的实例。";
const identityFlights = new WeakMap<MembershipSecretPort, Map<string, Promise<DeviceIdentity>>>();

/** SecretStorage is Vault-local. Nothing in this adapter is saved to data.json. */
export async function createMobileMembershipStorage(secret: MembershipSecretPort | undefined, namespace: string): Promise<MembershipStorage> {
  let memory: LocalAccountState = {}, persistent = false, identityFlight: Promise<DeviceIdentity> | undefined;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(namespace))), n => n.toString(16).padStart(2, "0")).join("").slice(0, 24);
  const prefix = `echoink-membership-mobile-${digest}`;
  const write = (id: string, value: string) => {
    try {
      secret!.setSecret(id, value);
      if (secret!.getSecret(id) !== value) throw new Error("WRITE_NOT_CONFIRMED");
    } catch {
      persistent = false;
      throw new Error("安全存储未保存成功，登录和授权未确认持久化。请重试；本次会话结束后需重新登录。");
    }
  };
  if (secret) {
    try { write(`${prefix}-state`, secret.getSecret(`${prefix}-state`) ?? "{}"); persistent = true; }
    catch { /* Explicit session-only fallback; preserve any old unreadable state. */ }
  }
  const secureSession = persistent;
  const identity = (): Promise<DeviceIdentity> => {
    if (identityFlight) return identityFlight;
    if (!secret) return identityFlight = deviceIdentity();
    let flights = identityFlights.get(secret);
    if (!flights) { flights = new Map(); identityFlights.set(secret, flights); }
    const existingFlight = flights.get(prefix);
    if (existingFlight) {
      identityFlight = existingFlight.then(value => {
        if (secureSession) {
          const saved = secret.getSecret(`${prefix}-identity`);
          if (!saved) write(`${prefix}-identity`, JSON.stringify(value));
          else {
            let stored: DeviceIdentity;
            try { stored = JSON.parse(saved) as DeviceIdentity; }
            catch { throw new Error("设备凭据不可读取，原有凭据保留，请恢复安全存储后重试。"); }
            if (stored.publicKey?.x !== value.publicKey.x || stored.publicKey?.y !== value.publicKey.y)
              throw new Error("设备凭据已改变，原有凭据保留，请重启后重新验证。");
          }
        }
        return value;
      });
      void identityFlight.catch(() => { identityFlight = undefined; });
      return identityFlight;
    }
    const flight = (async () => {
      let saved: string | null;
      try { saved = secret.getSecret(`${prefix}-identity`); }
      catch { throw new Error("安全存储不可读取，原有设备凭据保留，请恢复后重试。"); }
      if (saved) {
        try {
          const value = JSON.parse(saved) as DeviceIdentity;
          await crypto.subtle.importKey("jwk", value.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
          if (!value.publicKey.x || value.publicKey.x !== value.privateKey.x || value.publicKey.y !== value.privateKey.y) throw new Error("INVALID_IDENTITY");
          return value;
        } catch { throw new Error("设备凭据不可读取，原有凭据保留，请恢复安全存储后重试。"); }
      }
      const value = await deviceIdentity();
      if (secureSession) write(`${prefix}-identity`, JSON.stringify(value));
      return value;
    })();
    flights.set(prefix, flight); identityFlight = flight;
    // Keep the resolved identity for this SecretStorage instance throughout this run.
    void flight.catch(() => { flights.delete(prefix); identityFlight = undefined; });
    return flight;
  };
  return {
    get persistent() { return persistent; },
    read: async () => {
      if (!secureSession) return structuredClone(memory);
      try { return JSON.parse(secret!.getSecret(`${prefix}-state`) ?? "{}") as LocalAccountState; }
      catch { persistent = false; throw new Error("安全存储中的登录状态不可读取，原有凭据保留，请重试登录。"); }
    },
    write: async state => {
      memory = structuredClone(state);
      if (secureSession) { write(`${prefix}-state`, JSON.stringify(state)); persistent = true; }
    },
    identity
  };
}
