// SPDX-License-Identifier: LicenseRef-EchoInk-Pro
// Scope and preserved rights: ../../LICENSE
/** Account display and action contracts; service owns authentication and entitlements. */
import type { MembershipCurrency, MembershipPlanId } from "./account-membership-pricing";
export type MembershipState = "unavailable" | "anonymous" | "free" | "active" | "lifetime" | "offline-valid" | "verification-required" | "expired" | "revoked" | "device-limit" | "device-required" | "scheduled";
export type AccountAvatar = "initial" | { readonly url: string };
export interface AccountIdentity {
  readonly name: string;
  readonly email: string;
  readonly joinedAt: string | null;
  readonly avatar: AccountAvatar;
  readonly passwordSet: boolean;
}
export interface AccountUsageDay {
  readonly date: string;
  readonly tokens: number | null;
  readonly turns: number | null;
  readonly input: number | null;
  readonly output: number | null;
}
export interface AccountRank { readonly name: string; readonly count: number; }
export interface AccountActivityGift {
  readonly id: string;
  readonly name: string;
  readonly product: string;
  readonly endedAt: number | null;
  readonly gift: {
    readonly code: string | null;
    readonly codeAvailability: string;
    readonly state: string;
  };
}
export interface AccountStatistics {
  readonly totalTokens: number | null;
  readonly totalTurns: number | null;
  readonly currentStreak: number | null;
  readonly bestStreak: number | null;
  readonly coverage: string | null;
  readonly days: readonly AccountUsageDay[];
  readonly rankings: Readonly<Partial<Record<30 | 90 | "all", { readonly models: readonly AccountRank[]; readonly skills: readonly AccountRank[] }>>>;
  readonly assets: Readonly<Partial<Record<"notes" | "knowledge" | "memory" | "expressions", number>>>;
}
export interface AccountMembershipViewModel {
  readonly identity: AccountIdentity | null;
  readonly statistics: AccountStatistics;
  readonly membership: {
    readonly state: MembershipState;
    readonly planId: string | null;
    readonly planName: string | null;
    readonly expiresAt: string | null;
    readonly startsAt?: string | null;
    readonly verifiedAt: string | null;
    readonly offlineUntil: string | null;
    readonly devices: readonly { readonly id: string; readonly name: string; readonly description: string; readonly current: boolean }[] | null;
    readonly deviceLimit: number | null;
  };
  readonly provider: "configured" | "missing" | "unknown";
  readonly serviceAvailable: boolean;
  readonly storageNotice?: string | null;
  readonly verificationError?: string | null;
  readonly products?: readonly {id: MembershipPlanId;prices:{CNY:number;USD:number};days:number|null}[];
  readonly activityGifts?: readonly AccountActivityGift[];
  readonly betaOffer?: { readonly status: string } | null;
}
/** UI intents only; a future adapter supplies the callbacks and refreshed view model. */
export interface AccountActions {
  readonly signIn?: (input: { email: string; method: "code" | "password"; credential: string }) => Promise<void>;
  readonly requestCode?: (input: {email:string;purpose:"login"|"password-set"|"password-reset"}) => Promise<void>;
  /** avatar: undefined keeps the current image, null restores the initial, File replaces it. */
  readonly saveProfile?: (input: { name: string; avatar?: File | null }) => Promise<void>;
  readonly setPassword?: (input: { email: string; code: string; next: string }) => Promise<void>;
  readonly resetPassword?: (input: { email: string; code: string; next: string }) => Promise<void>;
  readonly signOut?: () => Promise<void>;
  readonly redeem?: (code: string) => Promise<void>;
  /** Legacy purchase intent; the beta keeps it unavailable and never grants rights from it. */
  readonly selectPlan?: (input: { planId: MembershipPlanId; currency: MembershipCurrency }) => Promise<void>;
  readonly verify?: () => Promise<void>;
  readonly activateDevice?: (name?:string) => Promise<void>;
  readonly renameDevice?: (id:string,name:string) => Promise<void>;
  readonly removeDevice?: (id: string) => Promise<void>;
}
export interface AccountMembershipAdapter {
  readonly read: () => AccountMembershipViewModel;
  readonly actions: AccountActions;
  readonly subscribe?: (listener:()=>void)=>()=>void;
}
export function createUnavailableAccountAdapter(provider: AccountMembershipViewModel["provider"] = "unknown"): AccountMembershipAdapter {
  return {
    read: () => ({
      identity: null,
      statistics: { totalTokens: null, totalTurns: null, currentStreak: null, bestStreak: null, coverage: null, days: [], rankings: {}, assets: {} },
      membership: { state: "unavailable", planId: null, planName: null, expiresAt: null, verifiedAt: null, offlineUntil: null, devices: null, deviceLimit: null },
      provider, serviceAvailable: false
    }),
    actions: {}
  };
}
