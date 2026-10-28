import type { AccountService } from "../membership/account-service";
import { createMembershipTransport, membershipApiUrl } from "../membership/transport";
import { RUN_REPORT_LIMIT, type ReportSnapshot } from "./report";

export async function uploadRunReport(snapshot: ReportSnapshot, account?: AccountService | null): Promise<string> {
  if (snapshot.bytes > RUN_REPORT_LIMIT) throw new Error("运行记录超过 8 MiB，请改为导出文件。");
  try {
    const value = account ? await account.submitRunReport(snapshot.report) : await createMembershipTransport(membershipApiUrl)("/api/run-reports", "POST", { report: snapshot.report });
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !/^R-[A-Z0-9]{6}$/u.test(value.id)) throw new Error("上报响应无效，请重试或改为导出文件。");
    return value.id;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    const message = code && ({ SERVICE_UNAVAILABLE: "上报服务暂不可用，请稍后重试或改为导出文件。", REQUEST_FAILED: "上报失败，请稍后重试或改为导出文件。", RATE_LIMITED: "今日上报次数已达上限，请改为导出文件。", PAYLOAD_TOO_LARGE: "运行记录超过 8 MiB，请改为导出文件。", AUTH_REQUIRED: "登录凭据已失效，请重新登录或改为导出文件。", UNAUTHORIZED: "登录凭据已失效，请重新登录或改为导出文件。" } as Record<string, string>)[code];
    throw new Error(message ?? (error instanceof Error ? error.message : "上报失败，请重试或改为导出文件。"), { cause: error });
  }
}
