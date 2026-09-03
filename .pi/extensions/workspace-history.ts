import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
  rm as fsRm,
  readdir,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import ignore, { type Ignore } from "ignore";
import { homedir } from "node:os";
import path from "node:path";

const SNAPSHOT_TYPE = "workspace-history.snapshot";
const SNAPSHOT_RETENTION_REF_PREFIX = "refs/wh/s";
const ACTIVE_SESSION_LEASE_FILE = "active-session.json";

const DEFAULT_MAX_SESSIONS_PER_WORKSPACE = 3;
const DEFAULT_MAX_WORKSPACES = 10;
const DEFAULT_MAX_SCAN_FILES = 20_000;
const DEFAULT_MAX_SCAN_DIRS = 3_000;
const DEFAULT_MAX_SCAN_MS = 5_000;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const SHADOW_REPO_LOCK_WAIT_MS = 5_000;
const SHADOW_REPO_LOCK_STALE_MS = 15_000;
const RESTORE_FILE_LOCK_RETRY_DELAYS_MS = [100, 250, 500] as const;
const WORKSPACE_HISTORY_LOG_ENV = "PI_WORKSPACE_HISTORY_LOG";
const PROJECT_MARKER_FILES = [
  ".git",
  ".jj",
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "tsconfig.json",
];

type SnapshotKind = "baseline" | "before" | "after" | "manual";
type WorkspaceComparison = "clean" | "dirty" | "missing";
type NavigationMode = "conversationAndWorkspace" | "conversationOnly";

const NAVIGATION_MODE_OPTIONS = [
  "Conversation and workspace",
  "Conversation only (keep current files)",
] as const;

interface WorkspaceSnapshot {
  v: 1;
  kind: SnapshotKind;
  commit: string;
  turnId?: string;
  promptText?: string;
  userEntryId?: string;
  assistantEntryId?: string;
  beforeSnapshotId?: string;
  resultLeafId?: string;
  label?: string;
  createdAt: string;
}

interface TurnSnapshotRecord {
  turnId: string;
  promptText?: string;
  userEntryId: string;
  assistantEntryId: string;
  beforeCommit: string;
  afterCommit: string;
  createdAt: string;
  navigationSnapshots?: NodeSnapshotAnchor[];
}

interface NodeSnapshotAnchor {
  entryId: string;
  commit: string;
  position: "before" | "after";
}

interface TurnSnapshotState {
  version: 1;
  turns: TurnSnapshotRecord[];
}

interface RedoItem {
  targetId: string;
  navigationMode?: NavigationMode;
  createdAt: string;
}

interface RedoState {
  sessionId: string;
  stack: RedoItem[];
}

interface PendingWorkspaceAnchor {
  commit: string;
  label: string;
  oldLeafId: string | null;
  targetId: string;
}

interface PendingRecoveryState {
  version: 1;
  commit: string;
  workspaceTree: string;
  createdAt: string;
}

interface RuntimeState {
  pendingTurnId?: string;
  pendingBeforeCommit?: string;
  pendingPromptText?: string;
  pendingOriginalUserEntryId?: string;
  pendingOperationStartLeafId?: string | null;
  pendingNavigationSnapshots?: NodeSnapshotAnchor[];
  pendingAnchoredEntryIds?: Set<string>;
  pendingLastTurnCommit?: string;
  pendingLastAssistantEntryId?: string;
  internalNavigation?: "undo" | "redo";
  internalNavigationFailureReported?: boolean;
  navigationMode?: NavigationMode;
  pendingWorkspaceAnchor?: PendingWorkspaceAnchor;
  pendingRecovery?: PendingRecoveryState;
  pendingRecoveryPromise?: Promise<void>;
  cachedSettings?: WorkspaceHistorySettings;
  cachedPaths?: WorkspaceStoragePaths;
  cleanupPromise?: Promise<void>;
  reusableRepoUpdatePromise?: Promise<void>;
  lastCleanupAt?: number;
  lastKnownShadowHead?: string;
  initialSnapshotCommit?: string;
  warmedBaselineCommit?: string;
  pendingBeforeSnapshotPrompt?: string;
  baselineWarmupTimer?: ReturnType<typeof setTimeout>;
  baselineWarmupPromise?: Promise<void>;
  baselineWarmupGeneration?: number;
  baselineWarmupInProgress?: boolean;
  cachedGitignoreSource?: string;
  cachedSnapshotIgnoreMatcher?: Ignore;
  cachedHardExcludeMatcher?: Ignore;
  cachedExcludeSource?: string;
  snapshotWritePromise?: Promise<unknown>;
  beforeSnapshotPromise?: Promise<void>;
  turnSnapshots?: TurnSnapshotState;
  disabledNoticeReason?: string;
  lastIndexPruneIgnoreSource?: string;
  lastExcludedWorkspacePaths?: string[];
  initializationNoticeShown?: boolean;
  invalidShadowRepoNoticeShown?: boolean;
  invalidShadowRepoRecoveryPending?: boolean;
  reusableRepoFailureNoticeShown?: boolean;
  validatedShadowGitDir?: string;
  warnedMissingSnapshotCommits?: Set<string>;
  sessionLeaseOwnerId?: string;
}

interface NavigationPrecheckResult {
  currentLeafId?: string;
  currentSnapshot?: WorkspaceSnapshot | CustomEntry<WorkspaceSnapshot>;
}

interface WorkspaceHistorySettings {
  enabled: boolean | "auto";
  allowHomeDirectory: boolean;
  requireProjectMarker: boolean;
  storageDir: string;
  maxSessionsPerWorkspace: number;
  maxWorkspaces: number;
  maxScanFiles: number;
  maxScanDirs: number;
  maxScanMs: number;
  gitTimeoutMs: number;
}

interface WorkspaceHistoryAvailability {
  enabled: boolean;
  reason?: string;
  unsafeStorageDir?: boolean;
}

interface WorkspaceStoragePaths {
  storageDir: string;
  workspaceHash: string;
  workspaceRoot: string;
  sessionsRoot: string;
  reusableGitDir: string;
  sessionRoot: string;
  shadowGitDir: string;
  redoFile: string;
  recoveryFile: string;
  turnSnapshotsFile: string;
  sessionLeaseFile: string;
  workspaceMetaFile: string;
  sessionMetaFile: string;
  logFile: string;
}

interface WorkspaceMeta {
  version: 1;
  workspaceHash: string;
  cwd: string;
  realpath: string;
  createdAt: string;
  lastUsedAt: string;
}

