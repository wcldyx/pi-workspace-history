import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
  mkdir as fsMkdir,
  rm as fsRm,
  readdir,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import ignore, { type Ignore } from "ignore";
import { homedir } from "node:os";
import path from "node:path";

const SNAPSHOT_TYPE = "workspace-history.snapshot";

const DEFAULT_MAX_SESSIONS_PER_WORKSPACE = 3;
const DEFAULT_MAX_WORKSPACES = 10;

type SnapshotKind = "baseline" | "before" | "after" | "manual";

interface WorkspaceSnapshot {
  v: 1;
  kind: SnapshotKind;
  commit: string;
  turnId?: string;
  promptText?: string;
  beforeSnapshotId?: string;
  userEntryId?: string;
  resultLeafId?: string;
  label?: string;
  createdAt: string;
}

interface RedoItem {
  targetId: string;
  createdAt: string;
}

interface RedoState {
  sessionId: string;
  stack: RedoItem[];
}

interface RuntimeState {
  pendingTurnId?: string;
  pendingBeforeSnapshotId?: string;
  pendingPromptText?: string;
  internalNavigation?: "undo" | "redo";
  cachedSettings?: WorkspaceHistorySettings;
  cachedPaths?: WorkspaceStoragePaths;
  cleanupPromise?: Promise<void>;
  lastCleanupAt?: number;
  initialSnapshotCommit?: string;
  warmedBaselineCommit?: string;
  baselineWarmupPromise?: Promise<void>;
  baselineWarmupGeneration?: number;
  cachedGitignoreSource?: string;
  cachedSnapshotIgnoreMatcher?: Ignore;
}

interface NavigationPrecheckResult {
  currentLeafId?: string;
  currentSnapshot?: CustomEntry<WorkspaceSnapshot>;
}

interface WorkspaceHistorySettings {
  storageDir: string;
  maxSessionsPerWorkspace: number;
  maxWorkspaces: number;
}

