import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, access, unlink, mkdir as fsMkdir, rm as fsRm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SNAPSHOT_TYPE = "workspace-history.snapshot";

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
  internalNavigation?: "undo" | "redo";
}

interface NavigationPrecheckResult {
  currentLeafId?: string;
  currentSnapshot?: CustomEntry<WorkspaceSnapshot>;
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

function getRootDir(cwd: string): string {
  return path.join(cwd, ".pi", "workspace-history");
}

function getSessionRootDir(cwd: string, sessionId: string): string {
  return path.join(getRootDir(cwd), "sessions", sessionId);
}

function getShadowGitDir(cwd: string, sessionId: string): string {
  return path.join(getSessionRootDir(cwd, sessionId), "repo.git");
}

function getRedoFile(cwd: string, sessionId: string): string {
  return path.join(getSessionRootDir(cwd, sessionId), "redo.json");
}

function getLogFile(cwd: string): string {
  return path.join(getRootDir(cwd), "logs", "timemachine.log");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirs(cwd: string, sessionId?: string): Promise<void> {
  await mkdir(path.join(getRootDir(cwd), "logs"), { recursive: true });
  if (sessionId) {
    await mkdir(getSessionRootDir(cwd, sessionId), { recursive: true });
  }
}

function gitArgs(cwd: string, sessionId: string, ...args: string[]): string[] {
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
    getShadowGitDir(cwd, sessionId),
    "--work-tree",
    cwd,
    ...args,
  ];
}

function gitCommitArgs(cwd: string, sessionId: string, ...args: string[]): string[] {
  return [
    "-c",
    "user.name=workspace-history",
    "-c",
    "user.email=workspace-history@local",
    ...gitArgs(cwd, sessionId, ...args),
  ];
}

function shouldExcludeSnapshotPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const baseName = segments[segments.length - 1] ?? "";

  if (segments.some((segment) => segment === ".git" || segment === "node_modules")) {
    return true;
  }

  if (normalized === ".pi/workspace-history" || normalized.startsWith(".pi/workspace-history/")) {
    return true;
  }

  if (segments.some((segment) => segment === "dist" || segment === "build" || segment === ".cache" || segment === ".next" || segment === ".turbo" || segment === "coverage")) {
    return true;
  }

  if (baseName === ".env" || baseName.startsWith(".env.")) {
    return true;
  }

