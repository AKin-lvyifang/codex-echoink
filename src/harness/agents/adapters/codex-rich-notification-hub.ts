import type { CodexNotification } from "../../../types/app-server";
import type { CodexRichRunDriver } from "./codex-rich-driver";

export class CodexRichNotificationHub {
  private readonly drivers = new Map<string, CodexRichRunDriver>();

  register(driver: CodexRichRunDriver): void {
    this.drivers.set(driver.runId, driver);
  }

  unregister(runId: string): void {
    this.drivers.delete(runId);
  }

  dispatch(notification: CodexNotification): boolean {
    if (notification.method === "thread/tokenUsage/updated") {
      this.matchDriver(notification)?.handleNotification(notification);
      return false;
    }
    if (notification.method === "thread/compacted") {
      return false;
    }
    const ids = extractNotificationIds(notification.params);
    if (notification.method === "error" && !ids.threadId && !ids.turnId && !ids.itemId) {
      if (!this.drivers.size) return false;
      for (const driver of this.drivers.values()) driver.handleNotification(notification);
      return true;
    }
    const driver = this.matchDriver(notification);
    if (!driver) return false;
    driver.handleNotification(notification);
    return true;
  }

  private matchDriver(notification: CodexNotification): CodexRichRunDriver | null {
    const ids = extractNotificationIds(notification.params);
    if (ids.itemId) {
      const matched = this.uniqueMatch((driver) => driver.hasItemId(ids.itemId));
      if (matched) return matched;
    }
    if (ids.turnId) {
      const matched = this.uniqueMatch((driver) => driver.turnId === ids.turnId);
      if (matched) return matched;
    }
    if (ids.threadId) {
      const matched = this.uniqueMatch((driver) => driver.threadId === ids.threadId);
      if (matched) return matched;
    }
    return null;
  }

  private uniqueMatch(predicate: (driver: CodexRichRunDriver) => boolean): CodexRichRunDriver | null {
    let matched: CodexRichRunDriver | null = null;
    for (const driver of this.drivers.values()) {
      if (!predicate(driver)) continue;
      if (matched) return null;
      matched = driver;
    }
    return matched;
  }
}

function extractNotificationIds(params: any): { threadId: string; turnId: string; itemId: string } {
  return {
    threadId: firstString(params?.threadId, params?.thread?.id, params?.turn?.threadId, params?.item?.threadId),
    turnId: firstString(params?.turnId, params?.turn?.id, params?.item?.turnId),
    itemId: firstString(params?.itemId, params?.item?.id)
  };
}

function firstString(...values: any[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