interface WorkspaceStoragePaths {
  storageDir: string;
  workspaceHash: string;
  workspaceRoot: string;
  sessionsRoot: string;
  sessionRoot: string;
  shadowGitDir: string;
  redoFile: string;
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

const DEFAULT_EXCLUDES = [
  ".git",
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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
    storageDir,
    maxSessionsPerWorkspace: normalizePositiveInteger(config.maxSessionsPerWorkspace, DEFAULT_MAX_SESSIONS_PER_WORKSPACE),
    maxWorkspaces: normalizePositiveInteger(config.maxWorkspaces, DEFAULT_MAX_WORKSPACES),
  };
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
    sessionRoot,
    shadowGitDir: path.join(sessionRoot, "repo.git"),
    redoFile: path.join(sessionRoot, "redo.json"),
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
  await mkdir(path.dirname(paths.logFile), { recursive: true });
  await mkdir(paths.sessionRoot, { recursive: true });
  return paths;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
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

async function cleanupWorkspaceHistory(ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const settings = await getWorkspaceHistorySettings(ctx, state);
  const paths = await ensureStorageDirs(ctx, state);
  const currentSessionId = ctx.sessionManager.getSessionId();

  const sessionIds = await listSubdirectories(paths.sessionsRoot);
  const sessionRecords = await Promise.all(sessionIds.map(async (sessionId) => {
    const sessionRoot = path.join(paths.sessionsRoot, sessionId);
    const meta = await readJsonFile<SessionMeta>(path.join(sessionRoot, "meta.json"));
    return { sessionId, sessionRoot, lastUsedAt: meta?.lastUsedAt ?? meta?.createdAt ?? "" };
  }));

  const removableSessions = sessionRecords
    .filter((record) => record.sessionId !== currentSessionId)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));

  for (const record of removableSessions.slice(Math.max(0, settings.maxSessionsPerWorkspace - 1))) {
    await fsRm(record.sessionRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  const workspacesRoot = path.join(paths.storageDir, "workspaces");
  const workspaceIds = await listSubdirectories(workspacesRoot);
  const workspaceRecords = await Promise.all(workspaceIds.map(async (workspaceId) => {
    const workspaceRoot = path.join(workspacesRoot, workspaceId);
    const meta = await readJsonFile<WorkspaceMeta>(path.join(workspaceRoot, "meta.json"));
    return { workspaceId, workspaceRoot, lastUsedAt: meta?.lastUsedAt ?? meta?.createdAt ?? "" };
  }));

  const removableWorkspaces = workspaceRecords
    .filter((record) => record.workspaceId !== paths.workspaceHash)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));

  for (const record of removableWorkspaces.slice(Math.max(0, settings.maxWorkspaces - 1))) {
    await fsRm(record.workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function normalizeSnapshotPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

async function getSnapshotIgnoreMatcher(ctx: ExtensionContext, state?: RuntimeState): Promise<Ignore> {
  const gitignorePath = path.join(ctx.cwd, ".gitignore");
  const gitignoreSource = await readFile(gitignorePath, "utf8").catch(() => "");

  if (state?.cachedSnapshotIgnoreMatcher && state.cachedGitignoreSource === gitignoreSource) {
    return state.cachedSnapshotIgnoreMatcher;
  }

  const matcher = ignore();
  matcher.add(DEFAULT_EXCLUDES);
  if (gitignoreSource.trim().length > 0) {
    matcher.add(gitignoreSource);
  }

  if (state) {
    state.cachedGitignoreSource = gitignoreSource;
    state.cachedSnapshotIgnoreMatcher = matcher;
  }

  return matcher;
}

async function filterSnapshotPaths(
  ctx: ExtensionContext,
  relativePaths: string[],
  state?: RuntimeState,
): Promise<string[]> {
  const matcher = await getSnapshotIgnoreMatcher(ctx, state);
  return relativePaths.filter((relativePath) => !matcher.ignores(normalizeSnapshotPath(relativePath)));
}

function parseNullSeparatedPaths(raw: string): string[] {
  return raw
    .split("\0")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseLineSeparatedPaths(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function logLine(ctx: ExtensionContext, line: string, state?: RuntimeState): Promise<void> {
  const paths = await ensureStorageDirs(ctx, state);
  await appendFile(paths.logFile, `[${new Date().toISOString()}] ${line}\n`, "utf8");
}

async function execGit(pi: ExtensionAPI, ctx: ExtensionContext, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: ctx.cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function gitArgs(ctx: ExtensionContext, state: RuntimeState | undefined, ...args: string[]): Promise<string[]> {
  const paths = await getWorkspaceStoragePaths(ctx, state);
  return [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "core.filemode=false",
    "-c",
    "core.quotepath=false",
    "--git-dir",
    paths.shadowGitDir,
    "--work-tree",
    ctx.cwd,
    ...args,
  ];
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

async function listTrackedPaths(pi: ExtensionAPI, ctx: ExtensionContext, state?: RuntimeState): Promise<string[]> {
  const result = await pi.exec("git", await gitArgs(ctx, state, "ls-files", "-z", "--", "."), { cwd: ctx.cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "git ls-files failed");
  }
  return parseNullSeparatedPaths(result.stdout);
}

async function listUntrackedPaths(pi: ExtensionAPI, ctx: ExtensionContext, state?: RuntimeState): Promise<string[]> {
  const result = await pi.exec("git", await gitArgs(ctx, state, "ls-files", "--others", "--exclude-standard", "-z", "--", "."), { cwd: ctx.cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "git ls-files --others failed");
  }
  return parseNullSeparatedPaths(result.stdout);
}

async function stageSnapshotFiles(pi: ExtensionAPI, ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const trackedPaths = await listTrackedPaths(pi, ctx, state);
  const untrackedPaths = await listUntrackedPaths(pi, ctx, state);
  const candidates = await filterSnapshotPaths(ctx, [...new Set([...trackedPaths, ...untrackedPaths])], state);

  if (candidates.length === 0) {
    return;
  }

  const paths = await getWorkspaceStoragePaths(ctx, state);
  const pathspecFile = path.join(paths.sessionRoot, `pathspec-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    await writeFile(pathspecFile, Buffer.from(candidates.join("\0") + "\0", "utf8"));
    await execGit(pi, ctx, [...(await gitArgs(ctx, state, "add", "-A", "--pathspec-from-file", pathspecFile, "--pathspec-file-nul"))]);
  } finally {
    await unlink(pathspecFile).catch(() => undefined);
  }
}

async function ensureShadowRepo(pi: ExtensionAPI, ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const paths = await ensureStorageDirs(ctx, state);
  if (await exists(paths.shadowGitDir)) {
    return;
  }

  await execGit(pi, ctx, ["init", "--bare", paths.shadowGitDir]);
  await logLine(ctx, `init repo session=${ctx.sessionManager.getSessionId()} gitDir=${paths.shadowGitDir}`, state);
}

async function createSnapshotCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  label: string,
  state?: RuntimeState,
): Promise<string> {
  await ensureShadowRepo(pi, ctx, state);
  await stageSnapshotFiles(pi, ctx, state);
  await execGit(pi, ctx, [...(await gitCommitArgs(ctx, state, "commit", "--allow-empty", "-m", `[workspace-history] ${label}`))]);
  await touchWorkspaceAndSessionMeta(ctx, state);
  scheduleCleanup(ctx, state);
  return execGit(pi, ctx, await gitArgs(ctx, state, "rev-parse", "HEAD"));
}

async function listSnapshotPathsAtCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  commit: string,
): Promise<string[]> {
  const result = await pi.exec("git", await gitArgs(ctx, undefined, "ls-tree", "-r", "--name-only", "-z", commit), { cwd: ctx.cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "git ls-tree failed");
  }
  return parseNullSeparatedPaths(result.stdout);
}

async function checkoutTrackedPaths(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  commit: string,
  pathsToCheckout: string[],
): Promise<void> {
  if (pathsToCheckout.length === 0) {
    return;
  }

  const paths = await getWorkspaceStoragePaths(ctx, undefined);
  const pathspecFile = path.join(paths.sessionRoot, `restore-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    await writeFile(pathspecFile, Buffer.from(pathsToCheckout.join("\0") + "\0", "utf8"));
    await execGit(pi, ctx, [...(await gitArgs(ctx, undefined, "checkout", commit, "--pathspec-from-file", pathspecFile, "--pathspec-file-nul"))]);
  } finally {
    await unlink(pathspecFile).catch(() => undefined);
  }
}

async function removeManagedPaths(cwd: string, paths: string[]): Promise<void> {
  const sorted = [...paths].sort((a, b) => b.length - a.length);
  for (const relativePath of sorted) {
    const absolutePath = path.join(cwd, relativePath);
    await fsRm(absolutePath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function restoreSnapshotCommit(pi: ExtensionAPI, ctx: ExtensionContext, commit: string, state?: RuntimeState): Promise<void> {
  await ensureShadowRepo(pi, ctx, state);

  const currentTracked = await listTrackedPaths(pi, ctx, state);
  const currentUntracked = await listUntrackedPaths(pi, ctx, state);
  const currentManaged = await filterSnapshotPaths(ctx, [...new Set([...currentTracked, ...currentUntracked])], state);
  const targetManaged = await filterSnapshotPaths(ctx, await listSnapshotPathsAtCommit(pi, ctx, commit), state);

  const targetSet = new Set(targetManaged);
  const pathsToRemove = currentManaged.filter((relativePath) => !targetSet.has(relativePath));

  await removeManagedPaths(ctx.cwd, pathsToRemove);

  for (const relativePath of targetManaged) {
    const parentDir = path.dirname(path.join(ctx.cwd, relativePath));
    await fsMkdir(parentDir, { recursive: true });
  }

  await checkoutTrackedPaths(pi, ctx, commit, targetManaged);
}

async function restoreSnapshotCommitSafely(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  targetCommit: string,
  state?: RuntimeState,
): Promise<void> {
  const rollbackCommit = await createSnapshotCommit(pi, ctx, `rollback ${randomUUID()}`, state);

  try {
    await restoreSnapshotCommit(pi, ctx, targetCommit, state);
    await touchWorkspaceAndSessionMeta(ctx, state);
    scheduleCleanup(ctx, state);
  } catch (error) {
    try {
      await restoreSnapshotCommit(pi, ctx, rollbackCommit, state);
    } catch (rollbackError) {
      throw new Error(
        `restore failed: ${String(error)}; rollback failed: ${String(rollbackError)}`,
      );
    }
    throw error;
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

async function clearRedoStack(ctx: ExtensionContext, state?: RuntimeState): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  await writeRedoState(ctx, {
    sessionId,
    stack: [],
  }, state);
}

async function pushRedoTarget(ctx: ExtensionContext, targetId: string, state?: RuntimeState): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  const redoState = (await readRedoState(ctx, state)) ?? { sessionId, stack: [] };
  const next: RedoState = {
    sessionId,
    stack: [...(redoState.sessionId === sessionId ? redoState.stack : []), { targetId, createdAt: new Date().toISOString() }],
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

function isSnapshotEntry(entry: SessionEntry | undefined): entry is CustomEntry<WorkspaceSnapshot> {
  return entry?.type === "custom" && entry.customType === SNAPSHOT_TYPE;
}

function hasSnapshotData(entry: CustomEntry<WorkspaceSnapshot> | undefined): entry is CustomEntry<WorkspaceSnapshot> & { data: WorkspaceSnapshot } {
  return !!entry?.data;
}

function isUserMessageEntry(entry: SessionEntry | undefined): entry is SessionMessageEntry {
  return entry?.type === "message" && entry.message.role === "user";
}

function getSnapshotEntries(ctx: ExtensionContext): Array<CustomEntry<WorkspaceSnapshot>> {
  return getEntries(ctx).filter(isSnapshotEntry);
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

function findSnapshotById(ctx: ExtensionContext, snapshotId: string | undefined): CustomEntry<WorkspaceSnapshot> | undefined {
  if (!snapshotId) {
    return undefined;
  }

  const entry = ctx.sessionManager.getEntry(snapshotId);
  return isSnapshotEntry(entry) ? entry : undefined;
}

function findLastAfterSnapshot(ctx: ExtensionContext): CustomEntry<WorkspaceSnapshot> | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (isSnapshotEntry(entry) && hasSnapshotData(entry) && entry.data.kind === "after") {
      return entry;
    }
  }
  return undefined;
}

function findAfterSnapshotByResultLeafId(ctx: ExtensionContext, resultLeafId: string): CustomEntry<WorkspaceSnapshot> | undefined {
  return getSnapshotEntries(ctx).find(
    (entry) => hasSnapshotData(entry) && entry.data.kind === "after" && entry.data.resultLeafId === resultLeafId,
  );
}

function findBeforeSnapshotForUserEntry(ctx: ExtensionContext, userEntryId: string): CustomEntry<WorkspaceSnapshot> | undefined {
  const after = getSnapshotEntries(ctx).find(
    (entry) => hasSnapshotData(entry) && entry.data.kind === "after" && entry.data.userEntryId === userEntryId,
  );
  return hasSnapshotData(after) ? findSnapshotById(ctx, after.data.beforeSnapshotId) : undefined;
}

function findNearestSnapshotOnChain(ctx: ExtensionContext, startId: string | null | undefined): CustomEntry<WorkspaceSnapshot> | undefined {
  let currentId = startId ?? null;
  while (currentId) {
    const entry: SessionEntry | undefined = ctx.sessionManager.getEntry(currentId);
    if (!entry) {
      return undefined;
    }
    if (isSnapshotEntry(entry)) {
      return entry;
    }
    currentId = entry.parentId;
  }
  return undefined;
}

function resolveSnapshotForTreeTarget(
  ctx: ExtensionContext,
  targetId: string,
): CustomEntry<WorkspaceSnapshot> | undefined {
  const target = ctx.sessionManager.getEntry(targetId);
  if (!target) {
    return undefined;
  }

  if (isSnapshotEntry(target)) {
    return target;
  }

  if (isUserMessageEntry(target)) {
    return findBeforeSnapshotForUserEntry(ctx, target.id) ?? findNearestSnapshotOnChain(ctx, target.parentId);
  }

  return findAfterSnapshotByResultLeafId(ctx, targetId) ?? findNearestSnapshotOnChain(ctx, targetId);
}

function findUserEntryAfter(ctx: ExtensionContext, beforeSnapshotId: string): SessionMessageEntry | undefined {
  const branch = ctx.sessionManager.getBranch();
  const startIndex = branch.findIndex((entry) => entry.id === beforeSnapshotId);
  if (startIndex === -1) {
    return undefined;
  }

  for (let i = startIndex + 1; i < branch.length; i += 1) {
    const entry = branch[i];
    if (isUserMessageEntry(entry)) {
      return entry;
    }
  }

  return undefined;
}

async function ensureBaselineSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state?: RuntimeState,
  commitOverride?: string,
): Promise<void> {
  const existing = getSnapshotEntries(ctx);
  if (existing.length > 0) {
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
): Promise<boolean> {
  await ensureShadowRepo(pi, ctx, state);

  const diffResult = await pi.exec(
    "git",
    await gitArgs(ctx, state, "diff", "--name-only", commit, "--", "."),
    { cwd: ctx.cwd },
  );

  if (diffResult.code !== 0) {
    throw new Error(diffResult.stderr || diffResult.stdout || "git diff failed");
  }

  const dirtyDiffPaths = await filterSnapshotPaths(ctx, parseLineSeparatedPaths(diffResult.stdout), state);
  if (dirtyDiffPaths.length > 0) {
    return true;
  }

  const untrackedResult = await pi.exec(
    "git",
    await gitArgs(ctx, state, "ls-files", "--others", "--exclude-standard", "-z", "--", "."),
    { cwd: ctx.cwd },
  );

  if (untrackedResult.code !== 0) {
    throw new Error(untrackedResult.stderr || untrackedResult.stdout || "git ls-files failed");
  }

  const untrackedPaths = await filterSnapshotPaths(ctx, parseNullSeparatedPaths(untrackedResult.stdout), state);
  return untrackedPaths.length > 0;
}

async function isWorkspaceDirtyAgainstSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: CustomEntry<WorkspaceSnapshot> | undefined,
  state?: RuntimeState,
): Promise<boolean> {
  if (!hasSnapshotData(snapshot)) {
    return false;
  }
  return isWorkspaceDirtyAgainstCommit(pi, ctx, snapshot.data.commit, state);
}

async function restoreResolvedSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  source: string,
  targetId: string,
  snapshot: CustomEntry<WorkspaceSnapshot>,
  state?: RuntimeState,
): Promise<void> {
  if (!hasSnapshotData(snapshot)) {
    throw new Error("snapshot data missing");
  }

  await restoreSnapshotCommitSafely(pi, ctx, snapshot.data.commit, state);
  await logLine(
    ctx,
    `restore source=${source} target=${targetId} snapshot=${snapshot.id} kind=${snapshot.data.kind} commit=${snapshot.data.commit} ok`,
    state,
  );
}

const CLEANUP_INTERVAL_MS = 60_000;

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
    .catch(() => undefined)
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
  const currentLeafId = ctx.sessionManager.getLeafId() ?? undefined;
  const currentSnapshot = currentLeafId ? resolveSnapshotForTreeTarget(ctx, currentLeafId) : undefined;

  try {
    const dirty = await isWorkspaceDirtyAgainstSnapshot(pi, ctx, currentSnapshot, state);
    if (dirty) {
      await logLine(ctx, `${source} blocked: unsnapshotted changes currentLeaf=${currentLeafId}`, state);
      ctx.ui.notify("The workspace has unsnapshotted changes. Run /checkpoint first, or clean them up before switching.", "error");
      return undefined;
    }
  } catch (error) {
    await logLine(ctx, `${source} dirty-check failed currentLeaf=${currentLeafId} error=${String(error)}`, state);
    ctx.ui.notify("Workspace dirty check failed. Navigation cancelled.", "error");
    return undefined;
  }

  return { currentLeafId, currentSnapshot };
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

  function scheduleBaselineWarmup(ctx: ExtensionContext, state: RuntimeState): void {
    if (state.baselineWarmupPromise || state.warmedBaselineCommit || getSnapshotEntries(ctx).length > 0) {
      return;
    }

    const generation = (state.baselineWarmupGeneration ?? 0) + 1;
    state.baselineWarmupGeneration = generation;
    state.baselineWarmupPromise = new Promise((resolve) => {
      setTimeout(() => {
        void (async () => {
          try {
            if (state.baselineWarmupGeneration !== generation || getSnapshotEntries(ctx).length > 0) {
              return;
            }

            const commit = await createSnapshotCommit(pi, ctx, "baseline warmup", state);
            if (state.baselineWarmupGeneration !== generation || getSnapshotEntries(ctx).length > 0) {
              return;
            }

            state.warmedBaselineCommit = commit;
            await logLine(ctx, `warm baseline commit=${commit}`, state);
          } catch (error) {
            await logLine(ctx, `warm baseline failed error=${String(error)}`, state).catch(() => undefined);
          } finally {
            if (state.baselineWarmupGeneration === generation) {
              state.baselineWarmupPromise = undefined;
            }
            resolve();
          }
        })();
      }, 0);
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const state = getState(ctx);
    state.pendingTurnId = undefined;
    state.pendingBeforeSnapshotId = undefined;
    state.pendingPromptText = undefined;
    state.internalNavigation = undefined;
    state.initialSnapshotCommit = undefined;
    state.warmedBaselineCommit = undefined;
    state.baselineWarmupPromise = undefined;
    state.baselineWarmupGeneration = undefined;

    await getWorkspaceHistorySettings(ctx, state);
    await getWorkspaceStoragePaths(ctx, state);
    await touchWorkspaceAndSessionMeta(ctx, state);
    scheduleCleanup(ctx, state);
    await ensureShadowRepo(pi, ctx, state);
    scheduleBaselineWarmup(ctx, state);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const state = getState(ctx);
    state.pendingPromptText = event.prompt;
    await ensureShadowRepo(pi, ctx, state);
  });

  pi.on("turn_start", async (_event, ctx) => {
    const state = getState(ctx);
    if (state.pendingTurnId || state.pendingBeforeSnapshotId) {
      return;
    }

    await clearRedoStack(ctx, state);

    const turnId = randomUUID();
    const isFirstSnapshot = getSnapshotEntries(ctx).length === 0;
    let commit: string;

    if (isFirstSnapshot) {
      const warmedCommit = state.warmedBaselineCommit;
      if (warmedCommit && !await isWorkspaceDirtyAgainstCommit(pi, ctx, warmedCommit, state)) {
        commit = warmedCommit;
      } else {
        if (warmedCommit) {
          await logLine(ctx, `discard warm baseline commit=${warmedCommit} reason=workspace-changed`, state);
        }
        commit = await createSnapshotCommit(pi, ctx, `before ${turnId}`, state);
      }
      state.initialSnapshotCommit = commit;
      state.warmedBaselineCommit = undefined;
      state.baselineWarmupGeneration = undefined;
      await ensureBaselineSnapshot(pi, ctx, state, commit);
    } else {
      commit = await createSnapshotCommit(pi, ctx, `before ${turnId}`, state);
    }

    pi.appendEntry<WorkspaceSnapshot>(SNAPSHOT_TYPE, {
      v: 1,
      kind: "before",
      commit,
      turnId,
      promptText: state.pendingPromptText,
      createdAt: new Date().toISOString(),
    });

    state.pendingTurnId = turnId;
    state.pendingBeforeSnapshotId = ctx.sessionManager.getLeafId() ?? undefined;

    await logLine(
      ctx,
      `create before snapshot turn=${turnId} entry=${state.pendingBeforeSnapshotId} commit=${commit} leaf=${ctx.sessionManager.getLeafId()}`,
      state,
    );
  });

  pi.on("turn_end", async (event, ctx) => {
    const state = getState(ctx);
    try {
      if (!state.pendingTurnId || !state.pendingBeforeSnapshotId) {
        return;
      }

      if (!isAssistantTurnMessage(event.message)) {
        await logLine(ctx, `skip after snapshot: turn_end message role=${String((event.message as { role?: unknown })?.role ?? "unknown")}`, state);
        return;
      }

      const resultLeafId = ctx.sessionManager.getLeafId() ?? undefined;
      const userEntry = findUserEntryAfter(ctx, state.pendingBeforeSnapshotId);

      const commit = await createSnapshotCommit(pi, ctx, `after ${state.pendingTurnId}`, state);
      pi.appendEntry<WorkspaceSnapshot>(SNAPSHOT_TYPE, {
        v: 1,
        kind: "after",
        commit,
        turnId: state.pendingTurnId,
        beforeSnapshotId: state.pendingBeforeSnapshotId,
        userEntryId: userEntry?.id,
        resultLeafId,
        createdAt: new Date().toISOString(),
      });

      const afterSnapshotId = ctx.sessionManager.getLeafId();
      await logLine(
        ctx,
        `create after snapshot turn=${state.pendingTurnId} entry=${afterSnapshotId} resultLeaf=${resultLeafId} userEntry=${userEntry?.id} commit=${commit}`,
        state,
      );

      state.pendingTurnId = undefined;
      state.pendingBeforeSnapshotId = undefined;
      state.pendingPromptText = undefined;
    } catch (error) {
      await logLine(ctx, `after snapshot failed error=${String(error)}`, state);
      throw error;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = getState(ctx);
    if (!state.pendingTurnId && !state.pendingBeforeSnapshotId && !state.pendingPromptText) {
      return;
    }

    await logLine(
      ctx,
      `clear pending turn without after snapshot turn=${state.pendingTurnId} beforeSnapshot=${state.pendingBeforeSnapshotId}`,
      state,
    );
    state.pendingTurnId = undefined;
    state.pendingBeforeSnapshotId = undefined;
    state.pendingPromptText = undefined;
  });

  pi.on("session_before_tree", async (event, ctx) => {
    const state = getState(ctx);
    await logLine(
      ctx,
      `session_before_tree target=${event.preparation.targetId} oldLeaf=${event.preparation.oldLeafId} summarize=${String(event.preparation.userWantsSummary)} source=${state.internalNavigation ?? "tree"}`,
      state,
    );

    if (event.preparation.userWantsSummary && !state.internalNavigation) {
      ctx.ui.notify("Manual /tree with summary may desync workspace and chat state. Disable summary before switching.", "error");
      return { cancel: true };
    }

    const currentLeafId = ctx.sessionManager.getLeafId();
    const currentSnapshot = currentLeafId ? resolveSnapshotForTreeTarget(ctx, currentLeafId) : undefined;

    try {
      const dirty = await isWorkspaceDirtyAgainstSnapshot(pi, ctx, currentSnapshot, state);
      if (dirty) {
        ctx.ui.notify("The workspace has unsnapshotted changes. Run /checkpoint first, or clean them up before switching.", "error");
        return { cancel: true };
      }
    } catch (error) {
      await logLine(ctx, `dirty-check failed target=${event.preparation.targetId} error=${String(error)}`, state);
      ctx.ui.notify("Workspace dirty check failed. Tree navigation cancelled.", "error");
      return { cancel: true };
    }

    const snapshot = resolveSnapshotForTreeTarget(ctx, event.preparation.targetId);
    if (!hasSnapshotData(snapshot)) {
      ctx.ui.notify("This history node has no workspace snapshot. Cannot restore precisely.", "error");
      return { cancel: true };
    }

    const snapshotData = snapshot.data;

    try {
      await restoreResolvedSnapshot(pi, ctx, state.internalNavigation ?? "tree", event.preparation.targetId, snapshot, state);
    } catch (error) {
      await logLine(
        ctx,
        `restore source=${state.internalNavigation ?? "tree"} target=${event.preparation.targetId} snapshot=${snapshot.id} commit=${snapshotData.commit} error=${String(error)}`,
        state,
      );
      ctx.ui.notify("Workspace restore failed. Tree navigation cancelled.", "error");
      return { cancel: true };
    }

    return undefined;
  });

  pi.on("session_tree", async (_event, ctx) => {
    const state = getState(ctx);
    if (state.internalNavigation) {
      return;
    }
    await clearRedoStack(ctx, state);
  });

  pi.registerCommand("undo", {
    description: "Undo last agent turn and restore workspace",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const state = getState(ctx);
      const precheck = await ensureNoUnsnapshottedChanges(pi, ctx, "undo", state);
      if (!precheck) {
        return;
      }

      const after = findLastAfterSnapshot(ctx);
      if (!hasSnapshotData(after) || !after.data.userEntryId) {
        await logLine(ctx, "undo no-op: no after snapshot", state);
        ctx.ui.notify("Nothing to undo.", "info");
        return;
      }

      await logLine(
        ctx,
        `undo start currentLeaf=${ctx.sessionManager.getLeafId()} userEntry=${after.data.userEntryId} beforeSnapshot=${after.data.beforeSnapshotId}`,
        state,
      );

      state.internalNavigation = "undo";
      try {
        const result = await ctx.navigateTree(after.data.userEntryId, { summarize: false });
        await logLine(ctx, `undo navigate result cancelled=${String(result.cancelled)}`, state);
        if (result.cancelled) {
          ctx.ui.notify("Undo cancelled.", "error");
          return;
        }

        if (precheck.currentLeafId) {
          await pushRedoTarget(ctx, precheck.currentLeafId, state);
        }

        const userText = extractUserText(ctx.sessionManager.getEntry(after.data.userEntryId));
        if (userText) {
          ctx.ui.setEditorText(userText);
        }

        ctx.ui.notify("Undo complete. Workspace restored to before that turn.", "info");
      } finally {
        state.internalNavigation = undefined;
      }
    },
  });

  pi.registerCommand("redo", {
    description: "Redo previously undone agent turn and restore workspace",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const state = getState(ctx);
      const precheck = await ensureNoUnsnapshottedChanges(pi, ctx, "redo", state);
      if (!precheck) {
        return;
      }

      const redo = await peekRedoTarget(ctx, state);
      if (!redo) {
        await logLine(ctx, "redo no-op: empty stack", state);
        ctx.ui.notify("Nothing to redo.", "info");
        return;
      }

      await logLine(ctx, `redo start currentLeaf=${ctx.sessionManager.getLeafId()} target=${redo.targetId}`, state);

      state.internalNavigation = "redo";
      try {
        const result = await ctx.navigateTree(redo.targetId, { summarize: false });
        await logLine(ctx, `redo navigate result cancelled=${String(result.cancelled)}`, state);
        if (result.cancelled) {
          ctx.ui.notify("Redo cancelled.", "error");
          return;
        }

        await popRedoTarget(ctx, state);

        ctx.ui.notify("Redo complete. Workspace restored.", "info");
      } finally {
        state.internalNavigation = undefined;
      }
    },
  });

  pi.registerCommand("checkpoint", {
    description: "Save current workspace state as a manual time-machine checkpoint",
    handler: async (args, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      const state = getState(ctx);
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