  return false;
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

async function listTrackedPaths(pi: ExtensionAPI, cwd: string, sessionId: string): Promise<string[]> {
  const result = await pi.exec("git", gitArgs(cwd, sessionId, "ls-files", "-z", "--", "."), { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "git ls-files failed");
  }
  return parseNullSeparatedPaths(result.stdout);
}

async function listUntrackedPaths(pi: ExtensionAPI, cwd: string, sessionId: string): Promise<string[]> {
  const result = await pi.exec("git", gitArgs(cwd, sessionId, "ls-files", "--others", "--exclude-standard", "-z", "--", "."), { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "git ls-files --others failed");
  }
  return parseNullSeparatedPaths(result.stdout);
}

async function stageSnapshotFiles(pi: ExtensionAPI, cwd: string, sessionId: string): Promise<void> {
  const trackedPaths = await listTrackedPaths(pi, cwd, sessionId);
  const untrackedPaths = await listUntrackedPaths(pi, cwd, sessionId);
  const candidates = [...new Set([...trackedPaths, ...untrackedPaths])].filter((relativePath) => !shouldExcludeSnapshotPath(relativePath));

  if (candidates.length === 0) {
    return;
  }

  const pathspecFile = path.join(getSessionRootDir(cwd, sessionId), `pathspec-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    await writeFile(pathspecFile, Buffer.from(candidates.join("\0") + "\0", "utf8"));
    await execGit(pi, cwd, gitArgs(cwd, sessionId, "add", "-A", "--pathspec-from-file", pathspecFile, "--pathspec-file-nul"));
  } finally {
    await unlink(pathspecFile).catch(() => undefined);
  }
}

async function logLine(cwd: string, line: string): Promise<void> {
  await ensureDirs(cwd);
  await appendFile(getLogFile(cwd), `[${new Date().toISOString()}] ${line}\n`, "utf8");
}

async function execGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function ensureShadowRepo(pi: ExtensionAPI, cwd: string, sessionId: string): Promise<void> {
  await ensureDirs(cwd, sessionId);

  const gitDir = getShadowGitDir(cwd, sessionId);
  if (await exists(gitDir)) {
    return;
  }

  await execGit(pi, cwd, ["init", "--bare", gitDir]);
  await logLine(cwd, `init repo session=${sessionId} gitDir=${gitDir}`);
}

async function createSnapshotCommit(
  pi: ExtensionAPI,
  cwd: string,
  sessionId: string,
  label: string,
): Promise<string> {
  await ensureShadowRepo(pi, cwd, sessionId);
  await stageSnapshotFiles(pi, cwd, sessionId);
  await execGit(pi, cwd, [...gitCommitArgs(cwd, sessionId, "commit", "--allow-empty", "-m", `[workspace-history] ${label}`)]);
  return execGit(pi, cwd, gitArgs(cwd, sessionId, "rev-parse", "HEAD"));
}

async function listSnapshotPathsAtCommit(
  pi: ExtensionAPI,
  cwd: string,
  sessionId: string,
  commit: string,
): Promise<string[]> {
  const result = await pi.exec("git", gitArgs(cwd, sessionId, "ls-tree", "-r", "--name-only", "-z", commit), { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "git ls-tree failed");
  }
  return parseNullSeparatedPaths(result.stdout);
}

async function checkoutTrackedPaths(
  pi: ExtensionAPI,
  cwd: string,
  sessionId: string,
  commit: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  const pathspecFile = path.join(getSessionRootDir(cwd, sessionId), `restore-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    await writeFile(pathspecFile, Buffer.from(paths.join("\0") + "\0", "utf8"));
    await execGit(pi, cwd, gitArgs(cwd, sessionId, "checkout", commit, "--pathspec-from-file", pathspecFile, "--pathspec-file-nul"));
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

async function restoreSnapshotCommit(pi: ExtensionAPI, cwd: string, sessionId: string, commit: string): Promise<void> {
  await ensureShadowRepo(pi, cwd, sessionId);

  const currentTracked = await listTrackedPaths(pi, cwd, sessionId);
  const currentUntracked = await listUntrackedPaths(pi, cwd, sessionId);
  const currentManaged = [...new Set([...currentTracked, ...currentUntracked])].filter(
    (relativePath) => !shouldExcludeSnapshotPath(relativePath),
  );
  const targetManaged = (await listSnapshotPathsAtCommit(pi, cwd, sessionId, commit)).filter(
    (relativePath) => !shouldExcludeSnapshotPath(relativePath),
  );

  const targetSet = new Set(targetManaged);
  const pathsToRemove = currentManaged.filter((relativePath) => !targetSet.has(relativePath));

  await removeManagedPaths(cwd, pathsToRemove);

  for (const relativePath of targetManaged) {
    const parentDir = path.dirname(path.join(cwd, relativePath));
    await fsMkdir(parentDir, { recursive: true });
  }

  await checkoutTrackedPaths(pi, cwd, sessionId, commit, targetManaged);
}

async function restoreSnapshotCommitSafely(
  pi: ExtensionAPI,
  cwd: string,
  sessionId: string,
  targetCommit: string,
): Promise<void> {
  const rollbackCommit = await createSnapshotCommit(pi, cwd, sessionId, `rollback ${randomUUID()}`);

  try {
    await restoreSnapshotCommit(pi, cwd, sessionId, targetCommit);
  } catch (error) {
    try {
      await restoreSnapshotCommit(pi, cwd, sessionId, rollbackCommit);
    } catch (rollbackError) {
      throw new Error(
        `restore failed: ${String(error)}; rollback failed: ${String(rollbackError)}`,
      );
    }
    throw error;
  }
}

async function readRedoState(cwd: string, sessionId: string): Promise<RedoState | undefined> {
  try {
    const raw = await readFile(getRedoFile(cwd, sessionId), "utf8");
    return JSON.parse(raw) as RedoState;
  } catch {
    return undefined;
  }
}

async function writeRedoState(cwd: string, sessionId: string, state: RedoState): Promise<void> {
  await ensureDirs(cwd, sessionId);
  await writeFile(getRedoFile(cwd, sessionId), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function clearRedoStack(ctx: ExtensionContext): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  await writeRedoState(ctx.cwd, sessionId, {
    sessionId: ctx.sessionManager.getSessionId(),
    stack: [],
  });
}

async function pushRedoTarget(ctx: ExtensionContext, targetId: string): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  const state = (await readRedoState(ctx.cwd, sessionId)) ?? { sessionId, stack: [] };
  const next: RedoState = {
    sessionId,
    stack: [...(state.sessionId === sessionId ? state.stack : []), { targetId, createdAt: new Date().toISOString() }],
  };
  await writeRedoState(ctx.cwd, sessionId, next);
}

async function popRedoTarget(ctx: ExtensionContext): Promise<RedoItem | undefined> {
  const sessionId = ctx.sessionManager.getSessionId();
  const state = await readRedoState(ctx.cwd, sessionId);
  if (!state || state.sessionId !== sessionId || state.stack.length === 0) {
    return undefined;
  }

  const stack = [...state.stack];
  const item = stack.pop();
  await writeRedoState(ctx.cwd, sessionId, { sessionId, stack });
  return item;
}

async function peekRedoTarget(ctx: ExtensionContext): Promise<RedoItem | undefined> {
  const sessionId = ctx.sessionManager.getSessionId();
  const state = await readRedoState(ctx.cwd, sessionId);
  if (!state || state.sessionId !== sessionId || state.stack.length === 0) {
    return undefined;
  }
  return state.stack[state.stack.length - 1];
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

async function ensureBaselineSnapshot(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const existing = getSnapshotEntries(ctx);
  if (existing.length > 0) {
    return;
  }

  const sessionId = ctx.sessionManager.getSessionId();
  const commit = await createSnapshotCommit(pi, ctx.cwd, sessionId, "baseline");
  pi.appendEntry<WorkspaceSnapshot>(SNAPSHOT_TYPE, {
    v: 1,
    kind: "baseline",
    commit,
    createdAt: new Date().toISOString(),
  });
  const snapshotId = ctx.sessionManager.getLeafId();
  await logLine(ctx.cwd, `create baseline snapshot entry=${snapshotId} commit=${commit} leaf=${snapshotId}`);
}

async function isWorkspaceDirtyAgainstSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: CustomEntry<WorkspaceSnapshot> | undefined,
): Promise<boolean> {
  if (!hasSnapshotData(snapshot)) {
    return false;
  }

  const sessionId = ctx.sessionManager.getSessionId();
  await ensureShadowRepo(pi, ctx.cwd, sessionId);

  const diffResult = await pi.exec(
    "git",
    gitArgs(ctx.cwd, sessionId, "diff", "--name-only", snapshot.data.commit, "--", "."),
    { cwd: ctx.cwd },
  );

  if (diffResult.code !== 0) {
    throw new Error(diffResult.stderr || diffResult.stdout || "git diff failed");
  }

  const dirtyDiffPaths = parseLineSeparatedPaths(diffResult.stdout).filter(
    (relativePath) => !shouldExcludeSnapshotPath(relativePath),
  );

  if (dirtyDiffPaths.length > 0) {
    await logLine(
      ctx.cwd,
      `dirty-check dirty reason=diff leaf=${ctx.sessionManager.getLeafId()} snapshot=${snapshot.id} paths=${dirtyDiffPaths.join("|")}`,
    );
    return true;
  }

  const untrackedResult = await pi.exec(
    "git",
    gitArgs(ctx.cwd, sessionId, "ls-files", "--others", "--exclude-standard", "-z", "--", "."),
    { cwd: ctx.cwd },
  );

  if (untrackedResult.code !== 0) {
    throw new Error(untrackedResult.stderr || untrackedResult.stdout || "git ls-files failed");
  }

  const untrackedPaths = parseNullSeparatedPaths(untrackedResult.stdout).filter(
    (relativePath) => !shouldExcludeSnapshotPath(relativePath),
  );

  if (untrackedPaths.length > 0) {
    await logLine(
      ctx.cwd,
      `dirty-check dirty reason=untracked leaf=${ctx.sessionManager.getLeafId()} snapshot=${snapshot.id} paths=${untrackedPaths.join("|")}`,
    );
  }

  return untrackedPaths.length > 0;
}

async function restoreResolvedSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  source: string,
  targetId: string,
  snapshot: CustomEntry<WorkspaceSnapshot>,
): Promise<void> {
  if (!hasSnapshotData(snapshot)) {
    throw new Error("snapshot data missing");
  }

  const sessionId = ctx.sessionManager.getSessionId();
  await restoreSnapshotCommitSafely(pi, ctx.cwd, sessionId, snapshot.data.commit);
  await logLine(
    ctx.cwd,
    `restore source=${source} target=${targetId} snapshot=${snapshot.id} kind=${snapshot.data.kind} commit=${snapshot.data.commit} ok`,
  );
}

async function ensureNoUnsnapshottedChanges(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  source: string,
): Promise<NavigationPrecheckResult | undefined> {
  const currentLeafId = ctx.sessionManager.getLeafId() ?? undefined;
  const currentSnapshot = currentLeafId ? resolveSnapshotForTreeTarget(ctx, currentLeafId) : undefined;

  try {
    const dirty = await isWorkspaceDirtyAgainstSnapshot(pi, ctx, currentSnapshot);
    if (dirty) {
      await logLine(ctx.cwd, `${source} blocked: unsnapshotted changes currentLeaf=${currentLeafId}`);
      ctx.ui.notify("The workspace has unsnapshotted changes. Run /checkpoint first, or clean them up before switching.", "error");
      return undefined;
    }
  } catch (error) {
    await logLine(ctx.cwd, `${source} dirty-check failed currentLeaf=${currentLeafId} error=${String(error)}`);
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

  pi.on("session_start", async (_event, ctx) => {
    const state = getState(ctx);
    state.pendingTurnId = undefined;
    state.pendingBeforeSnapshotId = undefined;
    state.internalNavigation = undefined;

    const sessionId = ctx.sessionManager.getSessionId();
    await ensureShadowRepo(pi, ctx.cwd, sessionId);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const state = getState(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    await ensureShadowRepo(pi, ctx.cwd, sessionId);
    await ensureBaselineSnapshot(pi, ctx);
    await clearRedoStack(ctx);

    const turnId = randomUUID();
    const commit = await createSnapshotCommit(pi, ctx.cwd, sessionId, `before ${turnId}`);

    pi.appendEntry<WorkspaceSnapshot>(SNAPSHOT_TYPE, {
      v: 1,
      kind: "before",
      commit,
      turnId,
      promptText: event.prompt,
      createdAt: new Date().toISOString(),
    });

    state.pendingTurnId = turnId;
    state.pendingBeforeSnapshotId = ctx.sessionManager.getLeafId() ?? undefined;

    await logLine(
      ctx.cwd,
      `create before snapshot turn=${turnId} entry=${state.pendingBeforeSnapshotId} commit=${commit} leaf=${ctx.sessionManager.getLeafId()}`,
    );
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
      const state = getState(ctx);
      if (!state.pendingTurnId || !state.pendingBeforeSnapshotId) {
        return;
      }

      if (!isAssistantTurnMessage(event.message)) {
        await logLine(ctx.cwd, `skip after snapshot: turn_end message role=${String((event.message as { role?: unknown })?.role ?? "unknown")}`);
        return;
      }

      const resultLeafId = ctx.sessionManager.getLeafId() ?? undefined;
      const userEntry = findUserEntryAfter(ctx, state.pendingBeforeSnapshotId);
      const sessionId = ctx.sessionManager.getSessionId();

      const commit = await createSnapshotCommit(pi, ctx.cwd, sessionId, `after ${state.pendingTurnId}`);
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
        ctx.cwd,
        `create after snapshot turn=${state.pendingTurnId} entry=${afterSnapshotId} resultLeaf=${resultLeafId} userEntry=${userEntry?.id} commit=${commit}`,
      );

      state.pendingTurnId = undefined;
      state.pendingBeforeSnapshotId = undefined;
    } catch (error) {
      await logLine(ctx.cwd, `after snapshot failed error=${String(error)}`);
      throw error;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = getState(ctx);
    if (!state.pendingTurnId && !state.pendingBeforeSnapshotId) {
      return;
    }

    await logLine(
      ctx.cwd,
      `clear pending turn without after snapshot turn=${state.pendingTurnId} beforeSnapshot=${state.pendingBeforeSnapshotId}`,
    );
    state.pendingTurnId = undefined;
    state.pendingBeforeSnapshotId = undefined;
  });

  pi.on("session_before_tree", async (event, ctx) => {
    const state = getState(ctx);
    await logLine(
      ctx.cwd,
      `session_before_tree target=${event.preparation.targetId} oldLeaf=${event.preparation.oldLeafId} summarize=${String(event.preparation.userWantsSummary)} source=${state.internalNavigation ?? "tree"}`,
    );

    if (event.preparation.userWantsSummary && !state.internalNavigation) {
      ctx.ui.notify("Manual /tree with summary may desync workspace and chat state. Disable summary before switching.", "error");
      return { cancel: true };
    }

    const currentLeafId = ctx.sessionManager.getLeafId();
    const currentSnapshot = currentLeafId ? resolveSnapshotForTreeTarget(ctx, currentLeafId) : undefined;

    try {
      const dirty = await isWorkspaceDirtyAgainstSnapshot(pi, ctx, currentSnapshot);
      if (dirty) {
        ctx.ui.notify("The workspace has unsnapshotted changes. Run /checkpoint first, or clean them up before switching.", "error");
        return { cancel: true };
      }
    } catch (error) {
      await logLine(ctx.cwd, `dirty-check failed target=${event.preparation.targetId} error=${String(error)}`);
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
      await restoreResolvedSnapshot(pi, ctx, state.internalNavigation ?? "tree", event.preparation.targetId, snapshot);
    } catch (error) {
      await logLine(
        ctx.cwd,
        `restore source=${state.internalNavigation ?? "tree"} target=${event.preparation.targetId} snapshot=${snapshot.id} commit=${snapshotData.commit} error=${String(error)}`,
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
    await clearRedoStack(ctx);
  });

  pi.registerCommand("undo", {
    description: "Undo last agent turn and restore workspace",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const state = getState(ctx);
      const precheck = await ensureNoUnsnapshottedChanges(pi, ctx, "undo");
      if (!precheck) {
        return;
      }

      const after = findLastAfterSnapshot(ctx);
      if (!hasSnapshotData(after) || !after.data.userEntryId) {
        await logLine(ctx.cwd, "undo no-op: no after snapshot");
        ctx.ui.notify("Nothing to undo.", "info");
        return;
      }

      await logLine(
        ctx.cwd,
        `undo start currentLeaf=${ctx.sessionManager.getLeafId()} userEntry=${after.data.userEntryId} beforeSnapshot=${after.data.beforeSnapshotId}`,
      );

      state.internalNavigation = "undo";
      try {
        const result = await ctx.navigateTree(after.data.userEntryId, { summarize: false });
        await logLine(ctx.cwd, `undo navigate result cancelled=${String(result.cancelled)}`);
        if (result.cancelled) {
          ctx.ui.notify("Undo cancelled.", "error");
          return;
        }

        if (precheck.currentLeafId) {
          await pushRedoTarget(ctx, precheck.currentLeafId);
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
      const precheck = await ensureNoUnsnapshottedChanges(pi, ctx, "redo");
      if (!precheck) {
        return;
      }

      const redo = await peekRedoTarget(ctx);
      if (!redo) {
        await logLine(ctx.cwd, "redo no-op: empty stack");
        ctx.ui.notify("Nothing to redo.", "info");
        return;
      }

      await logLine(ctx.cwd, `redo start currentLeaf=${ctx.sessionManager.getLeafId()} target=${redo.targetId}`);

      state.internalNavigation = "redo";
      try {
        const result = await ctx.navigateTree(redo.targetId, { summarize: false });
        await logLine(ctx.cwd, `redo navigate result cancelled=${String(result.cancelled)}`);
        if (result.cancelled) {
          ctx.ui.notify("Redo cancelled.", "error");
          return;
        }

        await popRedoTarget(ctx);

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

      const sessionId = ctx.sessionManager.getSessionId();
      await ensureShadowRepo(pi, ctx.cwd, sessionId);
      const label = args.trim() || "manual checkpoint";
      const commit = await createSnapshotCommit(pi, ctx.cwd, sessionId, label);

      pi.appendEntry<WorkspaceSnapshot>(SNAPSHOT_TYPE, {
        v: 1,
        kind: "manual",
        commit,
        label,
        createdAt: new Date().toISOString(),
      });

      await clearRedoStack(ctx);
      await logLine(ctx.cwd, `create manual snapshot entry=${ctx.sessionManager.getLeafId()} label=${label} commit=${commit}`);
      ctx.ui.notify(`Checkpoint saved: ${label}`, "info");
    },
  });
}
