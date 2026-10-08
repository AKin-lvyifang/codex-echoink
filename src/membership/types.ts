import type { AccountActivityGift } from "../settings/account-membership-model";
import type { MembershipPlanId } from "../settings/account-membership-pricing";

export const PRO_CAPABILITIES = [
  "finance.analysis.generate",
  "finance.category_budget.write",
  "finance.bill_plan.write",
  "finance.export",
  "diary.explanation.generate",
  "diary.expression.write",
  "diary.timeline.generate",
] as const;
export type Capability = (typeof PRO_CAPABILITIES)[number];
export interface LeaseClaims {
  schema: 1;
  iss: "echoink";
  sub: string;
  deviceId: string;
  keyHash: string;
  capabilities: string[];
  major: number;
  iat: number;
  exp: number;
}
export interface MembershipAccount {
  id: string;
  email: string;
  name: string;
  joinedAt: string;
  avatar: string | null;
  passwordSet: boolean;
}
export interface MembershipSigningKey {
  kid: string;
  alg: string;
  publicKey: JsonWebKey;
}
export interface MembershipProduct {
  id: MembershipPlanId;
  prices: { CNY: number; USD: number };
  days: number | null;
}
/** The cached snapshot can retain only a state after a server-side revocation. */
export interface MembershipRights {
  state: string;
  serverTime?: number;
  planId?: string | null;
  planName?: string | null;
  expiresAt?: number | string | null;
  startsAt?: number | string | null;
  devices?: { id: string; name: string; platform: string; verified: number | string }[];
  deviceLimit?: number;
  capabilities?: string[];
  activityGifts?: AccountActivityGift[];
  betaOffer?: { status: string } | null;
}
export interface DeviceLeaseResponse {
  lease: string;
  deviceId: string;
  serverTime: number;
}
/** Response shapes for the API endpoints whose payloads the client consumes. */
export interface MembershipApiResponses {
  "/api/auth/login": { token: string };
  "/api/auth/password": { token: string };
  "/api/account": MembershipAccount;
  "/api/membership": MembershipRights & { serverTime: number };
  "/api/products": { products: MembershipProduct[] };
  "/api/devices/challenge": { challengeId: string; nonce: string };
  "/api/devices/activate": DeviceLeaseResponse;
  "/api/devices/lease": DeviceLeaseResponse;
  "/api/keys": { keys: MembershipSigningKey[] };
}
export interface LocalAccountState {
  token?: string;
  account?: MembershipAccount;
  lease?: string;
  keys?: MembershipSigningKey[];
  deviceId?: string;
  verifiedTime?: number;
  observedTime?: number;
  rights?: MembershipRights;
}
export interface DeviceIdentity {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}
export interface MembershipStorage {
  persistent: boolean;
  read(): Promise<LocalAccountState>;
  write(state: LocalAccountState): Promise<void>;
  identity(): Promise<DeviceIdentity>;
}
export interface CapabilityAccess {
  checkCapability(capability: Capability): boolean;
  requireCapability(capability: Capability): void;
  subscribe(listener: () => void): () => void;
}
