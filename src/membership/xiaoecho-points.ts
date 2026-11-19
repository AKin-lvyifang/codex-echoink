/** The server supplies final points as a nonnegative decimal string, with at most two decimal places. */
export function normalizeXiaoechoTypicalPoints(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() === value && /^\d+(?:\.\d{1,2})?$/u.test(value) && Number.isFinite(Number(value))
    ? value : undefined;
}

/** Desktop alone replaces the legacy multiplier suffix; shared/mobile names stay unchanged. */
export function xiaoechoDesktopModelName(providerId: string, model: { id: string; displayName?: string }): string {
  const name = model.displayName ?? model.id;
  if (providerId !== "xiaoecho") return name;
  return model.id === "auto" ? "auto" : name.replace(/ ×\d+(?:\.\d+)?$/u, "");
}

export function xiaoechoTypicalPointsLabel(model: { discovery?: { typicalPoints?: string } }, language: string): string | undefined {
  const value = normalizeXiaoechoTypicalPoints(model.discovery?.typicalPoints);
  if (value === undefined) return undefined;
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  // Round decimal integers, so values such as 1.05 reliably round up to 1.1.
  const units = cents < 100n ? cents : (cents + 5n) / 10n;
  const scale = cents < 100n ? 100n : 10n;
  const decimals = (units % scale).toString().padStart(cents < 100n ? 2 : 1, "0").replace(/0+$/u, "");
  const points = `${units / scale}${decimals ? `.${decimals}` : ""}`;
  return language === "en" ? `~${points} pts/msg` : `约 ${points} 点/次`;
}
