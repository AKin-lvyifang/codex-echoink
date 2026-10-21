/** Frozen settings template. Templates supply content instructions, never permissions. */
export type GenerationOutputKind = "markdown" | "canvas";
export interface GenerationTemplate {
  id: string;
  name: string;
  description: string;
  instructions: string;
  outputKind: GenerationOutputKind;
  builtin?: boolean;
}
export interface GenerationRequest {
  version: 1;
  id: string;
  createdAt: string;
  template: GenerationTemplate;
  sourcePaths: string[];
  outputKind: GenerationOutputKind;
  outputRoot: string;
  outputDirectory: string;
}
export interface GenerationSource {
  path: string;
  content: string;
  bytes: number;
}
export interface GenerationReadFailure { path: string; reason: string }
export type GenerationWriteState = "not_written" | "verified" | "unconfirmed";
export interface GenerationResult {
  requestId: string;
  outputKind: GenerationOutputKind;
  writeState: GenerationWriteState;
  path?: string;
  title?: string;
  characterCount?: number;
  branchCount?: number;
  modelAttempts?: number;
  canvasFallback?: boolean;
  canvasValidationErrors?: string[];
  readFailures: GenerationReadFailure[];
  sourcePaths?: string[];
  error?: string;
}
/** The fixed hierarchy remains the last-attempt compatibility fallback. */
export interface GenerationMapPoint { text: string; sourcePaths?: string[] }
export interface GenerationMapBranch { title: string; points: GenerationMapPoint[] }
export interface GenerationMapHierarchy { title: string; branches: GenerationMapBranch[] }
export type GenerationAttempt =
  | { kind: "initial" }
  | { kind: "repair"; failedOutput: string; validationError: string }
  | { kind: "fallback" };
export interface GenerationCanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}
export interface GenerationCanvasTextNode extends GenerationCanvasNodeBase { type: "text"; text: string }
export interface GenerationCanvasFileNode extends GenerationCanvasNodeBase { type: "file"; file: string; subpath?: string }
export interface GenerationCanvasLinkNode extends GenerationCanvasNodeBase { type: "link"; url: string }
export interface GenerationCanvasGroupNode extends GenerationCanvasNodeBase { type: "group"; label?: string }
export type GenerationCanvasNode = GenerationCanvasTextNode | GenerationCanvasFileNode | GenerationCanvasLinkNode | GenerationCanvasGroupNode;
export type GenerationCanvasSide = "top" | "right" | "bottom" | "left";
export interface GenerationCanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: GenerationCanvasSide;
  fromEnd?: "none" | "arrow";
  toNode: string;
  toSide?: GenerationCanvasSide;
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
}
export interface GenerationCanvasDocument { nodes: GenerationCanvasNode[]; edges: GenerationCanvasEdge[] }
export interface GenerationCanvasOutput { title: string; canvas: GenerationCanvasDocument }
/** Parsed entirely before entering authorization or write execution. */
export interface GenerationPreparedOutput { title: string; content: string; branchCount?: number; characterCount?: number }
