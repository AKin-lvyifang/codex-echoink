/** Display only: keep the complete target and preview in the approval binding. */
export function drawingApprovalPresentation(preview?: string): { target: string; preview: string } | undefined {
  try {
    const value = JSON.parse(preview ?? "") as Record<string, unknown> | null;
    if (value?.domain === "excalidraw" && typeof value.path === "string" && typeof value.style === "string"
      && typeof value.boxCount === "number" && typeof value.arrowCount === "number") {
      return { target: value.path, preview: `${value.style}\n${value.boxCount} 个框 · ${value.arrowCount} 条连线` };
    }
  } catch { /* Other approvals retain their existing presentation. */ }
  return undefined;
}
