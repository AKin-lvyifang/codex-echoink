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
  readFailures: GenerationReadFailure[];
  sourcePaths?: string[];
  error?: string;
}
/** The model supplies hierarchy only. Coordinates and identifiers are program-owned. */
export interface GenerationMapPoint { text: string; sourcePaths?: string[] }
export interface GenerationMapBranch { title: string; points: GenerationMapPoint[] }
export interface GenerationMapHierarchy { title: string; branches: GenerationMapBranch[] }
export interface GenerationCanvasNode {
  id: string;
  type: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}
export interface GenerationCanvasEdge {
  id: string;
  fromNode: string;
  fromSide: "right";
  toNode: string;
  toSide: "left";
}
export interface GenerationCanvasDocument { nodes: GenerationCanvasNode[]; edges: GenerationCanvasEdge[] }
