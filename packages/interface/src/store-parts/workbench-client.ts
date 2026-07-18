// Workbench REST 契约。interface(L1)不持有实现;studio 在 boot 时通过
// configureWorkbenchClient() 注入 packages/workbench-builtins 提供的
// RestWorkbenchClient。未 configure 即 throw(与 SessionClient 语义一致)。

export interface WorkbenchAgent {
  id: string;
  role?: string;
  avatarRules?: unknown;
  [key: string]: unknown;
}

export interface EngineRootCandidate {
  path: string;
  valid: boolean;
  recommended?: boolean;
}

export interface GameRow {
  slug: string;
  name?: string;
  brief?: string;
  [key: string]: unknown;
}

export interface AndroidConfig {
  applicationId: string;
  name: string;
  icon?: string;
  orientation?: 'portrait' | 'landscape';
}

// Package body 是 open-shape:server 端接受 targetPlatform / rebuildEngine /
// forceRebuild / engineRoot / androidAppId / androidAppName / androidIcon /
// androidOrientation 等一组字段。契约保持宽松,允许 UI 侧字典直接透传。
export type PackageGameOptions = Record<string, unknown>;

export interface PackageJobStatus {
  jobId: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'error' | 'cancelled';
  [key: string]: unknown;
}

export interface HistoryRecord {
  id: string;
  slug: string;
  platform: string;
  [key: string]: unknown;
}

export interface WorkbenchAgentsResponse {
  agents: WorkbenchAgent[];
  agents_from_bus?: Array<{ id: string; role: string }>;
  activeSlug?: string | null;
}

// 服务端语义:ok = targets.every(t => !t.existed || t.removed)。任何"存在但未
// 移除"都会同时置 error 字段——所以 "!ok" 与 "targets.some(t => t.error)" 等价。
// 契约省略 ok 字段(client throws on !r.ok),消费方需要该判断时读 targets 上的 error。
export interface CleanPackageResult {
  totalBytes: number;
  targets: Array<{
    path: string;
    existed: boolean;
    removed: boolean;
    bytes: number;
    error?: string;
  }>;
}

export interface WorkbenchClient {
  listAgents(opts?: { lang?: 'zh' | 'en' }): Promise<WorkbenchAgentsResponse>;
  getActiveSlug(): Promise<{ activeSlug: string | null }>;
  listGames(): Promise<{ games: GameRow[]; activeSlug: string | null }>;
  createGame(input: { slug: string; name: string; brief: string }): Promise<{ ok: boolean; error?: string }>;
  deleteGame(slug: string): Promise<void>;
  activateGame(slug: string): Promise<void>;
  packageGame(slug: string, options?: PackageGameOptions): Promise<{ jobId?: string; async?: boolean; ok?: boolean; [key: string]: unknown }>;
  pollPackageJob(jobId: string): Promise<PackageJobStatus>;
  getEngineRoots(): Promise<{ roots: EngineRootCandidate[] }>;
  cleanPackage(): Promise<CleanPackageResult>;
  listPackageHistory(): Promise<{ records: HistoryRecord[] }>;
  deletePackageHistory(id: string, opts?: { clean?: boolean }): Promise<void>;
}

let configuredClient: WorkbenchClient | null = null;

export function configureWorkbenchClient(client: WorkbenchClient): void {
  configuredClient = client;
}

/** True once the composition root injected a client. Lets optional consumers
 *  (workbench-client plugin) degrade gracefully instead of hitting the
 *  getWorkbenchClient() throw — interface-alone / standalone-editor hosts
 *  never configure one. */
export function hasWorkbenchClient(): boolean {
  return configuredClient !== null;
}

export function getWorkbenchClient(): WorkbenchClient {
  if (!configuredClient) {
    throw new Error('No workbench client configured. The Studio composition root must inject one before booting interface.');
  }
  return configuredClient;
}
