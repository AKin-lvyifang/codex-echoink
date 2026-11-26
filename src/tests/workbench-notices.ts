import assert from "node:assert/strict";
import type { AccountNotices, GiftNotice, GiftReceipt } from "../membership/types";
import { WorkbenchNotices } from "../membership/workbench-notices";

export async function runWorkbenchNoticeTests(): Promise<void> {
  const day = 86_400_000;
  let now = Date.UTC(2026, 10, 25), balance = 1250, owner: string | null = "a", session = 1;
  const gifts: GiftNotice[] = [
    { id: "adjustment", kind: "gift", title: "签到补发", desc: "补计", points: 100, grantsOnClaim: false },
    { id: "release", kind: "gift", title: "更新礼物", desc: "感谢", points: 100, grantsOnClaim: true }
  ];
  let noticesResult = async (): Promise<AccountNotices> => ({ notices: [...gifts] });
  let accountChange = () => {};
  const requests: string[] = [];
  const account = {
    noticeAccountId: () => owner, checkInSession: () => owner ? session : null,
    subscribe(listener: () => void) { accountChange = listener; return () => {}; },
    getNotices: () => { requests.push("notices"); return noticesResult(); },
    async claimGift(id: string): Promise<GiftReceipt> {
      requests.push("claim");
      const granted = id === "release";
      if (granted) balance += 100;
      return { granted, points: 100, balance: String(balance), expiresAt: now + 30 * day };
    },
    async getPoints() {
      requests.push("points");
      return { balanceMilli: balance * 1000, balance: String(balance), activeTotal: "3000", nextExpiry: null, batches: [], serverTime: now };
    }
  };
  let saved: unknown;
  const port = { loadLocalStorage: () => saved, saveLocalStorage: (_key: string, value: unknown) => { saved = structuredClone(value); } };
  const service = new WorkbenchNotices(account, "2.9.5", { port, emptyData: false }, () => now);
  await service.refreshNotices();
  await service.refreshPoints();
  const sequence = service.beginGiftSequence()!;
  assert.equal(service.beginGiftSequence(), undefined);
  assert.equal((await service.claimGift(gifts[0], sequence))?.granted, false);
  assert.equal(service.balance(), "1250");
  assert.equal(service.pointsFeedback("thread"), undefined);
  assert.equal(service.starReadyAt(), undefined);
  assert.equal((await service.claimGift(gifts[1], sequence))?.granted, true);
  service.endGiftSequence(sequence, true);
  assert.deepEqual(service.pointsFeedback("thread"), { kind: "gift", amount: 100, before: 1250 });
  assert.equal(service.openStar(), true);
  service.laterStar();
  assert.equal(service.starReadyAt(), now + 7 * day);
  assert.equal(service.openStar(), false);
  now += 7 * day;
  assert.equal(service.openStar(), true);
  const requestsBeforeClick = requests.length;
  service.clickStar();
  assert.equal(requests.length, requestsBeforeClick);
  assert.equal(service.starReadyAt(), undefined);
  service.startCloudTurn("thread");
  balance -= 1.5;
  await service.finishCloudTurn("thread");
  assert.deepEqual(service.pointsFeedback("thread"), { kind: "spent", conversationId: "thread", amount: 1.5 });
  assert.equal(service.pointsFeedback("different"), undefined);

  let deliver!: (response: AccountNotices) => void;
  noticesResult = () => new Promise(resolve => { deliver = resolve; });
  const stale = service.refreshNotices(true);
  owner = "b"; session++; accountChange();
  deliver({ notices: [...gifts] });
  await stale;
  assert.deepEqual(service.pendingGifts(), []);
  assert.equal(service.starClicked(), true, "switching accounts keeps the local click");
  assert.equal(service.balance(), undefined);
  service.dispose();

  const reopened = new WorkbenchNotices(account, "2.9.5", { port, emptyData: false }, () => now);
  assert.equal(reopened.starClicked(), true, "restart preserves the click on the same install");
  reopened.dispose();

  owner = null;
  const fresh = new WorkbenchNotices(account, "2.9.5", { port, emptyData: true }, () => now);
  assert.equal(fresh.starClicked(), false, "a fresh install ignores residual device storage");
  assert.equal(fresh.starReadyAt(), undefined, "reinstall resets prior eligibility and reminders");
  now += 3 * day;
  for (let index = 0; index < 10; index++) fresh.recordCompletion(`run-${index}`, "same-task", true, false);
  fresh.recordCompletion("run-9", "same-task", true, false);
  assert.equal(fresh.starReadyAt(), undefined, "the threshold crossing and a replay do not qualify");
  fresh.recordCompletion("run-10", "same-task", true, false);
  assert.equal(fresh.openStar(), true);
  fresh.clickStar();
  owner = "b"; session++; accountChange();
  assert.equal(fresh.starClicked(), true, "signing in keeps the local click");
  fresh.dispose();

  const newDevice = new WorkbenchNotices(account, "2.9.5", {
    port: { loadLocalStorage: () => null, saveLocalStorage() {} }, emptyData: true
  }, () => now);
  assert.equal(newDevice.starClicked(), false, "the same account on a fresh device starts with no click");
  assert.equal(newDevice.starReadyAt(), undefined);
  newDevice.dispose();
  console.log("Workbench gifts and Star preference: PASS");
}
