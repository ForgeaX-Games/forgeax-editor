export interface ProjectValidationIssue {
  code: string;
  file: string;
  message: string;
  detail: Record<string, unknown>;
}
export interface ProjectValidationReport {
  ok: boolean;
  gameDir: string;
  blocking: ProjectValidationIssue[];
  warnings: ProjectValidationIssue[];
  stats: { bytes: number; entities: number; packs: number; sidecars: number };
}
export function validateGameProject(
  gameDir: string,
  options?: { maxBytes?: number; maxEntities?: number },
): Promise<ProjectValidationReport>;