interface SessionMeta {
  version: 1;
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

interface SessionLease {
  version: 1;
  sessionId: string;
  ownerId: string;
  processId: number;
  createdAt: string;
}

const DEFAULT_EXCLUDES = [
  ".git",
  ".jj",
  ".pi/workspace-history",
  "node_modules",
  "dist",
  "build",
  ".cache",
  ".next",
  ".turbo",
  "coverage",
  ".env",
  ".env.*",
];

const WINDOWS_RESERVED_BASENAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForShadowRepoIndexLock(ctx: ExtensionContext, state?: RuntimeState): Promise<boolean> {
  const paths = await getWorkspaceStoragePaths(ctx, state);
  const lockPath = path.join(paths.shadowGitDir, "index.lock");

  for (const startedAt = Date.now(); Date.now() - startedAt < SHADOW_REPO_LOCK_WAIT_MS;) {
    if (!await exists(lockPath)) {
      return true;
    }

    const lockStat = await stat(lockPath).catch(() => undefined);
    if (lockStat && Date.now() - lockStat.mtimeMs > SHADOW_REPO_LOCK_STALE_MS) {
      await unlink(lockPath).catch(() => undefined);
      return !await exists(lockPath);
    }

    await sleep(100);
  }

  return !await exists(lockPath);
}

async function clearStaleShadowRepoIndexLock(ctx: ExtensionContext, state?: RuntimeState): Promise<boolean> {
  const paths = await getWorkspaceStoragePaths(ctx, state);
  const lockPath = path.join(paths.shadowGitDir, "index.lock");

  if (!await exists(lockPath)) {
    return false;
  }

  const lockStat = await stat(lockPath).catch(() => undefined);
  if (lockStat && Date.now() - lockStat.mtimeMs <= SHADOW_REPO_LOCK_STALE_MS) {
    return false;
  }

  await unlink(lockPath).catch(() => undefined);
  return true;
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

function expandHome(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(homedir(), filePath.slice(2));
  }
  return filePath;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, overrideValue] of Object.entries(overrides)) {
    const baseValue = result[key];
    if (
      overrideValue &&
      typeof overrideValue === "object" &&
      !Array.isArray(overrideValue) &&
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      result[key] = deepMerge(baseValue as Record<string, unknown>, overrideValue as Record<string, unknown>);
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function normalizeTimeoutMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 100 ? Math.floor(value) : fallback;
}

function normalizeEnabled(value: unknown): boolean | "auto" {
  return value === true || value === false ? value : "auto";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasProjectMarker(cwd: string): Promise<boolean> {
  let current = await realpath(cwd).catch(() => path.resolve(cwd));
  for (;;) {
    for (const marker of PROJECT_MARKER_FILES) {
      if (await pathExists(path.join(current, marker))) {
        return true;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

async function isInsideJujutsuMetadata(cwd: string): Promise<boolean> {
  let current = await realpath(cwd).catch(() => path.resolve(cwd));
  for (;;) {
    if (normalizePathForComparison(path.basename(current)) === normalizePathForComparison(".jj")) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function normalizePathForComparison(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameOrDescendantPath(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(
    normalizePathForComparison(parentPath),
    normalizePathForComparison(candidatePath),
  );
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function resolvePotentialRealpath(filePath: string): Promise<string> {
  const suffix: string[] = [];
  let current = path.resolve(filePath);
  for (;;) {
    const resolved = await realpath(current).catch(() => undefined);
    if (resolved) {
      return path.join(resolved, ...suffix.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(filePath);
    }
    suffix.push(path.basename(current));
    current = parent;
  }
}

async function isStorageDirInsideWorkspace(ctx: ExtensionContext, storageDir: string): Promise<boolean> {
  const workspaceRealpath = await resolvePotentialRealpath(ctx.cwd);
  const storageRealpath = await resolvePotentialRealpath(storageDir);
  return isSameOrDescendantPath(workspaceRealpath, storageRealpath);
}

async function readSettingsFile(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    return parseJsonObject(await readFile(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

async function loadWorkspaceHistorySettings(ctx: ExtensionContext): Promise<WorkspaceHistorySettings> {
  const globalSettingsPath = path.join(getAgentDir(), "settings.json");
  const projectSettingsPath = path.join(ctx.cwd, ".pi", "settings.json");
  const merged = deepMerge(await readSettingsFile(globalSettingsPath), await readSettingsFile(projectSettingsPath));
  const raw = merged.workspaceHistory;
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const storageDirValue = typeof config.storageDir === "string" && config.storageDir.trim().length > 0
    ? config.storageDir.trim()
    : path.join(getAgentDir(), "state", "workspace-history");

  const storageDir = path.resolve(expandHome(storageDirValue));

  return {
    enabled: normalizeEnabled(config.enabled),
    allowHomeDirectory: config.allowHomeDirectory === true,
    requireProjectMarker: config.requireProjectMarker !== false,
    storageDir,
    maxSessionsPerWorkspace: normalizePositiveInteger(config.maxSessionsPerWorkspace, DEFAULT_MAX_SESSIONS_PER_WORKSPACE),
    maxWorkspaces: normalizePositiveInteger(config.maxWorkspaces, DEFAULT_MAX_WORKSPACES),
    maxScanFiles: normalizePositiveInteger(config.maxScanFiles, DEFAULT_MAX_SCAN_FILES),
    maxScanDirs: normalizePositiveInteger(config.maxScanDirs, DEFAULT_MAX_SCAN_DIRS),
    maxScanMs: normalizeTimeoutMs(config.maxScanMs, DEFAULT_MAX_SCAN_MS),
    gitTimeoutMs: normalizeTimeoutMs(config.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS),
  };
}

async function evaluateWorkspaceHistoryAvailability(ctx: ExtensionContext, state?: RuntimeState): Promise<WorkspaceHistoryAvailability> {
  const settings = await getWorkspaceHistorySettings(ctx, state);
  let availability: WorkspaceHistoryAvailability;

  if (await isStorageDirInsideWorkspace(ctx, settings.storageDir)) {
    availability = {
      enabled: false,
      reason: `workspaceHistory.storageDir must be outside the workspace (${settings.storageDir})`,
      unsafeStorageDir: true,
    };
  } else if (settings.enabled === false) {
    availability = { enabled: false, reason: "disabled by configuration" };
  } else if (await isInsideJujutsuMetadata(ctx.cwd)) {
    availability = { enabled: false, reason: "current directory is inside Jujutsu metadata" };
  } else if (settings.enabled === true) {
    availability = { enabled: true };
  } else {
    const resolvedCwd = await realpath(ctx.cwd).catch(() => path.resolve(ctx.cwd));
    const normalizedCwd = path.normalize(resolvedCwd);
    const home = path.normalize(homedir());
    const root = path.normalize(path.parse(normalizedCwd).root);

    if (!settings.allowHomeDirectory && normalizedCwd === home) {
      availability = { enabled: false, reason: "current directory is the user home folder" };
    } else if (normalizedCwd === root) {
      availability = { enabled: false, reason: "current directory is a filesystem root" };
    } else if (settings.requireProjectMarker && !(await hasProjectMarker(resolvedCwd))) {
      availability = { enabled: false, reason: "no project marker found" };
    } else {
      availability = { enabled: true };
    }
  }

  return availability;
}

async function getWorkspaceHistorySettings(ctx: ExtensionContext, state?: RuntimeState): Promise<WorkspaceHistorySettings> {
  if (state?.cachedSettings) {
    return state.cachedSettings;
  }
  const settings = await loadWorkspaceHistorySettings(ctx);
  if (state) {
    state.cachedSettings = settings;
  }
  return settings;
}

async function buildWorkspaceStoragePaths(ctx: ExtensionContext, settings: WorkspaceHistorySettings): Promise<WorkspaceStoragePaths> {
  const resolvedRealpath = await realpath(ctx.cwd).catch(() => path.resolve(ctx.cwd));
  const normalizedRealpath = path.normalize(resolvedRealpath);
  const workspaceHash = createHash("sha256").update(normalizedRealpath).digest("hex").slice(0, 24);
  const workspaceRoot = path.join(settings.storageDir, "workspaces", workspaceHash);
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionRoot = path.join(workspaceRoot, "sessions", sessionId);

  return {
    storageDir: settings.storageDir,
    workspaceHash,
    workspaceRoot,
    sessionsRoot: path.join(workspaceRoot, "sessions"),
    reusableGitDir: path.join(workspaceRoot, "repo.git"),
    sessionRoot,
    shadowGitDir: path.join(sessionRoot, "repo.git"),
    redoFile: path.join(sessionRoot, "redo.json"),
    recoveryFile: path.join(sessionRoot, "pending-recovery.json"),
    turnSnapshotsFile: path.join(sessionRoot, "turn-snapshots.json"),
    sessionLeaseFile: path.join(sessionRoot, ACTIVE_SESSION_LEASE_FILE),
    workspaceMetaFile: path.join(workspaceRoot, "meta.json"),
    sessionMetaFile: path.join(sessionRoot, "meta.json"),
    logFile: path.join(settings.storageDir, "logs", "timemachine.log"),
  };
}

async function getWorkspaceStoragePaths(ctx: ExtensionContext, state?: RuntimeState): Promise<WorkspaceStoragePaths> {
  if (state?.cachedPaths) {
    return state.cachedPaths;
  }
  const settings = await getWorkspaceHistorySettings(ctx, state);
  const paths = await buildWorkspaceStoragePaths(ctx, settings);
  if (state) {
    state.cachedPaths = paths;
  }
  return paths;
}

async function ensureStorageDirs(ctx: ExtensionContext, state?: RuntimeState): Promise<WorkspaceStoragePaths> {
  const paths = await getWorkspaceStoragePaths(ctx, state);
  if (await isStorageDirInsideWorkspace(ctx, paths.storageDir)) {
    throw new Error(`workspaceHistory.storageDir must be outside the workspace (${paths.storageDir})`);
  }
  await mkdir(path.dirname(paths.logFile), { recursive: true });
  await mkdir(paths.sessionRoot, { recursive: true });
  return paths;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryFile = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryFile, filePath);
  } finally {
    await unlink(temporaryFile).catch(() => undefined);
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function getGitTimeoutMs(ctx: ExtensionContext, state?: RuntimeState): Promise<number> {
  const settings = await getWorkspaceHistorySettings(ctx, state);
  return settings.gitTimeoutMs;
}

async function getScanBudget(ctx: ExtensionContext, state?: RuntimeState): Promise<{ maxFiles: number; maxDirs: number; maxMs: number }> {
  const settings = await getWorkspaceHistorySettings(ctx, state);
  return {
    maxFiles: settings.maxScanFiles,
    maxDirs: settings.maxScanDirs,
    maxMs: settings.maxScanMs,
  };
}

async function touchWorkspaceAndSessionMeta(ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const paths = await ensureStorageDirs(ctx, state);
  const now = new Date().toISOString();
  const resolvedRealpath = await realpath(ctx.cwd).catch(() => path.resolve(ctx.cwd));

  const workspaceMeta = (await readJsonFile<WorkspaceMeta>(paths.workspaceMetaFile)) ?? {
    version: 1 as const,
    workspaceHash: paths.workspaceHash,
    cwd: ctx.cwd,
    realpath: resolvedRealpath,
    createdAt: now,
    lastUsedAt: now,
  };
  workspaceMeta.cwd = ctx.cwd;
  workspaceMeta.realpath = resolvedRealpath;
  workspaceMeta.lastUsedAt = now;
  await writeJsonFile(paths.workspaceMetaFile, workspaceMeta);

  const sessionMeta = (await readJsonFile<SessionMeta>(paths.sessionMetaFile)) ?? {
    version: 1 as const,
    sessionId: ctx.sessionManager.getSessionId(),
    createdAt: now,
    lastUsedAt: now,
  };
  sessionMeta.lastUsedAt = now;
  await writeJsonFile(paths.sessionMetaFile, sessionMeta);
}

async function listSubdirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function isBareShadowGitDir(pi: ExtensionAPI, ctx: ExtensionContext, gitDir: string, state?: RuntimeState): Promise<boolean> {
  const result = await withTimeout(
    pi.exec("git", ["--git-dir", gitDir, "rev-parse", "--is-bare-repository"], { cwd: ctx.cwd }),
    await getGitTimeoutMs(ctx, state),
    "git shadow repo validation",
  );
  return result.code === 0 && result.stdout.trim() === "true";
}

async function isReusableShadowGitDir(pi: ExtensionAPI, ctx: ExtensionContext, gitDir: string, state?: RuntimeState): Promise<boolean> {
  if (!await isBareShadowGitDir(pi, ctx, gitDir, state)) {
    return false;
  }
  const result = await withTimeout(
    pi.exec("git", ["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: ctx.cwd }),
    await getGitTimeoutMs(ctx, state),
    "git reusable shadow repo validation",
  );
  return result.code === 0;
}

function clearShadowRepoRuntimeCaches(state?: RuntimeState): void {
  if (!state) {
    return;
  }
  state.validatedShadowGitDir = undefined;
  state.lastKnownShadowHead = undefined;
  state.initialSnapshotCommit = undefined;
  state.warmedBaselineCommit = undefined;
  state.cachedExcludeSource = undefined;
  state.lastIndexPruneIgnoreSource = undefined;
  state.lastExcludedWorkspacePaths = undefined;
  state.warnedMissingSnapshotCommits = undefined;
}

async function quarantineInvalidShadowGitDir(ctx: ExtensionContext, gitDir: string, state?: RuntimeState): Promise<string> {
  const quarantineDir = `${gitDir}.invalid-${Date.now()}-${randomUUID()}`;
  try {
    await rename(gitDir, quarantineDir);
  } catch (error) {
    throw new Error(`Unable to preserve invalid shadow repository at ${gitDir}: ${String(error)}`, { cause: error });
  }
  await logLine(ctx, `quarantine invalid repo from=${gitDir} to=${quarantineDir}`, state);
  return quarantineDir;
}

function notifyInvalidShadowRepoRecovery(ctx: ExtensionContext, state: RuntimeState | undefined, recoveredInCurrentCall: boolean): void {
  if (!recoveredInCurrentCall && !state?.invalidShadowRepoRecoveryPending) {
    return;
  }
  if (!state?.invalidShadowRepoNoticeShown) {
    ctx.ui.notify(
      "Workspace history found a missing or invalid snapshot repository and rebuilt it. Older snapshots from this session may be unavailable.",
      "warning",
    );
  }
  if (state) {
    state.invalidShadowRepoNoticeShown = true;
    state.invalidShadowRepoRecoveryPending = false;
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidMetaTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isValidSessionMeta(value: unknown, sessionId: string): value is SessionMeta {
  return isJsonRecord(value)
    && value.version === 1
    && value.sessionId === sessionId
    && isValidMetaTimestamp(value.createdAt)
    && isValidMetaTimestamp(value.lastUsedAt);
}

function isValidSessionLease(value: unknown, sessionId: string): value is SessionLease {
  return isJsonRecord(value)
    && value.version === 1
    && value.sessionId === sessionId
    && typeof value.ownerId === "string"
    && value.ownerId.length > 0
    && typeof value.processId === "number"
    && Number.isInteger(value.processId)
    && value.processId > 0
    && isValidMetaTimestamp(value.createdAt);
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireSessionLease(ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const paths = await ensureStorageDirs(ctx, state);
  const ownerId = randomUUID();
  await writeJsonFileAtomically(paths.sessionLeaseFile, {
    version: 1,
    sessionId: ctx.sessionManager.getSessionId(),
    ownerId,
    processId: process.pid,
    createdAt: new Date().toISOString(),
  } satisfies SessionLease);
  if (state) {
    state.sessionLeaseOwnerId = ownerId;
  }
}

async function releaseSessionLease(ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const ownerId = state?.sessionLeaseOwnerId;
  if (!ownerId) {
    return;
  }
  const paths = await getWorkspaceStoragePaths(ctx, state);
  const lease = await readJsonFile<unknown>(paths.sessionLeaseFile);
  if (isValidSessionLease(lease, ctx.sessionManager.getSessionId()) && lease.ownerId === ownerId) {
    await unlink(paths.sessionLeaseFile).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
  }
  state.sessionLeaseOwnerId = undefined;
}

async function hasActiveSessionLease(sessionRoot: string, sessionId: string): Promise<boolean> {
  const lease = await readJsonFile<unknown>(path.join(sessionRoot, ACTIVE_SESSION_LEASE_FILE));
  return isValidSessionLease(lease, sessionId) && isProcessRunning(lease.processId);
}

async function hasActiveWorkspaceSession(workspaceRoot: string): Promise<boolean> {
  const sessionsRoot = path.join(workspaceRoot, "sessions");
  const sessionIds = await listSubdirectories(sessionsRoot);
  const activeLeases = await Promise.all(sessionIds.map((sessionId) => {
    return hasActiveSessionLease(path.join(sessionsRoot, sessionId), sessionId);
  }));
  return activeLeases.some(Boolean);
}

function isValidWorkspaceMeta(value: unknown, workspaceHash: string): value is WorkspaceMeta {
  return isJsonRecord(value)
    && value.version === 1
    && value.workspaceHash === workspaceHash
    && typeof value.cwd === "string"
    && value.cwd.length > 0
    && typeof value.realpath === "string"
    && value.realpath.length > 0
    && isValidMetaTimestamp(value.createdAt)
    && isValidMetaTimestamp(value.lastUsedAt);
}

async function findReusableShadowGitDir(pi: ExtensionAPI, ctx: ExtensionContext, state?: RuntimeState): Promise<{ gitDir: string; shared: boolean } | undefined> {
  const paths = await ensureStorageDirs(ctx, state);
  const currentSessionId = ctx.sessionManager.getSessionId();
  if (await exists(paths.reusableGitDir) && !await exists(path.join(paths.reusableGitDir, "index.lock"))) {
    if (await isReusableShadowGitDir(pi, ctx, paths.reusableGitDir, state)) {
      await logLine(ctx, `reuse workspace repo candidate gitDir=${paths.reusableGitDir}`, state);
      return { gitDir: paths.reusableGitDir, shared: true };
    }
    await quarantineInvalidShadowGitDir(ctx, paths.reusableGitDir, state);
  }

  const sessionIds = await listSubdirectories(paths.sessionsRoot);
  const candidates = await Promise.all(sessionIds
    .filter((sessionId) => sessionId !== currentSessionId)
    .map(async (sessionId) => {
      const sessionRoot = path.join(paths.sessionsRoot, sessionId);
      const gitDir = path.join(sessionRoot, "repo.git");
      const meta = await readJsonFile<SessionMeta>(path.join(sessionRoot, "meta.json"));
      return {
        gitDir,
        lastUsedAt: meta?.lastUsedAt ?? meta?.createdAt ?? "",
      };
    }));

  for (const candidate of candidates.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))) {
    if (!await exists(candidate.gitDir) || await exists(path.join(candidate.gitDir, "index.lock"))) {
      continue;
    }
    if (!await isReusableShadowGitDir(pi, ctx, candidate.gitDir, state)) {
      await logLine(ctx, `skip invalid session repo candidate gitDir=${candidate.gitDir}`, state);
      continue;
    }
    await logLine(ctx, `reuse session repo candidate gitDir=${candidate.gitDir}`, state);
    return { gitDir: candidate.gitDir, shared: false };
  }

  await logLine(ctx, `reuse repo unavailable workspaceGitDir=${paths.reusableGitDir} sessionCandidates=${candidates.length}`, state);
  return undefined;
}

async function updateReusableShadowRepo(pi: ExtensionAPI, ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const paths = await ensureStorageDirs(ctx, state);
  if (!await exists(paths.shadowGitDir) || await exists(path.join(paths.shadowGitDir, "index.lock"))) {
    return;
  }

  if (await exists(paths.reusableGitDir) && !await isReusableShadowGitDir(pi, ctx, paths.reusableGitDir, state)) {
    await quarantineInvalidShadowGitDir(ctx, paths.reusableGitDir, state);
  }

  if (!await exists(paths.reusableGitDir)) {
    await execGit(pi, ctx, ["clone", "--bare", "--single-branch", "--no-tags", "--no-local", paths.shadowGitDir, paths.reusableGitDir]);
    await logLine(ctx, `update reusable repo cloned from=${paths.shadowGitDir} to=${paths.reusableGitDir}`, state);
    return;
  }

  const reusableHeadRef = await execGit(pi, ctx, ["--git-dir", paths.reusableGitDir, "symbolic-ref", "HEAD"]);
  await execGit(pi, ctx, ["--git-dir", paths.reusableGitDir, "fetch", "--no-tags", paths.shadowGitDir, `+HEAD:${reusableHeadRef}`]);
  await logLine(ctx, `update reusable repo fetched from=${paths.shadowGitDir} to=${paths.reusableGitDir}`, state);
}

function scheduleReusableShadowRepoUpdate(pi: ExtensionAPI, ctx: ExtensionContext, state?: RuntimeState): void {
  if (!state || state.reusableRepoUpdatePromise) {
    return;
  }
  state.reusableRepoUpdatePromise = Promise.resolve().then(async () => {
    await updateReusableShadowRepo(pi, ctx, state);
  }).catch((error) => {
    void logLine(ctx, `update reusable repo failed error=${String(error)}`, state);
    if (!state.reusableRepoFailureNoticeShown) {
      try {
        ctx.ui.notify(
          `Workspace history could not refresh its reusable snapshot repository: ${String(error)} Session snapshots remain available.`,
          "warning",
        );
      } catch {
        // The originating extension context may have been replaced before this background update settled.
      }
      state.reusableRepoFailureNoticeShown = true;
    }
  }).finally(() => {
    state.reusableRepoUpdatePromise = undefined;
  });
}

async function cleanupWorkspaceHistory(ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const settings = await getWorkspaceHistorySettings(ctx, state);
  const paths = await ensureStorageDirs(ctx, state);
  const currentSessionId = ctx.sessionManager.getSessionId();

  const sessionIds = await listSubdirectories(paths.sessionsRoot);
  const sessionRecords = (await Promise.all(sessionIds.map(async (sessionId) => {
    const sessionRoot = path.join(paths.sessionsRoot, sessionId);
    const meta = await readJsonFile<unknown>(path.join(sessionRoot, "meta.json"));
    return isValidSessionMeta(meta, sessionId)
      ? {
        sessionId,
        sessionRoot,
        lastUsedAt: meta.lastUsedAt,
        active: sessionId === currentSessionId || await hasActiveSessionLease(sessionRoot, sessionId),
      }
      : undefined;
  }))).filter((record): record is NonNullable<typeof record> => record !== undefined);

  const activeSessionCount = sessionRecords.filter((record) => record.active).length;
  const removableSessions = sessionRecords
    .filter((record) => !record.active)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));

  const inactiveSessionCapacity = Math.max(0, settings.maxSessionsPerWorkspace - activeSessionCount);
  for (const record of removableSessions.slice(inactiveSessionCapacity)) {
    try {
      if (await hasActiveSessionLease(record.sessionRoot, record.sessionId)) {
        await logLine(ctx, `cleanup session skipped after lease recheck sessionId=${record.sessionId}`, state);
        continue;
      }
      await fsRm(record.sessionRoot, { recursive: true, force: true });
    } catch (error) {
      await logLine(
        ctx,
        `cleanup session failed sessionId=${record.sessionId} path=${record.sessionRoot} error=${String(error)}`,
        state,
        true,
      ).catch(() => undefined);
    }
  }

  const workspacesRoot = path.join(paths.storageDir, "workspaces");
  const workspaceIds = await listSubdirectories(workspacesRoot);
  const workspaceRecords = (await Promise.all(workspaceIds.map(async (workspaceId) => {
    const workspaceRoot = path.join(workspacesRoot, workspaceId);
    const meta = await readJsonFile<unknown>(path.join(workspaceRoot, "meta.json"));
    return isValidWorkspaceMeta(meta, workspaceId)
      ? {
        workspaceId,
        workspaceRoot,
        lastUsedAt: meta.lastUsedAt,
        active: workspaceId === paths.workspaceHash || await hasActiveWorkspaceSession(workspaceRoot),
      }
      : undefined;
  }))).filter((record): record is NonNullable<typeof record> => record !== undefined);

  const activeWorkspaceCount = workspaceRecords.filter((record) => record.active).length;
  const removableWorkspaces = workspaceRecords
    .filter((record) => !record.active)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));

  const inactiveWorkspaceCapacity = Math.max(0, settings.maxWorkspaces - activeWorkspaceCount);
  for (const record of removableWorkspaces.slice(inactiveWorkspaceCapacity)) {
    try {
      if (await hasActiveWorkspaceSession(record.workspaceRoot)) {
        await logLine(ctx, `cleanup workspace skipped after lease recheck workspaceId=${record.workspaceId}`, state);
        continue;
      }
      await fsRm(record.workspaceRoot, { recursive: true, force: true });
    } catch (error) {
      await logLine(
        ctx,
        `cleanup workspace failed workspaceId=${record.workspaceId} path=${record.workspaceRoot} error=${String(error)}`,
        state,
        true,
      ).catch(() => undefined);
    }
  }
}

function normalizeSnapshotPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isWindowsReservedSnapshotPath(relativePath: string): boolean {
  const normalized = normalizeSnapshotPath(relativePath);
  return normalized
    .split("/")
    .some((segment) => {
      const trimmed = segment.trim().replace(/[. ]+$/g, "");
      const base = trimmed.split(".", 1)[0]?.toLowerCase() ?? "";
      return WINDOWS_RESERVED_BASENAMES.has(base);
    });
}

function getWindowsReservedIgnorePatterns(): string[] {
  const patterns: string[] = [];
  for (const base of WINDOWS_RESERVED_BASENAMES) {
    patterns.push(base, `${base}.*`);
  }
  return patterns;
}

async function getSnapshotIgnoreMatcher(ctx: ExtensionContext, state?: RuntimeState): Promise<Ignore> {
  const gitignorePath = path.join(ctx.cwd, ".gitignore");
  const gitignoreSource = await readFile(gitignorePath, "utf8").catch(() => "");

  if (state?.cachedSnapshotIgnoreMatcher && state.cachedGitignoreSource === gitignoreSource) {
    return state.cachedSnapshotIgnoreMatcher;
  }

  const matcher = ignore();
  if (gitignoreSource.trim().length > 0) {
    matcher.add(gitignoreSource);
  }

  if (state) {
    state.cachedGitignoreSource = gitignoreSource;
    state.cachedSnapshotIgnoreMatcher = matcher;
  }

  return matcher;
}

function getHardExcludeMatcher(state?: RuntimeState): Ignore {
  if (state?.cachedHardExcludeMatcher) {
    return state.cachedHardExcludeMatcher;
  }
  const matcher = ignore().add(DEFAULT_EXCLUDES);
  if (state) {
    state.cachedHardExcludeMatcher = matcher;
  }
  return matcher;
}

async function isSnapshotPathExcluded(
  ctx: ExtensionContext,
  relativePath: string,
  state?: RuntimeState,
): Promise<boolean> {
  const normalizedPath = normalizeSnapshotPath(relativePath);
  if (isWindowsReservedSnapshotPath(normalizedPath) || getHardExcludeMatcher(state).ignores(normalizedPath)) {
    return true;
  }
  return (await getSnapshotIgnoreMatcher(ctx, state)).ignores(normalizedPath);
}

async function filterSnapshotPaths(
  ctx: ExtensionContext,
  relativePaths: string[],
  state?: RuntimeState,
): Promise<string[]> {
  const includedPaths: string[] = [];
  for (const relativePath of relativePaths) {
    if (!await isSnapshotPathExcluded(ctx, relativePath, state)) {
      includedPaths.push(relativePath);
    }
  }
  return includedPaths;
}

async function listExcludedWorkspacePaths(ctx: ExtensionContext, state?: RuntimeState): Promise<string[]> {
  const budget = await getScanBudget(ctx, state);
  const startedAt = Date.now();
  let scannedFiles = 0;
  let scannedDirs = 0;
  const excludedPaths: string[] = [];

  function checkBudget(relativePath: string): void {
    if (Date.now() - startedAt > budget.maxMs) {
      throw new Error(`workspace scan exceeded ${budget.maxMs}ms while scanning ${relativePath || "."}`);
    }
    if (scannedFiles > budget.maxFiles) {
      throw new Error(`workspace scan exceeded ${budget.maxFiles} files`);
    }
    if (scannedDirs > budget.maxDirs) {
      throw new Error(`workspace scan exceeded ${budget.maxDirs} directories`);
    }
  }

  async function walk(relativeDir = ""): Promise<void> {
    scannedDirs += 1;
    checkBudget(relativeDir);
    const absoluteDir = relativeDir.length > 0 ? path.join(ctx.cwd, relativeDir) : ctx.cwd;
    const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const relativePath = relativeDir.length > 0 ? path.join(relativeDir, entry.name) : entry.name;
      if (!entry.isDirectory()) {
        scannedFiles += 1;
      }
      checkBudget(relativePath);
      if (await isSnapshotPathExcluded(ctx, relativePath, state)) {
        excludedPaths.push(relativePath);
        continue;
      }

      if (entry.isDirectory()) {
        await walk(relativePath);
      }
    }
  }

  await walk();
  return excludedPaths;
}

function parseNullSeparatedPaths(raw: string): string[] {
  return raw
    .split("\0")
    .filter((line) => line.length > 0);
}

async function logLine(
  ctx: ExtensionContext,
  line: string,
  state?: RuntimeState,
  required = false,
): Promise<void> {
  if (!required && !isWorkspaceHistoryLoggingEnabled()) {
    return;
  }

  const settings = await getWorkspaceHistorySettings(ctx, state);
  if (await isStorageDirInsideWorkspace(ctx, settings.storageDir)) {
    return;
  }

  const paths = await ensureStorageDirs(ctx, state);
  await appendFile(paths.logFile, `[${new Date().toISOString()}] ${line}\n`, "utf8");
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function isWorkspaceHistoryLoggingEnabled(): boolean {
  const value = process.env[WORKSPACE_HISTORY_LOG_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function summarizeGitArgs(args: string[]): string {
  const gitDirIndex = args.indexOf("--git-dir");
  const workTreeIndex = args.indexOf("--work-tree");
  if (gitDirIndex >= 0 && workTreeIndex >= 0) {
    return [
      ...args.slice(0, gitDirIndex),
      "--git-dir",
      "<shadowGitDir>",
      "--work-tree",
      "<workspace>",
      ...args.slice(workTreeIndex + 2),
    ].join(" ");
  }
  return args.join(" ");
}

async function syncShadowRepoExclude(ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const paths = await ensureStorageDirs(ctx, state);
  const gitignoreSource = await readFile(path.join(ctx.cwd, ".gitignore"), "utf8").catch(() => "");
  const excludePath = path.join(paths.shadowGitDir, "info", "exclude");
  const excludeSource = [
    gitignoreSource.trim().length > 0 ? gitignoreSource.trimEnd() : "",
    ...DEFAULT_EXCLUDES.map(normalizeSnapshotPath),
    ...getWindowsReservedIgnorePatterns(),
  ]
    .filter((part) => part.length > 0)
    .join("\n");

  if (state?.cachedExcludeSource === excludeSource) {
    return;
  }

  await mkdir(path.dirname(excludePath), { recursive: true });
  await writeFile(excludePath, `${excludeSource}\n`, "utf8");
  if (state) {
    state.cachedExcludeSource = excludeSource;
  }
}

function parsePorcelainStatusPaths(raw: string): string[] {
  const records = raw.split("\0").filter((record) => record.length > 0);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status[0] === "R" || status[0] === "C") {
      const sourcePath = records[index + 1];
      if (sourcePath) {
        paths.push(sourcePath);
        index += 1;
      }
    }
  }
  return paths;
}

function getGitRestoreFileOperationFailureDetail(value: unknown): string | undefined {
  return String(value).match(
    /(?:(?:error|warning|fatal):\s*)?(?:unable to unlink(?: old)?|failed to remove|could not reset index file)[^\r\n;]*/i,
  )?.[0]?.trim();
}

async function execGit(pi: ExtensionAPI, ctx: ExtensionContext, args: string[]): Promise<string> {
  const state = undefined;
  const timeoutMs = await getGitTimeoutMs(ctx, state);
  const paths = await getWorkspaceStoragePaths(ctx, state);
  const usesShadowGitDir = args.includes("--git-dir") && args.includes(paths.shadowGitDir);
  const startedAt = Date.now();
  const runGit = () => withTimeout(pi.exec("git", args, { cwd: ctx.cwd }), timeoutMs, `git ${args[0] ?? "command"}`);
  if (usesShadowGitDir) {
    await logLine(ctx, `git start ${summarizeGitArgs(args)}`, state);
    await waitForShadowRepoIndexLock(ctx, state);
  }
  const result = await runGit();
  const successfulRestoreFailure = result.code === 0
    ? getGitRestoreFileOperationFailureDetail(result.stderr)
    : undefined;
  if (result.code !== 0 || successfulRestoreFailure) {
    const output = result.stderr || result.stdout;
    if (result.code !== 0 && usesShadowGitDir && output.includes("index.lock") && (await waitForShadowRepoIndexLock(ctx, state) || await clearStaleShadowRepoIndexLock(ctx, state))) {
      const retry = await runGit();
      const retryRestoreFailure = retry.code === 0
        ? getGitRestoreFileOperationFailureDetail(retry.stderr)
        : undefined;
      if (retry.code === 0 && !retryRestoreFailure) {
        await logLine(ctx, `git ok retry ${elapsedMs(startedAt)}ms ${summarizeGitArgs(args)}`, state).catch(() => undefined);
        return retry.stdout.trim();
      }
      throw new Error(`git ${args.join(" ")} failed after clearing stale index.lock: ${retry.stderr || retry.stdout}`);
    }
    const failureReason = successfulRestoreFailure ? "reported an incomplete workspace update" : "failed";
    throw new Error(`git ${args.join(" ")} ${failureReason}: ${output}`);
  }
  if (usesShadowGitDir) {
    await logLine(ctx, `git ok ${elapsedMs(startedAt)}ms ${summarizeGitArgs(args)}`, state).catch(() => undefined);
  }
  return result.stdout.trim();
}

function gitArgsForShadowGitDir(ctx: ExtensionContext, gitDir: string, ...args: string[]): string[] {
  return [
    "-c",
    "i18n.logOutputEncoding=utf-8",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "core.filemode=false",
    "-c",
    "core.quotepath=false",
    "--git-dir",
    gitDir,
    "--work-tree",
    ctx.cwd,
    ...args,
  ];
}

async function gitArgs(ctx: ExtensionContext, state: RuntimeState | undefined, ...args: string[]): Promise<string[]> {
  const paths = await getWorkspaceStoragePaths(ctx, state);
  return gitArgsForShadowGitDir(ctx, paths.shadowGitDir, ...args);
}

async function gitCommitArgs(ctx: ExtensionContext, state: RuntimeState | undefined, ...args: string[]): Promise<string[]> {
  return [
    "-c",
    "user.name=workspace-history",
    "-c",
    "user.email=workspace-history@local",
    ...(await gitArgs(ctx, state, ...args)),
  ];
}

async function runSerializedSnapshotWrite<T>(state: RuntimeState | undefined, operation: () => Promise<T>): Promise<T> {
  if (!state) {
    return operation();
  }

  const previous = state.snapshotWritePromise ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  state.snapshotWritePromise = next;

  try {
    return await next;
  } finally {
    if (state.snapshotWritePromise === next) {
      state.snapshotWritePromise = undefined;
    }
  }
}

async function removeExcludedPathsFromShadowIndex(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  excludedPaths: string[],
  state?: RuntimeState,
): Promise<void> {
  if (excludedPaths.length === 0) {
    return;
  }

  const paths = await getWorkspaceStoragePaths(ctx, state);
  const pathspecFile = path.join(paths.sessionRoot, `exclude-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    await writeFile(pathspecFile, Buffer.from(excludedPaths.join("\0") + "\0", "utf8"));
    await execGit(pi, ctx, [
      ...(await gitArgs(ctx, state, "rm", "-r", "--cached", "--ignore-unmatch", "--pathspec-from-file", pathspecFile, "--pathspec-file-nul")),
    ]);
  } finally {
    await unlink(pathspecFile).catch(() => undefined);
  }
}

async function pruneShadowIndexForIgnoreChanges(pi: ExtensionAPI, ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const startedAt = Date.now();
  const gitignoreSource = await readFile(path.join(ctx.cwd, ".gitignore"), "utf8").catch(() => "");
  const trackedOutput = await execGit(pi, ctx, await gitArgs(ctx, state, "ls-files", "-z"));
  const trackedPaths = parseNullSeparatedPaths(trackedOutput);
  const includedPaths = new Set(await filterSnapshotPaths(ctx, trackedPaths, state));
  const excludedPaths = trackedPaths.filter((relativePath) => !includedPaths.has(relativePath));
  await logLine(ctx, `prune ignored paths checked ${elapsedMs(startedAt)}ms count=${excludedPaths.length}`, state);
  await removeExcludedPathsFromShadowIndex(pi, ctx, excludedPaths, state);
  if (state) {
    state.lastIndexPruneIgnoreSource = gitignoreSource;
  }
  await logLine(ctx, `prune ignored paths done ${elapsedMs(startedAt)}ms count=${excludedPaths.length}`, state);
}


async function stageSnapshotFiles(pi: ExtensionAPI, ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const startedAt = Date.now();
  await logLine(ctx, "stage snapshot start", state);
  await execGit(pi, ctx, await gitArgs(ctx, state, "add", "-A", "--", "."));
  await logLine(ctx, `stage snapshot git-add done ${elapsedMs(startedAt)}ms`, state);
  await pruneShadowIndexForIgnoreChanges(pi, ctx, state);
  await logLine(ctx, `stage snapshot done ${elapsedMs(startedAt)}ms`, state);
}

async function hasWorkspaceChanges(pi: ExtensionAPI, ctx: ExtensionContext, state?: RuntimeState): Promise<boolean> {
  const startedAt = Date.now();
  await assertWorkspaceHistoryEnabled(ctx, state, "hasWorkspaceChanges");
  await ensureShadowRepo(pi, ctx, state);

  const statusResult = await withTimeout(
    pi.exec("git", await gitArgs(ctx, state, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."), { cwd: ctx.cwd }),
    await getGitTimeoutMs(ctx, state),
    "git status",
  );
  if (statusResult.code !== 0) {
    throw new Error(statusResult.stderr || statusResult.stdout || "git status failed");
  }

  const changedPaths = parsePorcelainStatusPaths(statusResult.stdout);
  const changed = (await filterSnapshotPaths(ctx, changedPaths, state)).length > 0;
  await logLine(ctx, `workspace changes check done ${elapsedMs(startedAt)}ms changed=${String(changed)}`, state);
  return changed;
}

async function getHeadCommit(pi: ExtensionAPI, ctx: ExtensionContext, state?: RuntimeState): Promise<string | undefined> {
  await assertWorkspaceHistoryEnabled(ctx, state, "getHeadCommit");
  await ensureShadowRepo(pi, ctx, state);
  const result = await withTimeout(
    pi.exec("git", await gitArgs(ctx, state, "rev-parse", "--verify", "HEAD"), { cwd: ctx.cwd }),
    await getGitTimeoutMs(ctx, state),
    "git rev-parse",
  );
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function buildShadowGitDir(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  targetGitDir: string,
  reusableGitDir: { gitDir: string; shared: boolean } | undefined,
  state?: RuntimeState,
): Promise<void> {
  const buildGitDir = path.join(path.dirname(targetGitDir), `.wh-${randomUUID().slice(0, 8)}`);
  try {
    if (reusableGitDir) {
      await execGit(pi, ctx, [
        "clone",
        ...(reusableGitDir.shared ? ["--shared"] : ["--no-local"]),
        "--bare",
        "--single-branch",
        "--no-tags",
        reusableGitDir.gitDir,
        buildGitDir,
      ]);
      await execGit(pi, ctx, gitArgsForShadowGitDir(ctx, buildGitDir, "read-tree", "HEAD"));
    } else {
      await execGit(pi, ctx, ["init", "--bare", buildGitDir]);
    }
    if (!await isBareShadowGitDir(pi, ctx, buildGitDir, state)) {
      throw new Error(`Git did not create a valid bare repository at ${buildGitDir}.`);
    }
    await rename(buildGitDir, targetGitDir);
  } catch (error) {
    throw new Error(
      `Unable to rebuild shadow repository at ${targetGitDir}: ${String(error)} Any partial repository remains at ${buildGitDir}.`,
      { cause: error },
    );
  }
}

async function ensureShadowRepo(pi: ExtensionAPI, ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const startedAt = Date.now();
  await assertWorkspaceHistoryEnabled(ctx, state, "ensureShadowRepo");
  const paths = await ensureStorageDirs(ctx, state);
  if (state?.validatedShadowGitDir === paths.shadowGitDir) {
    if (await exists(path.join(paths.shadowGitDir, "HEAD"))) {
      await syncShadowRepoExclude(ctx, state);
      notifyInvalidShadowRepoRecovery(ctx, state, false);
      await logLine(ctx, `ensure shadow repo cached done ${elapsedMs(startedAt)}ms`, state);
      return;
    }
    clearShadowRepoRuntimeCaches(state);
    state.invalidShadowRepoRecoveryPending = true;
    await logLine(ctx, `ensure shadow repo cached path missing gitDir=${paths.shadowGitDir}`, state, true);
  }

  let rebuiltInvalidRepo = false;
  if (await exists(paths.shadowGitDir)) {
    if (await isBareShadowGitDir(pi, ctx, paths.shadowGitDir, state)) {
      if (state) {
        state.validatedShadowGitDir = paths.shadowGitDir;
      }
      await syncShadowRepoExclude(ctx, state);
      notifyInvalidShadowRepoRecovery(ctx, state, false);
      await logLine(ctx, `ensure shadow repo existing done ${elapsedMs(startedAt)}ms`, state);
      return;
    }
    await quarantineInvalidShadowGitDir(ctx, paths.shadowGitDir, state);
    clearShadowRepoRuntimeCaches(state);
    if (state) {
      state.invalidShadowRepoRecoveryPending = true;
    }
    rebuiltInvalidRepo = true;
  }

  const reusableGitDir = await findReusableShadowGitDir(pi, ctx, state);
  await buildShadowGitDir(pi, ctx, paths.shadowGitDir, reusableGitDir, state);
  if (reusableGitDir) {
    await logLine(ctx, `clone repo session=${ctx.sessionManager.getSessionId()} shared=${String(reusableGitDir.shared)} from=${reusableGitDir.gitDir} gitDir=${paths.shadowGitDir}`, state);
  } else {
    await logLine(ctx, `init repo session=${ctx.sessionManager.getSessionId()} gitDir=${paths.shadowGitDir}`, state);
  }
  if (state) {
    state.validatedShadowGitDir = paths.shadowGitDir;
  }
  await syncShadowRepoExclude(ctx, state);
  notifyInvalidShadowRepoRecovery(ctx, state, rebuiltInvalidRepo);
  await logLine(ctx, `ensure shadow repo created done ${elapsedMs(startedAt)}ms`, state);
}

function isValidSnapshotCommit(commit: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(commit);
}

function getSnapshotRetentionRef(commit: string): string {
  if (!isValidSnapshotCommit(commit)) {
    throw new Error(`invalid snapshot commit: ${commit}`);
  }
  return `${SNAPSHOT_RETENTION_REF_PREFIX}/${commit.toLowerCase()}`;
}

async function isSnapshotCommitAvailable(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  commit: string,
  state?: RuntimeState,
): Promise<boolean> {
  await ensureShadowRepo(pi, ctx, state);
  const result = await withTimeout(
    pi.exec(
      "git",
      await gitArgs(ctx, state, "rev-parse", "--verify", "--quiet", `${commit}^{commit}`),
      { cwd: ctx.cwd },
    ),
    await getGitTimeoutMs(ctx, state),
    "git rev-parse snapshot commit",
  );
  if (result.code === 0) {
    return true;
  }
  if (result.code === 1) {
    return false;
  }
  throw new Error(result.stderr || result.stdout || "git rev-parse snapshot commit failed");
}

async function retainSnapshotCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  commit: string,
  state?: RuntimeState,
): Promise<void> {
  await execGit(pi, ctx, await gitArgs(ctx, state, "update-ref", getSnapshotRetentionRef(commit), commit));
}

async function warnMissingSnapshotCommit(
  ctx: ExtensionContext,
  commit: string,
  source: string,
  state?: RuntimeState,
): Promise<void> {
  if (!state) {
    await logLine(ctx, `snapshot commit missing source=${source} commit=${commit}`, state);
    return;
  }
  state.warnedMissingSnapshotCommits ??= new Set<string>();
  if (state.warnedMissingSnapshotCommits.has(commit)) {
    return;
  }
  state.warnedMissingSnapshotCommits.add(commit);
  await logLine(ctx, `snapshot commit missing source=${source} commit=${commit}`, state);
  ctx.ui.notify(
    "A previous workspace snapshot is unavailable. Workspace history will continue from the current state.",
    "warning",
  );
}

async function createSnapshotCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  label: string,
  state?: RuntimeState,
  assumeDirty = false,
): Promise<string> {
  return runSerializedSnapshotWrite(state, async () => {
    const startedAt = Date.now();
    await logLine(ctx, `snapshot commit start label=${label} assumeDirty=${String(assumeDirty)}`, state);
    await assertWorkspaceHistoryEnabled(ctx, state, "createSnapshotCommit");
    await ensureShadowRepo(pi, ctx, state);
    await pruneShadowIndexForIgnoreChanges(pi, ctx, state);
    if (!assumeDirty) {
      const currentHead = state?.lastKnownShadowHead ?? await getHeadCommit(pi, ctx, state);
      if (state && currentHead) {
        state.lastKnownShadowHead = currentHead;
      }
      if (currentHead && !await hasWorkspaceChanges(pi, ctx, state)) {
        await retainSnapshotCommit(pi, ctx, currentHead, state);
        await touchWorkspaceAndSessionMeta(ctx, state);
        scheduleCleanup(ctx, state);
        await logLine(ctx, `snapshot commit reused label=${label} commit=${currentHead} ${elapsedMs(startedAt)}ms`, state);
        return currentHead;
      }
    }
    await stageSnapshotFiles(pi, ctx, state);
    await execGit(pi, ctx, [...(await gitCommitArgs(ctx, state, "commit", "--allow-empty", "-m", `[workspace-history] ${label}`))]);
    const commit = await execGit(pi, ctx, await gitArgs(ctx, state, "rev-parse", "HEAD"));
    await retainSnapshotCommit(pi, ctx, commit, state);
    await touchWorkspaceAndSessionMeta(ctx, state);
    if (!label.startsWith("after ")) {
      scheduleReusableShadowRepoUpdate(pi, ctx, state);
    }
    scheduleCleanup(ctx, state);
    if (state) {
      state.lastKnownShadowHead = commit;
    }
    await logLine(ctx, `snapshot commit created label=${label} commit=${commit} ${elapsedMs(startedAt)}ms`, state);
    return commit;
  });
}

async function restoreSnapshotCommit(pi: ExtensionAPI, ctx: ExtensionContext, commit: string, state?: RuntimeState): Promise<string> {
  await assertWorkspaceHistoryEnabled(ctx, state, "restoreSnapshotCommit");
  await ensureShadowRepo(pi, ctx, state);
  const protectedPaths = await listExcludedWorkspacePaths(ctx, state);

  await execGit(pi, ctx, await gitArgs(ctx, state, "reset", "--mixed", "--no-refresh", commit));
  await pruneShadowIndexForIgnoreChanges(pi, ctx, state);
  await execGit(pi, ctx, await gitArgs(ctx, state, "checkout-index", "-a", "-f"));
  await execGit(
    pi,
    ctx,
    await gitArgs(
      ctx,
      state,
      "clean",
      "-fd",
      ...protectedPaths.flatMap((relativePath) => ["-e", normalizeSnapshotPath(relativePath)]),
      "--",
      ".",
    ),
  );

  const targetTree = await execGit(pi, ctx, await gitArgs(ctx, state, "rev-parse", `${commit}^{tree}`));
  const filteredTree = await execGit(pi, ctx, await gitArgs(ctx, state, "write-tree"));
  let restoredCommit = commit;
  if (filteredTree !== targetTree) {
    await execGit(
      pi,
      ctx,
      await gitCommitArgs(ctx, state, "commit", "--allow-empty", "-m", `[workspace-history] filtered restore ${commit}`),
    );
    restoredCommit = await execGit(pi, ctx, await gitArgs(ctx, state, "rev-parse", "HEAD"));
    await retainSnapshotCommit(pi, ctx, restoredCommit, state);
  }
  if (state) {
    state.lastKnownShadowHead = restoredCommit;
    state.lastExcludedWorkspacePaths = protectedPaths;
  }
  return restoredCommit;
}

function isTransientWindowsRestoreError(error: unknown): boolean {
  return process.platform === "win32" && getGitRestoreFileOperationFailureDetail(error) !== undefined;
}

async function restoreSnapshotCommitWithRetry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  commit: string,
  state?: RuntimeState,
): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await restoreSnapshotCommit(pi, ctx, commit, state);
    } catch (error) {
      const delayMs = RESTORE_FILE_LOCK_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isTransientWindowsRestoreError(error)) {
        throw error;
      }
      await logLine(
        ctx,
        `restore retry commit=${commit} attempt=${attempt + 2} delayMs=${delayMs} error=${String(error)}`,
        state,
      ).catch(() => undefined);
      await sleep(delayMs);
    }
  }
}

async function realignShadowRepoAfterFailedRollback(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  commit: string,
  state?: RuntimeState,
): Promise<void> {
  await execGit(pi, ctx, await gitArgs(ctx, state, "reset", "--mixed", "--no-refresh", commit));
  if (state) {
    state.lastKnownShadowHead = commit;
  }
}

async function captureManagedWorkspaceTree(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  commit: string,
  state?: RuntimeState,
): Promise<string> {
  try {
    await stageSnapshotFiles(pi, ctx, state);
    return await execGit(pi, ctx, await gitArgs(ctx, state, "write-tree"));
  } finally {
    await realignShadowRepoAfterFailedRollback(pi, ctx, commit, state);
  }
}

function isPendingRecoveryState(value: unknown): value is PendingRecoveryState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PendingRecoveryState>;
  return candidate.version === 1 &&
    typeof candidate.commit === "string" &&
    isValidSnapshotCommit(candidate.commit) &&
    typeof candidate.workspaceTree === "string" &&
    isValidSnapshotCommit(candidate.workspaceTree) &&
    typeof candidate.createdAt === "string";
}

async function readPendingRecoveryState(ctx: ExtensionContext, state?: RuntimeState): Promise<PendingRecoveryState | undefined> {
  const paths = await getWorkspaceStoragePaths(ctx, state);
  const recovery = await readJsonFile<unknown>(paths.recoveryFile);
  return isPendingRecoveryState(recovery) ? recovery : undefined;
}

async function writePendingRecoveryState(
  ctx: ExtensionContext,
  recovery: PendingRecoveryState,
  state?: RuntimeState,
): Promise<void> {
  if (state) {
    state.pendingRecovery = recovery;
  }
  const paths = await ensureStorageDirs(ctx, state);
  await writeJsonFile(paths.recoveryFile, recovery);
}

async function clearPendingRecoveryState(ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const paths = await getWorkspaceStoragePaths(ctx, state);
  try {
    await unlink(paths.recoveryFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (state) {
    state.pendingRecovery = undefined;
  }
}

async function restoreSnapshotCommitSafely(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  targetCommit: string,
  state?: RuntimeState,
): Promise<string> {
  await assertWorkspaceHistoryEnabled(ctx, state, "restoreSnapshotCommitSafely");
  const rollbackCommit = await createSnapshotCommit(pi, ctx, `rollback ${randomUUID()}`, state);

  try {
    const restoredCommit = await restoreSnapshotCommitWithRetry(pi, ctx, targetCommit, state);
    await touchWorkspaceAndSessionMeta(ctx, state);
    scheduleCleanup(ctx, state);
    return restoredCommit;
  } catch (error) {
    try {
      await restoreSnapshotCommitWithRetry(pi, ctx, rollbackCommit, state);
    } catch (rollbackError) {
      try {
        await realignShadowRepoAfterFailedRollback(pi, ctx, rollbackCommit, state);
      } catch (realignError) {
        throw new Error(
          `restore failed: ${String(error)}; rollback failed: ${String(rollbackError)}; shadow realignment failed: ${String(realignError)}`,
        );
      }
      try {
        const recovery: PendingRecoveryState = {
          version: 1,
          commit: rollbackCommit,
          workspaceTree: await captureManagedWorkspaceTree(pi, ctx, rollbackCommit, state),
          createdAt: new Date().toISOString(),
        };
        await writePendingRecoveryState(ctx, recovery, state);
      } catch (recoveryStateError) {
        throw new Error(
          `restore failed: ${String(error)}; rollback failed: ${String(rollbackError)}; recovery state failed: ${String(recoveryStateError)}`,
        );
      }
      throw new Error(
        `restore failed: ${String(error)}; rollback failed: ${String(rollbackError)}`,
      );
    }
    throw error;
  }
}

function getRestoreFailureNotification(error: unknown): string {
  const detail = getGitRestoreFileOperationFailureDetail(error);
  if (!detail) {
    return "Workspace restore failed. Tree navigation cancelled.";
  }
  return `Workspace restore failed. Tree navigation cancelled. Git: ${detail}. Close any program using this file, then retry.`;
}

class PendingRecoveryWorkspaceChangedError extends Error {
  constructor() {
    super("workspace changed after an incomplete restore");
    this.name = "PendingRecoveryWorkspaceChangedError";
  }
}

async function recoverPendingWorkspace(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState | undefined,
): Promise<void> {
  const recovery = state?.pendingRecovery;
  if (!recovery) {
    return;
  }
  if (state.pendingRecoveryPromise) {
    await state.pendingRecoveryPromise;
    return;
  }

  const recoveryPromise = (async () => {
    await logLine(ctx, `pending workspace recovery start commit=${recovery.commit}`, state);
    const currentTree = await captureManagedWorkspaceTree(pi, ctx, recovery.commit, state);
    if (currentTree !== recovery.workspaceTree) {
      throw new PendingRecoveryWorkspaceChangedError();
    }
    await restoreSnapshotCommitWithRetry(pi, ctx, recovery.commit, state);
    await clearPendingRecoveryState(ctx, state);
    await touchWorkspaceAndSessionMeta(ctx, state);
    scheduleCleanup(ctx, state);
    await logLine(ctx, `pending workspace recovery done commit=${recovery.commit}`, state);
  })();
  state.pendingRecoveryPromise = recoveryPromise;
  try {
    await recoveryPromise;
  } finally {
    if (state.pendingRecoveryPromise === recoveryPromise) {
      state.pendingRecoveryPromise = undefined;
    }
  }
}

async function tryRecoverPendingWorkspace(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState | undefined,
  action: string,
  preserveChangedWorkspace = false,
): Promise<boolean> {
  try {
    await recoverPendingWorkspace(pi, ctx, state);
    return true;
  } catch (error) {
    await logLine(ctx, `pending workspace recovery failed action=${action} error=${String(error)}`, state).catch(() => undefined);
    if (error instanceof PendingRecoveryWorkspaceChangedError) {
      if (preserveChangedWorkspace) {
        try {
          await clearPendingRecoveryState(ctx, state);
          await logLine(ctx, `pending workspace recovery preserved by checkpoint action=${action}`, state);
          return true;
        } catch (clearError) {
          await logLine(ctx, `pending workspace recovery clear failed action=${action} error=${String(clearError)}`, state).catch(() => undefined);
        }
      }
      ctx.ui.notify(
        "The workspace changed after an incomplete restore. Run /checkpoint to preserve those changes before switching.",
        "error",
      );
      return false;
    }
    const detail = getGitRestoreFileOperationFailureDetail(error);
    const message = detail
      ? `Workspace recovery failed. ${action} cancelled. Git: ${detail}. Close any program using this file, then retry.`
      : `Workspace recovery failed. ${action} cancelled.`;
    ctx.ui.notify(message, "error");
    return false;
  }
}

async function readRedoState(ctx: ExtensionContext, state?: RuntimeState): Promise<RedoState | undefined> {
  const paths = await getWorkspaceStoragePaths(ctx, state);
  return readJsonFile<RedoState>(paths.redoFile);
}

async function writeRedoState(ctx: ExtensionContext, redoState: RedoState, state?: RuntimeState): Promise<void> {
  const paths = await ensureStorageDirs(ctx, state);
  await writeFile(paths.redoFile, `${JSON.stringify(redoState, null, 2)}\n`, "utf8");
}

export function rebuildTurnSnapshotsFromLegacyEntries(ctx: ExtensionContext): TurnSnapshotState {
  const turns: TurnSnapshotRecord[] = [];
  for (const entry of getSnapshotEntries(ctx)) {
    if (!hasSnapshotData(entry) || entry.data.kind !== "after") {
      continue;
    }

    const userEntryId = entry.data.userEntryId;
    const assistantEntryId = entry.data.assistantEntryId ?? entry.data.resultLeafId;
    const beforeCommit = getSnapshotCommit(findSnapshotById(ctx, entry.data.beforeSnapshotId));
    if (!userEntryId || !assistantEntryId || !beforeCommit) {
      continue;
    }

    turns.push({
      turnId: entry.data.turnId ?? entry.id,
      promptText: entry.data.promptText,
      userEntryId,
      assistantEntryId,
      beforeCommit,
      afterCommit: entry.data.commit,
      createdAt: entry.data.createdAt,
    });
  }

  turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { version: 1, turns };
}

async function readTurnSnapshotState(ctx: ExtensionContext, state?: RuntimeState): Promise<TurnSnapshotState> {
  if (state?.turnSnapshots) {
    return state.turnSnapshots;
  }

  const paths = await getWorkspaceStoragePaths(ctx, state);
  const fromFile = await readJsonFile<TurnSnapshotState>(paths.turnSnapshotsFile);
  let snapshots = fromFile;
  if (!snapshots) {
    snapshots = rebuildTurnSnapshotsFromLegacyEntries(ctx);
    if (snapshots.turns.length > 0 && !await exists(paths.turnSnapshotsFile)) {
      await writeJsonFile(paths.turnSnapshotsFile, snapshots);
    }
  }
  const normalized = snapshots.turns.length > 0 ? snapshots : {
    version: 1 as const,
    turns: [],
  };

  if (state) {
    state.turnSnapshots = normalized;
  }

  return normalized;
}

async function writeTurnSnapshotState(ctx: ExtensionContext, snapshots: TurnSnapshotState, state?: RuntimeState): Promise<void> {
  const paths = await ensureStorageDirs(ctx, state);
  await writeJsonFile(paths.turnSnapshotsFile, snapshots);
  if (state) {
    state.turnSnapshots = snapshots;
  }
}

async function clearRedoStack(ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  await writeRedoState(ctx, {
    sessionId,
    stack: [],
  }, state);
}

async function pushRedoTarget(
  ctx: ExtensionContext,
  targetId: string,
  navigationMode: NavigationMode,
  state?: RuntimeState,
): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  const redoState = (await readRedoState(ctx, state)) ?? { sessionId, stack: [] };
  const next: RedoState = {
    sessionId,
    stack: [
      ...(redoState.sessionId === sessionId ? redoState.stack : []),
      { targetId, navigationMode, createdAt: new Date().toISOString() },
    ],
  };
  await writeRedoState(ctx, next, state);
}

async function popRedoTarget(ctx: ExtensionContext, state?: RuntimeState): Promise<RedoItem | undefined> {
  const sessionId = ctx.sessionManager.getSessionId();
  const redoState = await readRedoState(ctx, state);
  if (!redoState || redoState.sessionId !== sessionId || redoState.stack.length === 0) {
    return undefined;
  }

  const stack = [...redoState.stack];
  const item = stack.pop();
  await writeRedoState(ctx, { sessionId, stack }, state);
  return item;
}

async function peekRedoTarget(ctx: ExtensionContext, state?: RuntimeState): Promise<RedoItem | undefined> {
  const sessionId = ctx.sessionManager.getSessionId();
  const redoState = await readRedoState(ctx, state);
  if (!redoState || redoState.sessionId !== sessionId || redoState.stack.length === 0) {
    return undefined;
  }
  return redoState.stack[redoState.stack.length - 1];
}

function getEntries(ctx: ExtensionContext): SessionEntry[] {
  return ctx.sessionManager.getEntries();
}

function getTurnSnapshots(state: RuntimeState | undefined): TurnSnapshotRecord[] {
  return state?.turnSnapshots?.turns ?? [];
}

function isSnapshotEntry(entry: SessionEntry | undefined): entry is CustomEntry<WorkspaceSnapshot> {
  return entry?.type === "custom" && entry.customType === SNAPSHOT_TYPE;
}

function hasSnapshotData(entry: CustomEntry<WorkspaceSnapshot> | undefined): entry is CustomEntry<WorkspaceSnapshot> & { data: WorkspaceSnapshot } {
  return !!entry?.data;
}

function isUserMessageEntry(entry: SessionEntry | undefined): entry is SessionMessageEntry {
  return entry?.type === "message" && entry.message.role === "user";
}

function getTreeNavigationResultLeafId(
  ctx: ExtensionContext,
  targetId: string,
): string | null | undefined {
  const target = ctx.sessionManager.getEntry(targetId);
  if (!target) {
    return undefined;
  }
  if (isUserMessageEntry(target) || target.type === "custom_message") {
    return target.parentId;
  }
  return target.id;
}

function getSnapshotEntries(ctx: ExtensionContext): Array<CustomEntry<WorkspaceSnapshot>> {
  return getEntries(ctx).filter(isSnapshotEntry);
}

function getReferencedSnapshotCommits(ctx: ExtensionContext, state?: RuntimeState): string[] {
  const commits = new Set<string>();
  for (const turn of getTurnSnapshots(state)) {
    commits.add(turn.beforeCommit);
    commits.add(turn.afterCommit);
    for (const anchor of turn.navigationSnapshots ?? []) {
      commits.add(anchor.commit);
    }
  }
  for (const entry of getSnapshotEntries(ctx)) {
    if (hasSnapshotData(entry)) {
      commits.add(entry.data.commit);
    }
  }
  if (state?.pendingRecovery) {
    commits.add(state.pendingRecovery.commit);
  }
  return [...commits].filter(isValidSnapshotCommit);
}

async function reconcileSnapshotRetentionRefs(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state?: RuntimeState,
): Promise<void> {
  const referencedCommits = getReferencedSnapshotCommits(ctx, state);
  if (referencedCommits.length === 0) {
    return;
  }

  await ensureShadowRepo(pi, ctx, state);
  const refsResult = await withTimeout(
    pi.exec(
      "git",
      await gitArgs(ctx, state, "for-each-ref", "--format=%(refname)", SNAPSHOT_RETENTION_REF_PREFIX),
      { cwd: ctx.cwd },
    ),
    await getGitTimeoutMs(ctx, state),
    "git for-each-ref snapshot retention",
  );
  if (refsResult.code !== 0) {
    throw new Error(refsResult.stderr || refsResult.stdout || "git for-each-ref snapshot retention failed");
  }

  const retainedRefs = new Set(refsResult.stdout.split(/\r?\n/).filter((ref) => ref.length > 0));
  let retainedCount = 0;
  let missingCount = 0;
  for (const commit of referencedCommits) {
    if (retainedRefs.has(getSnapshotRetentionRef(commit))) {
      continue;
    }
    if (!await isSnapshotCommitAvailable(pi, ctx, commit, state)) {
      missingCount += 1;
      await logLine(ctx, `snapshot retention migration skipped missing commit=${commit}`, state);
      continue;
    }
    await retainSnapshotCommit(pi, ctx, commit, state);
    retainedCount += 1;
  }
  await logLine(
    ctx,
    `snapshot retention reconciled referenced=${referencedCommits.length} retained=${retainedCount} missing=${missingCount}`,
    state,
  );
}

function extractUserText(entry: SessionEntry | undefined): string | undefined {
  if (!isUserMessageEntry(entry)) {
    return undefined;
  }

  const message = entry.message;
  if (message.role !== "user") {
    return undefined;
  }

  const content = message.content;
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter(
      (item: (typeof content)[number]): item is Extract<(typeof content)[number], { type: "text" }> => item.type === "text",
    )
    .map((item: Extract<(typeof content)[number], { type: "text" }>) => item.text)
    .join("");
}

function isAssistantTurnMessage(message: unknown): message is { role: string; content: unknown[] } {
  return !!message && typeof message === "object" && "role" in message && (message as { role?: unknown }).role === "assistant";
}

function getResolvedSnapshotData(
  snapshot: WorkspaceSnapshot | CustomEntry<WorkspaceSnapshot> | undefined,
): WorkspaceSnapshot | undefined {
  if (!snapshot) {
    return undefined;
  }
  if ("type" in snapshot) {
    return isSnapshotEntry(snapshot) && hasSnapshotData(snapshot) ? snapshot.data : undefined;
  }
  return snapshot;
}

function findLatestUserMessageOnBranch(ctx: ExtensionContext): SessionMessageEntry | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (isUserMessageEntry(entry)) {
      return entry;
    }
  }
  return undefined;
}

function findSnapshotById(ctx: ExtensionContext, snapshotId: string | undefined): CustomEntry<WorkspaceSnapshot> | undefined {
  if (!snapshotId) {
    return undefined;
  }

  const entry = ctx.sessionManager.getEntry(snapshotId);
  return isSnapshotEntry(entry) ? entry : undefined;
}

function getSnapshotCommit(entry: CustomEntry<WorkspaceSnapshot> | undefined): string | undefined {
  return hasSnapshotData(entry) ? entry.data.commit : undefined;
}

function findLastAfterSnapshot(ctx: ExtensionContext, state?: RuntimeState): WorkspaceSnapshot | undefined {
  let currentId = ctx.sessionManager.getLeafId();
  while (currentId) {
    const entry = ctx.sessionManager.getEntry(currentId);
    if (!entry) {
      return undefined;
    }

    const resolved = findAfterSnapshotForMessageAnchor(ctx, entry, state);
    if (resolved) {
      return resolved;
    }

    currentId = entry.parentId ?? null;
  }

  const turns = getTurnSnapshots(state);
  const turn = turns[turns.length - 1];
  return turn ? {
    v: 1,
    kind: "after",
    commit: turn.afterCommit,
    turnId: turn.turnId,
    promptText: turn.promptText,
    userEntryId: turn.userEntryId,
    assistantEntryId: turn.assistantEntryId,
    createdAt: turn.createdAt,
  } : undefined;
}

function isSlashCommandPrompt(promptText: string | undefined): boolean {
  return typeof promptText === "string" && promptText.trimStart().startsWith("/");
}

function findUndoTargetAfterSnapshot(ctx: ExtensionContext, state?: RuntimeState): WorkspaceSnapshot | undefined {
  const currentLeafId = ctx.sessionManager.getLeafId();
  if (currentLeafId) {
    const currentEntry = ctx.sessionManager.getEntry(currentLeafId);
    if (currentEntry && !isSnapshotEntry(currentEntry)) {
      const resolved = findAfterSnapshotForMessageAnchor(ctx, currentEntry, state);
      if (resolved) {
        return resolved;
      }
    }
  }

  return findLastAfterSnapshot(ctx, state);
}

function findAfterSnapshotOnCurrentBranch(ctx: ExtensionContext, state?: RuntimeState): WorkspaceSnapshot | undefined {
  let currentId = ctx.sessionManager.getLeafId();
  while (currentId) {
    const entry = ctx.sessionManager.getEntry(currentId);
    if (!entry) {
      return undefined;
    }

    if (!isSnapshotEntry(entry)) {
      const resolved = findAfterSnapshotForMessageAnchor(ctx, entry, state);
      if (resolved) {
        return resolved;
      }
    }

    currentId = entry.parentId ?? null;
  }

  return undefined;
}

function findTurnSnapshotByAssistantEntryId(assistantEntryId: string, state?: RuntimeState): TurnSnapshotRecord | undefined {
  return getTurnSnapshots(state).find((entry) => entry.assistantEntryId === assistantEntryId);
}

function findTurnSnapshotByUserEntryId(userEntryId: string, state?: RuntimeState): TurnSnapshotRecord | undefined {
  return getTurnSnapshots(state).find((entry) => entry.userEntryId === userEntryId);
}

function isAssistantMessageEntry(entry: SessionEntry | undefined): entry is SessionMessageEntry {
  return entry?.type === "message" && entry.message.role === "assistant";
}

function isMessageEntry(entry: SessionEntry | undefined): entry is SessionMessageEntry {
  return entry?.type === "message";
}

function findNavigationSnapshotForEntry(entryId: string, state?: RuntimeState): WorkspaceSnapshot | undefined {
  const turns = getTurnSnapshots(state);
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex] as TurnSnapshotRecord;
    const anchors = turn.navigationSnapshots ?? [];
    let anchor: NodeSnapshotAnchor | undefined;
    for (let anchorIndex = anchors.length - 1; anchorIndex >= 0; anchorIndex -= 1) {
      if (anchors[anchorIndex]?.entryId === entryId) {
        anchor = anchors[anchorIndex];
        break;
      }
    }
    if (!anchor) {
      continue;
    }
    return {
      v: 1,
      kind: anchor.position,
      commit: anchor.commit,
      turnId: turn.turnId,
      promptText: turn.promptText,
      userEntryId: turn.userEntryId,
      assistantEntryId: turn.assistantEntryId,
      createdAt: turn.createdAt,
    };
  }
  return undefined;
}

function findAfterSnapshotForMessageAnchor(
  ctx: ExtensionContext,
  entry: SessionEntry | undefined,
  state?: RuntimeState,
): WorkspaceSnapshot | undefined {
  if (!entry || entry.type !== "message") {
    return undefined;
  }

  const anchoredSnapshot = findNavigationSnapshotForEntry(entry.id, state);
  if (anchoredSnapshot) {
    return anchoredSnapshot;
  }

  const messageEntry = entry as SessionMessageEntry & { id: string; message: { role: string } };

  if (messageEntry.message.role === "user") {
    const turn = findTurnSnapshotByUserEntryId(messageEntry.id, state);
    return turn ? {
      v: 1,
      kind: "after",
      commit: turn.afterCommit,
      turnId: turn.turnId,
      promptText: turn.promptText,
      userEntryId: turn.userEntryId,
      assistantEntryId: turn.assistantEntryId,
      createdAt: turn.createdAt,
    } : undefined;
  }

  if (messageEntry.message.role === "assistant") {
    const turn = findTurnSnapshotByAssistantEntryId(messageEntry.id, state);
    return turn ? {
      v: 1,
      kind: "after",
      commit: turn.afterCommit,
      turnId: turn.turnId,
      promptText: turn.promptText,
      userEntryId: turn.userEntryId,
      assistantEntryId: turn.assistantEntryId,
      createdAt: turn.createdAt,
    } : undefined;
  }

  return undefined;
}

function findBeforeSnapshotForUserEntry(userEntryId: string, state?: RuntimeState): WorkspaceSnapshot | undefined {
  const anchoredSnapshot = findNavigationSnapshotForEntry(userEntryId, state);
  if (anchoredSnapshot) {
    return anchoredSnapshot;
  }
  const turn = findTurnSnapshotByUserEntryId(userEntryId, state);
  return turn ? {
    v: 1,
    kind: "before",
    commit: turn.beforeCommit,
    turnId: turn.turnId,
    promptText: turn.promptText,
    userEntryId: turn.userEntryId,
    assistantEntryId: turn.assistantEntryId,
    createdAt: turn.createdAt,
  } : undefined;
}

function findInheritedSnapshotForMetadataTarget(
  ctx: ExtensionContext,
  startId: string | null | undefined,
  state?: RuntimeState,
): WorkspaceSnapshot | CustomEntry<WorkspaceSnapshot> | undefined {
  let currentId = startId ?? null;
  while (currentId) {
    const entry: SessionEntry | undefined = ctx.sessionManager.getEntry(currentId);
    if (!entry) {
      return undefined;
    }
    if (isSnapshotEntry(entry)) {
      return entry;
    }
    const anchoredSnapshot = findNavigationSnapshotForEntry(entry.id, state);
    if (anchoredSnapshot) {
      return anchoredSnapshot;
    }
    if (entry.type === "message") {
      if (entry.message.role !== "assistant") {
        return undefined;
      }
      const turn = findTurnSnapshotByAssistantEntryId(entry.id, state);
      return turn ? {
        v: 1,
        kind: "after",
        commit: turn.afterCommit,
        turnId: turn.turnId,
        promptText: turn.promptText,
        userEntryId: turn.userEntryId,
        assistantEntryId: turn.assistantEntryId,
        createdAt: turn.createdAt,
      } : undefined;
    }
    currentId = entry.parentId;
  }
  return undefined;
}

function resolveSnapshotForTreeTarget(
  ctx: ExtensionContext,
  targetId: string,
  state?: RuntimeState,
): WorkspaceSnapshot | CustomEntry<WorkspaceSnapshot> | undefined {
  const target = ctx.sessionManager.getEntry(targetId);
  if (!target) {
    return undefined;
  }

  if (isSnapshotEntry(target)) {
    return target;
  }

  const anchoredSnapshot = findNavigationSnapshotForEntry(target.id, state);
  if (anchoredSnapshot) {
    return anchoredSnapshot;
  }

  if (target.type === "message") {
    if (target.message.role === "user") {
      return findBeforeSnapshotForUserEntry(target.id, state);
    }
    return findAfterSnapshotForMessageAnchor(ctx, target, state);
  }

  return findInheritedSnapshotForMetadataTarget(ctx, target.parentId, state);
}

async function ensureBaselineSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state?: RuntimeState,
  commitOverride?: string,
): Promise<void> {
  const existing = getSnapshotEntries(ctx).find((entry) => hasSnapshotData(entry) && entry.data.kind === "baseline");
  if (existing) {
    return;
  }

  const commit = commitOverride ?? await createSnapshotCommit(pi, ctx, "baseline", state);
  pi.appendEntry<WorkspaceSnapshot>(SNAPSHOT_TYPE, {
    v: 1,
    kind: "baseline",
    commit,
    createdAt: new Date().toISOString(),
  });
  const snapshotId = ctx.sessionManager.getLeafId();
  await logLine(ctx, `create baseline snapshot entry=${snapshotId} commit=${commit} leaf=${snapshotId}`, state);
}

async function isWorkspaceDirtyAgainstCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  commit: string,
  state?: RuntimeState,
): Promise<WorkspaceComparison> {
  const startedAt = Date.now();
  await assertWorkspaceHistoryEnabled(ctx, state, "isWorkspaceDirtyAgainstCommit");
  await ensureShadowRepo(pi, ctx, state);

  const headCommit = state?.lastKnownShadowHead === commit
    ? state.lastKnownShadowHead
    : await getHeadCommit(pi, ctx, state);
  if (state && headCommit) {
    state.lastKnownShadowHead = headCommit;
  }
  if (headCommit === commit) {
    const changed = await hasWorkspaceChanges(pi, ctx, state);
    await logLine(ctx, `dirty against commit via status ${elapsedMs(startedAt)}ms commit=${commit} changed=${String(changed)}`, state);
    return changed ? "dirty" : "clean";
  }

  const diffResult = await withTimeout(
    pi.exec(
      "git",
      await gitArgs(ctx, state, "diff", "--quiet", commit, "--", "."),
      { cwd: ctx.cwd },
    ),
    await getGitTimeoutMs(ctx, state),
    "git diff",
  );

  if (diffResult.code === 1) {
    return "dirty";
  }

  if (diffResult.code !== 0) {
    if (!await isSnapshotCommitAvailable(pi, ctx, commit, state)) {
      await logLine(ctx, `dirty against commit missing ${elapsedMs(startedAt)}ms commit=${commit}`, state);
      return "missing";
    }
    throw new Error(diffResult.stderr || diffResult.stdout || "git diff failed");
  }

  const untrackedResult = await withTimeout(
    pi.exec(
      "git",
      await gitArgs(ctx, state, "ls-files", "--others", "--exclude-standard", "-z", "--", "."),
      { cwd: ctx.cwd },
    ),
    await getGitTimeoutMs(ctx, state),
    "git ls-files --others",
  );

  if (untrackedResult.code !== 0) {
    throw new Error(untrackedResult.stderr || untrackedResult.stdout || "git ls-files failed");
  }

  const changed = untrackedResult.stdout.trim().length > 0;
  await logLine(ctx, `dirty against commit via diff ${elapsedMs(startedAt)}ms commit=${commit} changed=${String(changed)}`, state);
  return changed ? "dirty" : "clean";
}

async function isWorkspaceDirtyAgainstSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: WorkspaceSnapshot | CustomEntry<WorkspaceSnapshot> | undefined,
  state?: RuntimeState,
): Promise<WorkspaceComparison> {
  const snapshotData = getResolvedSnapshotData(snapshot);
  if (!snapshotData) {
    return "clean";
  }
  return isWorkspaceDirtyAgainstCommit(pi, ctx, snapshotData.commit, state);
}

function getNavigationBlockMessage(comparison: WorkspaceComparison): string | undefined {
  if (comparison === "missing") {
    return "The current history node's workspace snapshot is unavailable. Run /checkpoint before switching.";
  }
  if (comparison === "dirty") {
    return "The workspace has unsnapshotted changes. Run /checkpoint first, or clean them up before switching.";
  }
  return undefined;
}

async function restoreResolvedSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  source: string,
  targetId: string,
  snapshot: WorkspaceSnapshot | CustomEntry<WorkspaceSnapshot>,
  state?: RuntimeState,
): Promise<string> {
  const snapshotData = getResolvedSnapshotData(snapshot);
  if (!snapshotData) {
    throw new Error("snapshot data missing");
  }

  const restoredCommit = await restoreSnapshotCommitSafely(pi, ctx, snapshotData.commit, state);
  await logLine(
    ctx,
    `restore source=${source} target=${targetId} kind=${snapshotData.kind} commit=${snapshotData.commit} restoredCommit=${restoredCommit} ok`,
    state,
  );
  return restoredCommit;
}

const CLEANUP_INTERVAL_MS = 60_000;
const BASELINE_WARMUP_DELAY_MS = 5_000;

function scheduleCleanup(ctx: ExtensionContext, state?: RuntimeState): void {
  if (!state) {
    return;
  }
  const now = Date.now();
  if (state.cleanupPromise || (state.lastCleanupAt && now - state.lastCleanupAt < CLEANUP_INTERVAL_MS)) {
    return;
  }
  state.lastCleanupAt = now;
  state.cleanupPromise = cleanupWorkspaceHistory(ctx, state)
    .catch(async (error) => {
      await logLine(ctx, `cleanup failed error=${String(error)}`, state, true).catch(() => undefined);
    })
    .finally(() => {
      state.cleanupPromise = undefined;
    });
}

async function ensureNoUnsnapshottedChanges(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  source: string,
  state?: RuntimeState,
): Promise<NavigationPrecheckResult | undefined> {
  const action = `${source.slice(0, 1).toUpperCase()}${source.slice(1)}`;
  if (!await tryRecoverPendingWorkspace(pi, ctx, state, action)) {
    return undefined;
  }

  const currentLeafId = ctx.sessionManager.getLeafId() ?? undefined;
  const currentSnapshot = currentLeafId ? resolveSnapshotForTreeTarget(ctx, currentLeafId, state) : undefined;

  try {
    const comparison = await isWorkspaceDirtyAgainstSnapshot(pi, ctx, currentSnapshot, state);
    const blockMessage = getNavigationBlockMessage(comparison);
    if (blockMessage) {
      await logLine(ctx, `${source} blocked: ${comparison} currentLeaf=${currentLeafId}`, state);
      ctx.ui.notify(blockMessage, "error");
      return undefined;
    }
  } catch (error) {
    await logLine(ctx, `${source} dirty-check failed currentLeaf=${currentLeafId} error=${String(error)}`, state);
    ctx.ui.notify("Workspace dirty check failed. Navigation cancelled.", "error");
    return undefined;
  }

  return { currentLeafId, currentSnapshot };
}

async function selectNavigationMode(
  ctx: ExtensionContext,
  title: string,
  signal?: AbortSignal,
): Promise<NavigationMode | undefined> {
  if (!ctx.hasUI) {
    return "conversationAndWorkspace";
  }

  const choice = await ctx.ui.select(title, [...NAVIGATION_MODE_OPTIONS], { signal });
  if (choice === NAVIGATION_MODE_OPTIONS[0]) {
    return "conversationAndWorkspace";
  }
  if (choice === NAVIGATION_MODE_OPTIONS[1]) {
    return "conversationOnly";
  }
  return undefined;
}

async function ensureWorkspaceHistoryAvailable(
  ctx: ExtensionContext,
  state: RuntimeState,
  action: string,
): Promise<boolean> {
  const availability = await evaluateWorkspaceHistoryAvailability(ctx, state);
  if (availability.enabled) {
    state.disabledNoticeReason = undefined;
    return true;
  }

  if (state.disabledNoticeReason !== availability.reason) {
    const message = availability.unsafeStorageDir
      ? `Workspace history is disabled: ${availability.reason}. Move storageDir to a directory outside the workspace, then reload Pi.`
      : `Workspace history is disabled for this directory: ${availability.reason ?? "unknown reason"}. Open pi inside a project directory or set workspaceHistory.enabled to true.`;
    ctx.ui.notify(message, "warning");
    state.disabledNoticeReason = availability.reason;
  }
  await logLine(ctx, `${action} blocked: ${availability.reason ?? "disabled"}`, state);
  return false;
}

async function assertWorkspaceHistoryEnabled(
  ctx: ExtensionContext,
  state: RuntimeState | undefined,
  action: string,
): Promise<void> {
  const availability = await evaluateWorkspaceHistoryAvailability(ctx, state);
  if (!availability.enabled) {
    throw new Error(`${action} is unavailable: ${availability.reason ?? "disabled"}`);
  }
}

export default function workspaceHistoryExtension(pi: ExtensionAPI) {
  const states = new Map<string, RuntimeState>();

  function getState(ctx: ExtensionContext): RuntimeState {
    const sessionId = ctx.sessionManager.getSessionId();
    let state = states.get(sessionId);
    if (!state) {
      state = {};
      states.set(sessionId, state);
    }
    return state;
  }

  function cancelBaselineWarmup(state: RuntimeState): void {
    if (state.baselineWarmupTimer) {
      clearTimeout(state.baselineWarmupTimer);
      state.baselineWarmupTimer = undefined;
    }
    state.baselineWarmupGeneration = (state.baselineWarmupGeneration ?? 0) + 1;
  }

  function scheduleBaselineWarmup(ctx: ExtensionContext, state: RuntimeState): void {
    if (
      state.baselineWarmupTimer ||
      state.baselineWarmupPromise ||
      state.warmedBaselineCommit ||
      getSnapshotEntries(ctx).some((entry) => hasSnapshotData(entry) && entry.data.kind === "baseline")
    ) {
      return;
    }

    const generation = (state.baselineWarmupGeneration ?? 0) + 1;
    state.baselineWarmupGeneration = generation;
    state.baselineWarmupTimer = setTimeout(() => {
      state.baselineWarmupTimer = undefined;
      state.baselineWarmupPromise = (async () => {
        const startedAt = Date.now();
        state.baselineWarmupInProgress = true;
        await logLine(ctx, `warm baseline start generation=${generation}`, state);
        try {
          if (
            state.baselineWarmupGeneration !== generation ||
            state.pendingTurnId ||
            state.pendingPromptText ||
            getSnapshotEntries(ctx).some((entry) => hasSnapshotData(entry) && entry.data.kind === "baseline")
          ) {
            return;
          }

          const commit = await createSnapshotCommit(pi, ctx, "baseline warmup", state);
          if (
            state.baselineWarmupGeneration !== generation ||
            state.pendingTurnId ||
            state.pendingPromptText ||
            getSnapshotEntries(ctx).some((entry) => hasSnapshotData(entry) && entry.data.kind === "baseline")
          ) {
            return;
          }

          state.warmedBaselineCommit = commit;
          await logLine(ctx, `warm baseline commit=${commit}`, state);
        } catch (error) {
          await logLine(ctx, `warm baseline failed error=${String(error)}`, state).catch(() => undefined);
        } finally {
          state.baselineWarmupInProgress = false;
          await logLine(ctx, `warm baseline end generation=${generation} ${elapsedMs(startedAt)}ms`, state).catch(() => undefined);
          if (state.baselineWarmupPromise) {
            state.baselineWarmupPromise = undefined;
          }
        }
      })();
    }, BASELINE_WARMUP_DELAY_MS);
  }

  async function ensureBeforeSnapshotForTurn(
    ctx: ExtensionContext,
    state: RuntimeState,
    promptText?: string,
  ): Promise<void> {
    if (isSlashCommandPrompt(promptText)) {
      return;
    }

    if (state.pendingTurnId || state.pendingBeforeCommit) {
      return;
    }

    if (state.beforeSnapshotPromise && state.pendingBeforeSnapshotPrompt === promptText) {
      await state.beforeSnapshotPromise;
      return;
    }

    const beforeSnapshotPromise = (async () => {
      if (!await tryRecoverPendingWorkspace(pi, ctx, state, "New turn")) {
        throw new Error("workspace recovery is incomplete");
      }

      const startedAt = Date.now();
      cancelBaselineWarmup(state);
      await clearRedoStack(ctx, state);

      const turnId = randomUUID();
      const hasBaseline = getSnapshotEntries(ctx).some((entry) => hasSnapshotData(entry) && entry.data.kind === "baseline");
      const isFirstSnapshot = !hasBaseline;
      let commit: string;

      if (isFirstSnapshot) {
        await logLine(ctx, `before snapshot start turn=${turnId} first=true prompt=${String(promptText ?? "")}`, state);
        if (!state.warmedBaselineCommit && !state.initializationNoticeShown) {
          ctx.ui.notify("Initializing workspace history for this project. The first prompt may take a moment.", "info");
          state.initializationNoticeShown = true;
        }
        if (state.baselineWarmupPromise) {
          ctx.ui.notify("Workspace history is finishing its initial snapshot. Your prompt will continue shortly.", "info");
          await state.baselineWarmupPromise;
        }
        const warmedCommit = state.warmedBaselineCommit;
        const warmedComparison = warmedCommit
          ? await isWorkspaceDirtyAgainstCommit(pi, ctx, warmedCommit, state)
          : undefined;
        if (warmedCommit && warmedComparison === "clean") {
          commit = warmedCommit;
        } else {
          if (warmedCommit) {
            if (warmedComparison === "missing") {
              await warnMissingSnapshotCommit(ctx, warmedCommit, "warm-baseline", state);
            }
            await logLine(ctx, `discard warm baseline commit=${warmedCommit} reason=${warmedComparison ?? "unavailable"}`, state);
          }
          commit = await createSnapshotCommit(pi, ctx, `before ${turnId}`, state);
        }
        state.initialSnapshotCommit = commit;
        state.warmedBaselineCommit = undefined;
        state.baselineWarmupGeneration = undefined;
        await ensureBaselineSnapshot(pi, ctx, state, commit);
      } else {
        await logLine(ctx, `before snapshot start turn=${turnId} first=false prompt=${String(promptText ?? "")}`, state);
        const previousAfter = findAfterSnapshotOnCurrentBranch(ctx, state);
        if (previousAfter) {
          const comparison = await isWorkspaceDirtyAgainstCommit(pi, ctx, previousAfter.commit, state);
          if (comparison === "clean") {
            commit = previousAfter.commit;
            await logLine(ctx, `reuse previous after commit for before snapshot turn=${turnId} commit=${commit}`, state);
          } else {
            if (comparison === "missing") {
              await warnMissingSnapshotCommit(ctx, previousAfter.commit, "before-turn", state);
            }
            commit = await createSnapshotCommit(pi, ctx, `before ${turnId}`, state, true);
          }
        } else {
          commit = await createSnapshotCommit(pi, ctx, `before ${turnId}`, state);
        }
      }

      state.pendingTurnId = turnId;
      state.pendingBeforeCommit = commit;
      state.pendingOperationStartLeafId = ctx.sessionManager.getLeafId();
      state.pendingOriginalUserEntryId = undefined;
      state.pendingNavigationSnapshots = [];
      state.pendingAnchoredEntryIds = new Set<string>();
      state.pendingLastTurnCommit = undefined;
      state.pendingLastAssistantEntryId = undefined;

      await logLine(
        ctx,
        `create before snapshot turn=${turnId} commit=${commit} leaf=${ctx.sessionManager.getLeafId()} ${elapsedMs(startedAt)}ms`,
        state,
      );
    })();

    state.beforeSnapshotPromise = beforeSnapshotPromise;
    state.pendingBeforeSnapshotPrompt = promptText;

    try {
      await beforeSnapshotPromise;
    } finally {
      if (state.beforeSnapshotPromise === beforeSnapshotPromise) {
        state.beforeSnapshotPromise = undefined;
        state.pendingBeforeSnapshotPrompt = undefined;
      }
    }
  }

  function clearPendingAgentOperation(state: RuntimeState): void {
    state.pendingTurnId = undefined;
    state.pendingBeforeCommit = undefined;
    state.pendingPromptText = undefined;
    state.pendingOriginalUserEntryId = undefined;
    state.pendingOperationStartLeafId = undefined;
    state.pendingNavigationSnapshots = undefined;
    state.pendingAnchoredEntryIds = undefined;
    state.pendingLastTurnCommit = undefined;
    state.pendingLastAssistantEntryId = undefined;
  }

  function getPendingOperationBranchEntries(ctx: ExtensionContext, state: RuntimeState): SessionEntry[] {
    const branch = ctx.sessionManager.getBranch();
    const startId = state.pendingOperationStartLeafId;
    if (!startId) {
      return branch;
    }
    const startIndex = branch.findIndex((entry) => entry.id === startId);
    return startIndex >= 0 ? branch.slice(startIndex + 1) : branch;
  }

  function anchorPendingOperationEntry(
    state: RuntimeState,
    entryId: string,
    commit: string,
    position: "before" | "after",
  ): void {
    const anchors = state.pendingNavigationSnapshots ?? [];
    const anchoredEntryIds = state.pendingAnchoredEntryIds ?? new Set(anchors.map((anchor) => anchor.entryId));
    if (anchoredEntryIds.has(entryId)) {
      return;
    }
    anchors.push({ entryId, commit, position });
    anchoredEntryIds.add(entryId);
    state.pendingNavigationSnapshots = anchors;
    state.pendingAnchoredEntryIds = anchoredEntryIds;
  }

  async function capturePendingAgentOperation(
    ctx: ExtensionContext,
    state: RuntimeState,
    source: "turn_end" | "agent_settled",
  ): Promise<void> {
    if (!state.pendingTurnId || !state.pendingBeforeCommit) {
      return;
    }

    const operationEntries = getPendingOperationBranchEntries(ctx, state);
    const originalUserEntry = state.pendingOriginalUserEntryId
      ? ctx.sessionManager.getEntry(state.pendingOriginalUserEntryId)
      : operationEntries.find(isUserMessageEntry);
    if (!isUserMessageEntry(originalUserEntry)) {
      await logLine(ctx, `skip operation snapshot: no original user entry turn=${state.pendingTurnId} source=${source}`, state);
      return;
    }
    state.pendingOriginalUserEntryId = originalUserEntry.id;

    const assistantEntries = operationEntries.filter(isAssistantMessageEntry);
    const latestAssistant = assistantEntries[assistantEntries.length - 1];
    if (!latestAssistant && !state.pendingLastAssistantEntryId) {
      await logLine(ctx, `skip operation snapshot: no assistant entry turn=${state.pendingTurnId} source=${source}`, state);
      return;
    }
    if (latestAssistant) {
      state.pendingLastAssistantEntryId = latestAssistant.id;
    }

    const previousCommit = state.pendingLastTurnCommit ?? state.pendingBeforeCommit;
    let commit = previousCommit;
    const comparison = await isWorkspaceDirtyAgainstCommit(pi, ctx, previousCommit, state);
    if (comparison !== "clean") {
      if (comparison === "missing") {
        await warnMissingSnapshotCommit(ctx, previousCommit, source, state);
      }
      commit = await createSnapshotCommit(pi, ctx, `after ${state.pendingTurnId}`, state, true);
    }

    for (const entry of operationEntries) {
      const isOriginalUser = entry.id === originalUserEntry.id;
      const isQueuedUser = isUserMessageEntry(entry) && !isOriginalUser;
      anchorPendingOperationEntry(
        state,
        entry.id,
        isOriginalUser ? state.pendingBeforeCommit : isQueuedUser ? previousCommit : commit,
        isOriginalUser || isQueuedUser ? "before" : "after",
      );
    }
    state.pendingLastTurnCommit = commit;
    const anchors = state.pendingNavigationSnapshots ?? [];

    const snapshots = await readTurnSnapshotState(ctx, state);
    const existingIndex = snapshots.turns.findIndex((entry) => entry.turnId === state.pendingTurnId);
    const existing = existingIndex >= 0 ? snapshots.turns[existingIndex] : undefined;
    const record: TurnSnapshotRecord = {
      turnId: state.pendingTurnId,
      promptText: state.pendingPromptText,
      userEntryId: originalUserEntry.id,
      assistantEntryId: state.pendingLastAssistantEntryId as string,
      beforeCommit: state.pendingBeforeCommit,
      afterCommit: commit,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      navigationSnapshots: [...anchors],
    };
    if (existingIndex >= 0) {
      snapshots.turns[existingIndex] = record;
    } else {
      snapshots.turns.push(record);
    }
    await writeTurnSnapshotState(ctx, snapshots, state);
    await logLine(
      ctx,
      `capture operation snapshot source=${source} turn=${record.turnId} userEntry=${record.userEntryId} assistantEntry=${record.assistantEntryId} beforeCommit=${record.beforeCommit} afterCommit=${record.afterCommit} anchors=${anchors.length}`,
      state,
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    const startedAt = Date.now();
    const state = getState(ctx);
    await logLine(ctx, `session_start begin session=${ctx.sessionManager.getSessionId()}`, state).catch(() => undefined);
    state.pendingTurnId = undefined;
    state.pendingBeforeCommit = undefined;
    state.pendingPromptText = undefined;
    state.pendingOriginalUserEntryId = undefined;
    state.pendingOperationStartLeafId = undefined;
    state.pendingNavigationSnapshots = undefined;
    state.pendingAnchoredEntryIds = undefined;
    state.pendingLastTurnCommit = undefined;
    state.pendingLastAssistantEntryId = undefined;
    state.pendingBeforeSnapshotPrompt = undefined;
    state.internalNavigation = undefined;
    state.internalNavigationFailureReported = undefined;
    state.navigationMode = undefined;
    state.pendingWorkspaceAnchor = undefined;
    state.pendingRecovery = undefined;
    state.pendingRecoveryPromise = undefined;
    state.initialSnapshotCommit = undefined;
    state.warmedBaselineCommit = undefined;
    state.baselineWarmupTimer = undefined;
    state.baselineWarmupPromise = undefined;
    state.baselineWarmupGeneration = undefined;
    state.baselineWarmupInProgress = false;
    state.snapshotWritePromise = undefined;
    state.beforeSnapshotPromise = undefined;
    state.reusableRepoUpdatePromise = undefined;
    state.disabledNoticeReason = undefined;
    state.initializationNoticeShown = false;
    state.invalidShadowRepoNoticeShown = false;
    state.invalidShadowRepoRecoveryPending = false;
    state.reusableRepoFailureNoticeShown = false;
    state.validatedShadowGitDir = undefined;
    state.warnedMissingSnapshotCommits = undefined;
    state.sessionLeaseOwnerId = undefined;

    if (!await ensureWorkspaceHistoryAvailable(ctx, state, "session_start")) {
      return;
    }

    await getWorkspaceHistorySettings(ctx, state);
    await getWorkspaceStoragePaths(ctx, state);
    await acquireSessionLease(ctx, state);
    state.pendingRecovery = await readPendingRecoveryState(ctx, state);
    if (state.pendingRecovery) {
      await logLine(ctx, `pending workspace recovery loaded commit=${state.pendingRecovery.commit}`, state);
    }
    await touchWorkspaceAndSessionMeta(ctx, state);
    await readTurnSnapshotState(ctx, state);
    await reconcileSnapshotRetentionRefs(pi, ctx, state);
    scheduleCleanup(ctx, state);
    scheduleBaselineWarmup(ctx, state);
    await logLine(ctx, `session_start done ${elapsedMs(startedAt)}ms session=${ctx.sessionManager.getSessionId()}`, state);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const state = getState(ctx);
    await state.reusableRepoUpdatePromise?.catch(() => undefined);
    await releaseSessionLease(ctx, state);
  });

  pi.on("input", async (event, ctx) => {
    const state = getState(ctx);
    if (event.source === "extension" || isSlashCommandPrompt(event.text)) {
      return { action: "continue" };
    }
    if (!await ensureWorkspaceHistoryAvailable(ctx, state, "input")) {
      return { action: "continue" };
    }
    if (event.streamingBehavior) {
      await logLine(ctx, `queued input kept in current operation behavior=${event.streamingBehavior}`, state);
      return { action: "continue" };
    }
    state.pendingPromptText = event.text;
    void ensureBeforeSnapshotForTurn(ctx, state, event.text).catch((error) => {
      void logLine(ctx, `input before snapshot failed error=${String(error)}`, state);
    });
    await logLine(ctx, "input before snapshot scheduled", state);
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const startedAt = Date.now();
    const state = getState(ctx);
    await logLine(ctx, "before_agent_start begin", state).catch(() => undefined);
    if (!await ensureWorkspaceHistoryAvailable(ctx, state, "before_agent_start")) {
      return;
    }
    if (!state.pendingTurnId && !state.pendingBeforeCommit) {
      state.pendingPromptText = event.prompt;
    }
    await ensureBeforeSnapshotForTurn(ctx, state, event.prompt);
    await logLine(ctx, `before_agent_start done ${elapsedMs(startedAt)}ms`, state);
  });

  pi.on("turn_start", async (_event, ctx) => {
    const startedAt = Date.now();
    const state = getState(ctx);
    await logLine(ctx, "turn_start begin", state).catch(() => undefined);
    if (!await ensureWorkspaceHistoryAvailable(ctx, state, "turn_start")) {
      return;
    }
    if (isSlashCommandPrompt(state.pendingPromptText)) {
      return;
    }
    await ensureBeforeSnapshotForTurn(ctx, state, state.pendingPromptText);
    await logLine(ctx, `turn_start done ${elapsedMs(startedAt)}ms`, state);
  });

  pi.on("turn_end", async (event, ctx) => {
    const state = getState(ctx);
    try {
      if (!await ensureWorkspaceHistoryAvailable(ctx, state, "turn_end")) {
        clearPendingAgentOperation(state);
        return;
      }
      if (!state.pendingTurnId || !state.pendingBeforeCommit) {
        return;
      }

      if (!isAssistantTurnMessage(event.message)) {
        await logLine(ctx, `skip after snapshot: turn_end message role=${String((event.message as { role?: unknown })?.role ?? "unknown")}`, state);
        return;
      }
      await capturePendingAgentOperation(ctx, state, "turn_end");
    } catch (error) {
      await logLine(ctx, `after snapshot failed error=${String(error)}`, state);
      throw error;
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    const state = getState(ctx);
    if (!state.pendingTurnId || !state.pendingBeforeCommit) {
      return;
    }
    try {
      if (!await ensureWorkspaceHistoryAvailable(ctx, state, "session_compact")) {
        return;
      }
      const commit = state.pendingLastTurnCommit ?? state.pendingBeforeCommit;
      anchorPendingOperationEntry(state, event.compactionEntry.id, commit, "after");

      const snapshots = await readTurnSnapshotState(ctx, state);
      const existing = snapshots.turns.find((turn) => turn.turnId === state.pendingTurnId);
      if (existing) {
        existing.navigationSnapshots = [...(state.pendingNavigationSnapshots ?? [])];
        await writeTurnSnapshotState(ctx, snapshots, state);
      }
      await logLine(
        ctx,
        `capture compaction anchor turn=${state.pendingTurnId} entry=${event.compactionEntry.id} commit=${commit}`,
        state,
      );
    } catch (error) {
      await logLine(ctx, `compaction anchor failed error=${String(error)}`, state);
      throw error;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = getState(ctx);
    if (state.pendingTurnId || state.pendingBeforeCommit) {
      await logLine(
        ctx,
        `agent_end kept pending operation turn=${state.pendingTurnId} beforeCommit=${state.pendingBeforeCommit}`,
        state,
      );
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const state = getState(ctx);
    try {
      if (await ensureWorkspaceHistoryAvailable(ctx, state, "agent_settled")) {
        await capturePendingAgentOperation(ctx, state, "agent_settled");
      }
    } finally {
      clearPendingAgentOperation(state);
    }
  });

  pi.on("session_before_tree", async (event, ctx) => {
    const state = getState(ctx);
    const availability = await evaluateWorkspaceHistoryAvailability(ctx, state);
    if (!availability.enabled) {
      await logLine(ctx, `session_before_tree skipped: ${availability.reason ?? "disabled"}`, state);
      return undefined;
    }
    if (state.pendingWorkspaceAnchor) {
      await logLine(
        ctx,
        `discard stale workspace anchor target=${state.pendingWorkspaceAnchor.targetId} commit=${state.pendingWorkspaceAnchor.commit}`,
        state,
      );
      state.pendingWorkspaceAnchor = undefined;
    }
    await logLine(
      ctx,
      `session_before_tree target=${event.preparation.targetId} oldLeaf=${event.preparation.oldLeafId} summarize=${String(event.preparation.userWantsSummary)} source=${state.internalNavigation ?? "tree"}`,
      state,
    );
    const cancelNavigation = (message: string) => {
      if (state.internalNavigation) {
        state.internalNavigationFailureReported = true;
      }
      ctx.ui.notify(message, "error");
      return { cancel: true as const };
    };

    const navigationMode = state.navigationMode ?? await selectNavigationMode(ctx, "Tree navigation", event.signal);
    if (!navigationMode) {
      await logLine(ctx, "session_before_tree cancelled: no navigation mode selected", state);
      return { cancel: true };
    }

    if (
      event.preparation.userWantsSummary &&
      !state.internalNavigation &&
      navigationMode === "conversationAndWorkspace"
    ) {
      return cancelNavigation(
        "Tree navigation with a summary cannot safely restore workspace files. Choose conversation only or disable the summary.",
      );
    }

    if (
      event.preparation.userWantsSummary &&
      navigationMode === "conversationOnly" &&
      state.pendingRecovery
    ) {
      return cancelNavigation(
        "Workspace recovery is pending. Retry without a branch summary, or run /checkpoint to preserve later edits first.",
      );
    }

    const action = state.internalNavigation === "undo"
      ? "Undo"
      : state.internalNavigation === "redo"
        ? "Redo"
        : "Tree navigation";
    if (!await tryRecoverPendingWorkspace(
      pi,
      ctx,
      state,
      action,
      navigationMode === "conversationOnly",
    )) {
      if (state.internalNavigation) {
        state.internalNavigationFailureReported = true;
      }
      return { cancel: true };
    }

    if (navigationMode === "conversationOnly") {
      try {
        const commit = await createSnapshotCommit(
          pi,
          ctx,
          "conversation-only navigation",
          state,
        );
        state.pendingWorkspaceAnchor = {
          commit,
          label: "conversation-only navigation",
          oldLeafId: event.preparation.oldLeafId,
          targetId: event.preparation.targetId,
        };
        await logLine(
          ctx,
          `preserve workspace for conversation-only navigation target=${event.preparation.targetId} commit=${commit}`,
          state,
        );
        return undefined;
      } catch (error) {
        await logLine(ctx, `preserve conversation-only workspace failed error=${String(error)}`, state);
        return cancelNavigation("Could not preserve the current workspace. Navigation cancelled.");
      }
    }

    const currentLeafId = ctx.sessionManager.getLeafId();
    const currentSnapshot = currentLeafId ? resolveSnapshotForTreeTarget(ctx, currentLeafId, state) : undefined;

    try {
      const comparison = await isWorkspaceDirtyAgainstSnapshot(pi, ctx, currentSnapshot, state);
      const blockMessage = getNavigationBlockMessage(comparison);
      if (blockMessage) {
        return cancelNavigation(blockMessage);
      }
    } catch (error) {
      await logLine(ctx, `dirty-check failed target=${event.preparation.targetId} error=${String(error)}`, state);
      return cancelNavigation("Workspace dirty check failed. Tree navigation cancelled.");
    }

    const snapshot = resolveSnapshotForTreeTarget(ctx, event.preparation.targetId, state);
    const snapshotData = getResolvedSnapshotData(snapshot);
    if (!snapshotData) {
      return cancelNavigation("This history node has no workspace snapshot. Cannot restore precisely.");
    }

    try {
      if (!await isSnapshotCommitAvailable(pi, ctx, snapshotData.commit, state)) {
        await logLine(
          ctx,
          `restore unavailable source=${state.internalNavigation ?? "tree"} target=${event.preparation.targetId} commit=${snapshotData.commit}`,
          state,
        );
        return cancelNavigation("This history node's workspace snapshot is no longer available. Navigation cancelled.");
      }
      const restoredCommit = await restoreResolvedSnapshot(
        pi,
        ctx,
        state.internalNavigation ?? "tree",
        event.preparation.targetId,
        snapshotData,
        state,
      );
      const resultLeafId = getTreeNavigationResultLeafId(ctx, event.preparation.targetId);
      const resultSnapshot = resultLeafId
        ? resolveSnapshotForTreeTarget(ctx, resultLeafId, state)
        : undefined;
      const resultSnapshotData = getResolvedSnapshotData(resultSnapshot);
      if (resultSnapshotData?.commit !== restoredCommit) {
        state.pendingWorkspaceAnchor = {
          commit: restoredCommit,
          label: "restored workspace navigation",
          oldLeafId: event.preparation.oldLeafId,
          targetId: event.preparation.targetId,
        };
        await logLine(
          ctx,
          `preserve divergent restored workspace target=${event.preparation.targetId} resultLeaf=${String(resultLeafId)} commit=${restoredCommit}`,
          state,
        );
      }
    } catch (error) {
      await logLine(
        ctx,
        `restore source=${state.internalNavigation ?? "tree"} target=${event.preparation.targetId} kind=${snapshotData.kind} commit=${snapshotData.commit} error=${String(error)}`,
        state,
      );
      return cancelNavigation(getRestoreFailureNotification(error));
    }

    return undefined;
  });

  pi.on("session_tree", async (event, ctx) => {
    const state = getState(ctx);
    const pendingAnchor = state.pendingWorkspaceAnchor;
    state.pendingWorkspaceAnchor = undefined;
    if (!await ensureWorkspaceHistoryAvailable(ctx, state, "session_tree")) {
      return;
    }
    if (pendingAnchor && pendingAnchor.oldLeafId === event.oldLeafId) {
      const commit = pendingAnchor.commit;
      pi.appendEntry<WorkspaceSnapshot>(SNAPSHOT_TYPE, {
        v: 1,
        kind: "manual",
        commit,
        label: pendingAnchor.label,
        createdAt: new Date().toISOString(),
      });
      await logLine(
        ctx,
        `anchor workspace target=${pendingAnchor.targetId} commit=${commit} label=${pendingAnchor.label}`,
        state,
      );
    } else if (pendingAnchor) {
      await logLine(
        ctx,
        `skip stale workspace anchor target=${pendingAnchor.targetId} commit=${pendingAnchor.commit}`,
        state,
      );
    }
    if (state.internalNavigation) {
      return;
    }
    await clearRedoStack(ctx, state);
  });

  pi.registerCommand("undo", {
    description: "Undo last agent turn with optional workspace restore",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const state = getState(ctx);
      if (!await ensureWorkspaceHistoryAvailable(ctx, state, "undo")) {
        return;
      }
      const after = findUndoTargetAfterSnapshot(ctx, state);
      if (!after?.userEntryId) {
        await logLine(ctx, "undo no-op: no after snapshot", state);
        ctx.ui.notify("Nothing to undo.", "info");
        return;
      }
      const navigationMode = await selectNavigationMode(ctx, "Undo");
      if (!navigationMode) {
        return;
      }
      const precheck = navigationMode === "conversationAndWorkspace"
        ? await ensureNoUnsnapshottedChanges(pi, ctx, "undo", state)
        : { currentLeafId: ctx.sessionManager.getLeafId() ?? undefined };
      if (!precheck) {
        return;
      }

      await logLine(
        ctx,
        `undo start currentLeaf=${ctx.sessionManager.getLeafId()} userEntry=${after.userEntryId} beforeCommit=${findBeforeSnapshotForUserEntry(after.userEntryId, state)?.commit}`,
        state,
      );

      state.internalNavigation = "undo";
      state.internalNavigationFailureReported = false;
      state.navigationMode = navigationMode;
      try {
        const result = await ctx.navigateTree(after.userEntryId, { summarize: false });
        await logLine(ctx, `undo navigate result cancelled=${String(result.cancelled)}`, state);
        if (result.cancelled) {
          if (!state.internalNavigationFailureReported) {
            ctx.ui.notify("Undo cancelled.", "error");
          }
          return;
        }

        if (precheck.currentLeafId) {
          await pushRedoTarget(ctx, precheck.currentLeafId, navigationMode, state);
        }

        const userText = extractUserText(ctx.sessionManager.getEntry(after.userEntryId));
        if (userText) {
          ctx.ui.setEditorText(userText);
        }

        ctx.ui.notify(
          navigationMode === "conversationOnly"
            ? "Undo complete. Conversation rewound; current files kept."
            : "Undo complete. Workspace restored to before that turn.",
          "info",
        );
      } finally {
        state.internalNavigation = undefined;
        state.internalNavigationFailureReported = undefined;
        state.navigationMode = undefined;
        state.pendingWorkspaceAnchor = undefined;
      }
    },
  });

  pi.registerCommand("redo", {
    description: "Redo previously undone navigation",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const state = getState(ctx);
      if (!await ensureWorkspaceHistoryAvailable(ctx, state, "redo")) {
        return;
      }
      const redo = await peekRedoTarget(ctx, state);
      if (!redo) {
        await logLine(ctx, "redo no-op: empty stack", state);
        ctx.ui.notify("Nothing to redo.", "info");
        return;
      }
      const navigationMode = redo.navigationMode ?? "conversationAndWorkspace";
      if (
        navigationMode === "conversationAndWorkspace" &&
        !await ensureNoUnsnapshottedChanges(pi, ctx, "redo", state)
      ) {
        return;
      }

      await logLine(
        ctx,
        `redo start currentLeaf=${ctx.sessionManager.getLeafId()} target=${redo.targetId} mode=${navigationMode}`,
        state,
      );

      state.internalNavigation = "redo";
      state.internalNavigationFailureReported = false;
      state.navigationMode = navigationMode;
      try {
        const result = await ctx.navigateTree(redo.targetId, { summarize: false });
        await logLine(ctx, `redo navigate result cancelled=${String(result.cancelled)}`, state);
        if (result.cancelled) {
          if (!state.internalNavigationFailureReported) {
            ctx.ui.notify("Redo cancelled.", "error");
          }
          return;
        }

        await popRedoTarget(ctx, state);

        ctx.ui.notify(
          navigationMode === "conversationOnly"
            ? "Redo complete. Conversation restored; current files kept."
            : "Redo complete. Workspace restored.",
          "info",
        );
      } finally {
        state.internalNavigation = undefined;
        state.internalNavigationFailureReported = undefined;
        state.navigationMode = undefined;
        state.pendingWorkspaceAnchor = undefined;
      }
    },
  });

  pi.registerCommand("checkpoint", {
    description: "Save current workspace state as a manual time-machine checkpoint",
    handler: async (args, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      const state = getState(ctx);
      if (!await ensureWorkspaceHistoryAvailable(ctx, state, "checkpoint")) {
        return;
      }
      if (!await tryRecoverPendingWorkspace(pi, ctx, state, "Checkpoint", true)) {
        return;
      }
      await ensureShadowRepo(pi, ctx, state);
      const label = args.trim() || "manual checkpoint";
      const commit = await createSnapshotCommit(pi, ctx, label, state);

      pi.appendEntry<WorkspaceSnapshot>(SNAPSHOT_TYPE, {
        v: 1,
        kind: "manual",
        commit,
        label,
        createdAt: new Date().toISOString(),
      });

      await clearRedoStack(ctx, state);
      await logLine(ctx, `create manual snapshot entry=${ctx.sessionManager.getLeafId()} label=${label} commit=${commit}`, state);
      ctx.ui.notify(`Checkpoint saved: ${label}`, "info");
    },
  });
}
