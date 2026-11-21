export type ExpertSource = "official" | "community";

export function isCommunityExpert(id: string, source?: ExpertSource): boolean {
  return source === "community" || id.startsWith("community-");
}
