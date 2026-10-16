import type { DiaryRange, DiaryRecord, EnglishDiaryApi, GenerateDiaryOptions } from "./types";

/** Native view boundary: model calls and writes remain owned by the controller. */
export interface EnglishDiaryViewHost {
  readonly api: EnglishDiaryApi;
  enabled(): boolean;
  generate(path: string, options?: GenerateDiaryOptions): Promise<DiaryRecord>;
  openDiary(path: string): Promise<void>;
  openLibrary(expressionId?: string): Promise<void>;
  openFile(path: string): Promise<void>;
  focusSource(path: string, ranges?: readonly DiaryRange[], options?: { expectedFingerprint: string }): Promise<void>;
  organizeThoughts(path: string): Promise<void>;
}
