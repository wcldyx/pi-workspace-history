import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AuthStorage,
  type CustomEntry,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import workspaceHistoryExtension, {
  rebuildTurnSnapshotsFromLegacyEntries,
  isWindowsReservedSnapshotPath,
} from "../.pi/extensions/workspace-history.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@mariozechner/pi-ai";

type TestContext = {
  rootDir: string;
  cwd: string;
  resourceLoader: DefaultResourceLoader;
  modelRegistry: ModelRegistry;
  authStorage: AuthStorage;
  settingsManager: SettingsManager;
  provider: ReturnType<typeof registerFauxProvider>;
};

type TurnSnapshotState = {
  version: 1;
  turns: Array<{
    turnId: string;
    userEntryId: string;
    assistantEntryId: string;
    beforeCommit: string;
    afterCommit: string;
    createdAt: string;
  }>;
};

const execFileAsync = promisify(execFile);

async function createContextForWorkspace(rootDir: string, cwd: string, withProjectMarker = true): Promise<TestContext> {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0 },
    branchSummary: { skipPrompt: true },
  });

  const provider = registerFauxProvider({
    provider: "timemachine-test",
    api: "faux",
    models: [
      {
        id: "faux-1",
        name: "Timemachine Test Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      },
    ],
  });

  modelRegistry.registerProvider("timemachine-test", {
    api: "faux",
    apiKey: "TIMEMACHINE_TEST_KEY",
    baseUrl: "http://localhost:0",
    models: [
      {
        id: "faux-1",
        name: "Timemachine Test Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      },
    ],
  });
  authStorage.setRuntimeApiKey("timemachine-test", "test-key");

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    additionalExtensionPaths: [path.join(process.cwd(), ".pi", "extensions", "workspace-history.ts")],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: "Use tools when asked. Keep responses short.",
  });
  await resourceLoader.reload();

  if (withProjectMarker) {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "timemachine-test-workspace" }, null, 2) + "\n", "utf8");
  }

  return {
    rootDir,
    cwd,
    resourceLoader,
    modelRegistry,
    authStorage,
    settingsManager,
    provider,
  };
}

async function createContext(): Promise<TestContext> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pi-timemachine-test-"));
  const cwd = path.join(rootDir, "workspace");
  await mkdir(cwd, { recursive: true });
  return createContextForWorkspace(rootDir, cwd, true);
}

async function createNonProjectContext(): Promise<TestContext> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pi-timemachine-test-"));
  const cwd = path.join(rootDir, "workspace");
  await mkdir(cwd, { recursive: true });
  return createContextForWorkspace(rootDir, cwd, false);
}

async function disposeContext(ctx: TestContext): Promise<void> {
  ctx.provider.unregister();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(ctx.rootDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

async function createSession(ctx: TestContext) {
  const model = ctx.provider.getModel();
  const result = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    model,
    thinkingLevel: "off",
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    resourceLoader: ctx.resourceLoader,
    tools: ["read", "write", "edit"],
    sessionManager: SessionManager.inMemory(ctx.cwd),
    settingsManager: ctx.settingsManager,
  });

  const session = result.session;
  await session.bindExtensions({
    commandContextActions: {
      waitForIdle: () => session.agent.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async (targetId, options) => {
        const nav = await session.navigateTree(targetId, {
          summarize: options?.summarize,
          customInstructions: options?.customInstructions,
          replaceInstructions: options?.replaceInstructions,
          label: options?.label,
        });
        return { cancelled: nav.cancelled };
      },
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        await session.reload();
      },
    },
    onError: (err) => {
      throw new Error(`Extension error (${err.event}): ${err.error}\n${err.stack ?? ""}`);
    },
  });

  return session;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

async function waitFor(condition: () => boolean | Promise<boolean>, message: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function waitForExists(filePath: string, expected: boolean, message: string): Promise<void> {
  await waitFor(async () => (await exists(filePath)) === expected, message);
}

async function waitForText(filePath: string, expected: string, message: string): Promise<void> {
  await waitFor(async () => {
    try {
      return normalizeEol(await readText(filePath)) === expected;
    } catch {
      return false;
    }
  }, message);
}

function getTurnSnapshotFile(session: Awaited<ReturnType<typeof createSession>>, cwd: string): string {
  const workspaceHash = createHash("sha256").update(path.normalize(cwd)).digest("hex").slice(0, 24);
  return path.join(
    getAgentDir(),
    "state",
    "workspace-history",
    "workspaces",
    workspaceHash,
    "sessions",
    session.sessionManager.getSessionId(),
    "turn-snapshots.json",
  );
}

async function readTurnSnapshots(session: Awaited<ReturnType<typeof createSession>>, cwd: string): Promise<TurnSnapshotState> {
  try {
    return JSON.parse(await readFile(getTurnSnapshotFile(session, cwd), "utf8")) as TurnSnapshotState;
  } catch {
    return { version: 1, turns: [] };
  }
}

function getMessageText(entry: any): string | undefined {
  if (entry?.type !== "message") {
    return undefined;
  }
  const content = entry.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((item) => item?.type === "text")
      .map((item) => item.text)
      .join("");
  }
  return undefined;
}

async function countSnapshots(session: Awaited<ReturnType<typeof createSession>>, cwd: string, kind?: string): Promise<number> {
  if (kind === "after") {
    return (await readTurnSnapshots(session, cwd)).turns.length;
  }

  return session.sessionManager.getEntries().filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === "workspace-history.snapshot" &&
      (!kind || (entry as any).data?.kind === kind)
    );
  }).length;
}

async function testUndoRedo(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);
    const filePath = path.join(ctx.cwd, "hello.txt");

    ctx.provider.setResponses([
      fauxAssistantMessage([
        fauxToolCall("write", {
          path: "hello.txt",
          content: "hello from turn 1\n",
        }),
      ]),
      fauxAssistantMessage("created hello.txt"),
    ]);

    await session.prompt("create hello.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "first-turn after snapshot was not created");
    assert.equal(await exists(filePath), true, "file should exist after the first turn");
    assert.equal(normalizeEol(await readText(filePath)), "hello from turn 1\n");

    await session.prompt("/undo");
    await waitForExists(filePath, false, "file should be removed after /undo");

    await session.prompt("/redo");
    await waitForExists(filePath, true, "file should be restored after /redo");
    await waitForText(filePath, "hello from turn 1\n", "hello.txt should match after /redo");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testSessionStartDoesNotCreateBaselineEagerly(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);

    assert.equal(await countSnapshots(session, ctx.cwd), 0, "session start should not create baseline eagerly");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await countSnapshots(session, ctx.cwd), 0, "idle baseline warmup should not append session entries before the first turn");

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "lazy.txt", content: "lazy baseline\n" })]),
      fauxAssistantMessage("created lazy file"),
    ]);

    await session.prompt("create lazy.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "after snapshot was not created for lazy baseline flow");

    assert.equal(await countSnapshots(session, ctx.cwd, "baseline") >= 1, true, "baseline should be created lazily before the first turn");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testManualChangesProtectedAcrossUndo(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);
    const fileA = path.join(ctx.cwd, "A.txt");
    const fileB = path.join(ctx.cwd, "B.txt");

    ctx.provider.setResponses([
      fauxAssistantMessage([
        fauxToolCall("write", {
          path: "A.txt",
          content: "created by turn A\n",
        }),
      ]),
      fauxAssistantMessage("created A"),
      fauxAssistantMessage([
        fauxToolCall("write", {
          path: "B.txt",
          content: "created by turn B\n",
        }),
      ]),
      fauxAssistantMessage("created B"),
    ]);

    await session.prompt("create A.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "A turn after snapshot was not created");
    assert.equal(await exists(fileA), true);

    await rm(fileA, { force: true });
    assert.equal(await exists(fileA), false, "A should not exist after manual deletion");

    await session.prompt("create B.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 2, "B turn after snapshot was not created");
    assert.equal(await exists(fileB), true);

    await session.prompt("/undo");
    await waitForExists(fileB, false, "B should be removed after undoing the second turn");
    await waitForExists(fileA, false, "manually deleted A should not reappear");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testCheckpointAndTreeGuard(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);
    const filePath = path.join(ctx.cwd, "checkpoint.txt");

    ctx.provider.setResponses([
      fauxAssistantMessage([
        fauxToolCall("write", {
          path: "checkpoint.txt",
          content: "base\n",
        }),
      ]),
      fauxAssistantMessage("created checkpoint file"),
    ]);

    await session.prompt("create checkpoint.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "checkpoint test after snapshot was not created");
    assert.equal(normalizeEol(await readText(filePath)), "base\n");

    await writeFile(filePath, "manual edit\n", "utf8");
    const originalLeafId = session.sessionManager.getLeafId();
    assert.ok(originalLeafId, "current leaf should exist");

    const baseline = session.sessionManager
      .getEntries()
      .find((entry) => entry.type === "custom" && entry.customType === "workspace-history.snapshot" && (entry as any).data?.kind === "baseline");
    assert.ok(baseline, "baseline snapshot should exist");

    const treeResult = await session.navigateTree(baseline!.id, { summarize: false });
    assert.equal(treeResult.cancelled, true, "manual edits without a checkpoint should block /tree");
    assert.equal(session.sessionManager.getLeafId(), originalLeafId, "leaf should not change after cancelled navigation");
    assert.equal(normalizeEol(await readText(filePath)), "manual edit\n", "manual edits should be preserved after cancelled navigation");

    await session.prompt("/checkpoint saved-manual");
    const checkpointEntries = session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "workspace-history.snapshot" && (entry as any).data?.kind === "manual");
    assert.equal(checkpointEntries.length > 0, true, "manual checkpoint should be created");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testRepeatedUndo(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);
    const fileA = path.join(ctx.cwd, "A.txt");
    const fileB = path.join(ctx.cwd, "B.txt");
    const fileC = path.join(ctx.cwd, "C.txt");

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "A.txt", content: "A\n" })]),
      fauxAssistantMessage("created A"),
      fauxAssistantMessage([
        fauxToolCall("write", { path: "B.txt", content: "B\n" }),
        fauxToolCall("write", { path: "C.txt", content: "C\n" }),
      ]),
      fauxAssistantMessage("created B and C"),
    ]);

    await session.prompt("create A.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "A turn after snapshot was not created");
    await session.prompt("create B.txt and C.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 2, "B/C turn after snapshot was not created");

    assert.equal(await exists(fileA), true);
    assert.equal(await exists(fileB), true);
    assert.equal(await exists(fileC), true);

    await session.prompt("/undo");
    await waitForExists(fileA, true, "A should remain after the first undo");
    await waitForExists(fileB, false, "B should be removed after the first undo");
    await waitForExists(fileC, false, "C should be removed after the first undo");

    await session.prompt("/undo");
    await waitForExists(fileA, false, "A should be removed after the second undo");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testTreeBranchSwitching(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);
    const fileA = path.join(ctx.cwd, "branch.txt");

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "branch.txt", content: "A\n" })]),
      fauxAssistantMessage("created A branch state"),
      fauxAssistantMessage([fauxToolCall("write", { path: "branch.txt", content: "C\n" })]),
      fauxAssistantMessage("created C branch state"),
      fauxAssistantMessage([fauxToolCall("write", { path: "branch.txt", content: "D\n" })]),
      fauxAssistantMessage("created D branch state"),
    ]);

    await session.prompt("create branch.txt as A");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "A branch after snapshot was not created");
    await session.prompt("change branch.txt to C");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 2, "C branch after snapshot was not created");

    const cAssistant = session.sessionManager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant" && getMessageText(entry) === "created C branch state");
    assert.ok(cAssistant, "C assistant message should exist");

    await session.prompt("/undo");
    await waitForText(fileA, "A\n", "after undoing back before C, the file should be A");

    await session.prompt("change branch.txt to D");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 3, "D branch after snapshot was not created");
    assert.equal(normalizeEol(await readText(fileA)), "D\n", "D branch should write D");

    const dAssistant = session.sessionManager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant" && getMessageText(entry) === "created D branch state");
    assert.ok(dAssistant, "D assistant message should exist");

    const cTreeResult = await session.navigateTree(cAssistant!.id, { summarize: false });
    assert.equal(cTreeResult.cancelled, false, "switching back to C branch should not be cancelled");
    assert.equal(normalizeEol(await readText(fileA)), "C\n", "workspace should restore C when switching back to C branch");

    const dTreeResult = await session.navigateTree(dAssistant!.id, { summarize: false });
    assert.equal(dTreeResult.cancelled, false, "switching back to D branch should not be cancelled");
    assert.equal(normalizeEol(await readText(fileA)), "D\n", "workspace should restore D when switching back to D branch");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testUndoDoesNotLeakAcrossSessions(): Promise<void> {
  const ctx1 = await createContext();
  try {
    const session1 = await createSession(ctx1);
    const fileA = path.join(ctx1.cwd, "session-a.txt");

    ctx1.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "session-a.txt", content: "from session 1\n" })]),
      fauxAssistantMessage("created session 1 file"),
    ]);

    await session1.prompt("create session-a.txt");
    await waitFor(async () => await countSnapshots(session1, ctx1.cwd, "after") >= 1, "session1 after snapshot was not created");
    assert.equal(normalizeEol(await readText(fileA)), "from session 1\n");
    session1.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ctx2 = await createContextForWorkspace(ctx1.rootDir, ctx1.cwd);
    const session2 = await createSession(ctx2);
    const beforeLeaf = session2.sessionManager.getLeafId();
    await session2.prompt("/undo");
    const afterLeaf = session2.sessionManager.getLeafId();

    assert.equal(beforeLeaf, afterLeaf, "a new session should not jump into old session history on /undo");
    assert.equal(normalizeEol(await readText(fileA)), "from session 1\n", "a new session /undo should not restore other old session states");

    session2.dispose();
    ctx2.provider.unregister();
  } finally {
    await disposeContext(ctx1);
  }
}

async function testNonProjectWorkspaceDisablesExtension(): Promise<void> {
  const ctx = await createNonProjectContext();
  try {
    const session = await createSession(ctx);

    await waitFor(async () => (await countSnapshots(session, ctx.cwd)) === 0, "non-project workspace should not create snapshots");

    const nav = await session.navigateTree(session.sessionManager.getLeafId() ?? "", { summarize: false }).catch(() => ({ cancelled: false }));
    assert.equal(nav.cancelled, false, "tree navigation should not be cancelled when workspace history is disabled");

    await session.prompt("/undo");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await waitFor(async () => (await countSnapshots(session, ctx.cwd)) === 0, "non-project workspace should remain disabled for commands");

    await writeFile(path.join(ctx.cwd, "package.json"), JSON.stringify({ name: "timemachine-test-workspace" }, null, 2) + "\n", "utf8");
    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "activated.txt", content: "activated\n" })]),
      fauxAssistantMessage("activated"),
    ]);

    await session.prompt("create activated.txt");
    await waitFor(async () => (await countSnapshots(session, ctx.cwd, "after")) >= 1, "workspace history should re-enable after adding a project marker");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testUndoWorksFromTreeSelectedUserNode(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);
    const filePath = path.join(ctx.cwd, "tree-undo.txt");

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "tree-undo.txt", content: "turn one\n" })]),
      fauxAssistantMessage("created tree undo file"),
    ]);

    await session.prompt("create tree-undo.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "tree undo after snapshot was not created");
    assert.equal(normalizeEol(await readText(filePath)), "turn one\n");

    const userEntry = session.sessionManager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "user" && getMessageText(entry) === "create tree-undo.txt");
    assert.ok(userEntry, "user entry should exist for tree undo test");

    const nav = await session.navigateTree(userEntry!.id, { summarize: false });
    assert.equal(nav.cancelled, false, "navigating to the user node should succeed");

    await session.prompt("/undo");
    await waitForExists(filePath, false, "file should be removed when undo runs from a tree-selected user node");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testLegacySnapshotEntriesRebuildTurnSnapshots(): Promise<void> {
  const ctx1 = await createContext();
  try {
    const session1 = await createSession(ctx1);
    const filePath = path.join(ctx1.cwd, "legacy-fallback.txt");

    ctx1.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "legacy-fallback.txt", content: "legacy\n" })]),
      fauxAssistantMessage("created legacy fallback file"),
    ]);

    await session1.prompt("create legacy-fallback.txt");
    await waitFor(async () => await countSnapshots(session1, ctx1.cwd, "after") >= 1, "legacy fallback after snapshot was not created");
    assert.equal(normalizeEol(await readText(filePath)), "legacy\n");

    const entries = session1.sessionManager.getEntries();
    const baseline = entries.find((entry) => entry.type === "custom" && entry.customType === "workspace-history.snapshot" && (entry as any).data?.kind === "baseline");
    const userEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user" && getMessageText(entry) === "create legacy-fallback.txt");
    const assistantEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant" && getMessageText(entry) === "created legacy fallback file");
    const turnSnapshots = await readTurnSnapshots(session1, ctx1.cwd);
    const latestTurn = turnSnapshots.turns.at(-1);

    assert.ok(baseline, "baseline snapshot should exist for legacy fallback test");
    assert.ok(userEntry, "user entry should exist for legacy fallback test");
    assert.ok(assistantEntry, "assistant entry should exist for legacy fallback test");
    assert.ok(latestTurn, "turn snapshot should exist for legacy fallback test");

    const legacyEntries = entries.filter((entry) => entry !== baseline) as Array<any>;
    legacyEntries.push({
      type: "custom",
      customType: "workspace-history.snapshot",
      id: `legacy-after-${Date.now()}`,
      parentId: assistantEntry!.id,
      timestamp: Date.now(),
      data: {
        v: 1,
        kind: "after",
        commit: latestTurn!.afterCommit,
        turnId: latestTurn!.turnId,
        beforeSnapshotId: baseline!.id,
        userEntryId: userEntry!.id,
        resultLeafId: assistantEntry!.id,
        createdAt: latestTurn!.createdAt,
      },
    } satisfies CustomEntry<any>);

    const rebuilt = rebuildTurnSnapshotsFromLegacyEntries({
      sessionManager: {
        getEntries: () => [baseline!, ...legacyEntries],
        getEntry: (id: string) => [baseline!, ...legacyEntries].find((entry) => entry.id === id),
      },
    } as any);

    assert.equal(rebuilt.turns.length >= 1, true, "legacy snapshot entries should rebuild at least one turn snapshot");
    assert.equal(rebuilt.turns.at(-1)?.userEntryId, userEntry!.id, "rebuilt legacy turn should preserve user entry id");
    assert.equal(rebuilt.turns.at(-1)?.assistantEntryId, assistantEntry!.id, "rebuilt legacy turn should preserve assistant entry id");

    session1.dispose();
  } finally {
    await disposeContext(ctx1);
  }
}

async function testWindowsReservedNamesAreExcludedFromSnapshotPaths(): Promise<void> {
  assert.equal(isWindowsReservedSnapshotPath("nul"), true, "nul should be treated as a reserved Windows device path");
  assert.equal(isWindowsReservedSnapshotPath("NUL.txt"), true, "nul with extension should be treated as reserved");
  assert.equal(isWindowsReservedSnapshotPath("dir/aux"), true, "reserved device names in subdirectories should be excluded");
  assert.equal(isWindowsReservedSnapshotPath("notes/null.txt"), false, "ordinary names should remain snapshot-manageable");
}

async function testBeforeCommitReusesPreviousAfterCommitWhenWorkspaceUnchanged(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "reuse-before.txt", content: "turn one\n" })]),
      fauxAssistantMessage("created reuse-before file"),
      fauxAssistantMessage("no workspace changes"),
    ]);

    await session.prompt("create reuse-before.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "first after snapshot was not created");

    await session.prompt("just reply without editing files");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 2, "second after snapshot was not created");

    const turns = (await readTurnSnapshots(session, ctx.cwd)).turns;
    assert.equal(turns.length >= 2, true, "expected at least two turn snapshots");

    const first = turns.at(-2);
    const second = turns.at(-1);
    assert.ok(first, "first turn snapshot should exist");
    assert.ok(second, "second turn snapshot should exist");
    assert.equal(second!.beforeCommit, first!.afterCommit, "second before commit should reuse first after commit when workspace is unchanged");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testPiFilesAreSnapshotManagedExceptInternalState(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);
    const piFile = path.join(ctx.cwd, ".pi", "notes.txt");

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: ".pi/notes.txt", content: "pi managed file\n" })]),
      fauxAssistantMessage("created .pi note"),
    ]);

    await session.prompt("create .pi/notes.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, ".pi file after snapshot was not created");
    assert.equal(normalizeEol(await readText(piFile)), "pi managed file\n");

    await session.prompt("/undo");
    await waitForExists(piFile, false, ".pi regular file should be removed after /undo");

    await session.prompt("/redo");
    await waitForText(piFile, "pi managed file\n", ".pi regular file should be restored after /redo");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testHistoryIsStoredOutsideWorkspace(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "outside.txt", content: "outside\n" })]),
      fauxAssistantMessage("created outside file"),
    ]);

    await session.prompt("create outside.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "outside storage after snapshot was not created");

    const legacyDir = path.join(ctx.cwd, ".pi", "workspace-history");
    assert.equal(await pathExists(legacyDir), false, "legacy workspace history dir should not be created in workspace");

    const externalRoot = path.join(getAgentDir(), "state", "workspace-history");
    const workspacesDir = path.join(externalRoot, "workspaces");
    assert.equal(await pathExists(workspacesDir), true, "external workspace history dir should exist");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testIdleWarmupIsReusedByFirstTurn(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);

    await waitFor(async () => {
      const turns = await readTurnSnapshots(session, ctx.cwd);
      return turns.turns.length === 0 && (await countSnapshots(session, ctx.cwd, "baseline")) === 0;
    }, "idle warmup should not append session entries", 4000);

    await new Promise((resolve) => setTimeout(resolve, 1800));

    ctx.provider.setResponses([
      fauxAssistantMessage("no workspace changes after warmup"),
    ]);

    await session.prompt("reply without editing files");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "after snapshot was not created after idle warmup");

    const turns = (await readTurnSnapshots(session, ctx.cwd)).turns;
    const first = turns.at(-1);
    assert.ok(first, "first turn snapshot should exist after idle warmup");
    assert.equal(first!.beforeCommit, first!.afterCommit, "warm first turn with no edits should reuse the warmed baseline commit");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testNewSessionReusesWorkspaceShadowRepo(): Promise<void> {
  const ctx1 = await createContext();
  try {
    const session1 = await createSession(ctx1);

    ctx1.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "reuse-shadow.txt", content: "base\n" })]),
      fauxAssistantMessage("created reusable shadow state"),
    ]);

    await session1.prompt("create reusable shadow state");
    await waitFor(async () => await countSnapshots(session1, ctx1.cwd, "after") >= 1, "first session after snapshot was not created");
    session1.dispose();

    const ctx2 = await createContextForWorkspace(ctx1.rootDir, ctx1.cwd);
    const session2 = await createSession(ctx2);
    const workspaceHash = createHash("sha256").update(path.normalize(ctx1.cwd)).digest("hex").slice(0, 24);
    const gitDir = path.join(
      getAgentDir(),
      "state",
      "workspace-history",
      "workspaces",
      workspaceHash,
      "sessions",
      session2.sessionManager.getSessionId(),
      "repo.git",
    );

    await waitFor(async () => await pathExists(path.join(gitDir, "objects")), "second session shadow git repo should exist", 10000);
    const head = await readFile(path.join(gitDir, "HEAD"), "utf8");
    assert.match(head, /refs\/heads|[0-9a-f]{40}/, "second session should have a cloned shadow repo with HEAD");

    session2.dispose();
    ctx2.provider.unregister();
  } finally {
    await disposeContext(ctx1);
  }
}

async function testStaleShadowRepoLockIsRecovered(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "lock-recovery.txt", content: "recovered\n" })]),
      fauxAssistantMessage("created lock recovery file"),
    ]);

    const workspaceHash = createHash("sha256").update(path.normalize(ctx.cwd)).digest("hex").slice(0, 24);
    const sessionRoot = path.join(
      getAgentDir(),
      "state",
      "workspace-history",
      "workspaces",
      workspaceHash,
      "sessions",
      session.sessionManager.getSessionId(),
    );
    const gitDir = path.join(sessionRoot, "repo.git");
    await rm(gitDir, { recursive: true, force: true });
    await mkdir(sessionRoot, { recursive: true });
    await execFileAsync("git", ["init", "--bare", gitDir], { cwd: ctx.cwd });
    const lockPath = path.join(gitDir, "index.lock");
    await writeFile(lockPath, "stale lock\n", "utf8");
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    await session.prompt("create lock recovery file");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "after snapshot should be created after stale lock recovery");
    assert.equal(await exists(lockPath), false, "stale index.lock should be removed automatically");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testUnicodePathsSurviveUndoRedo(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);
    const relativePath = "src/后台/views/系统设置/工程设置/微信设置/油品设置/utils.ts";
    const filePath = path.join(ctx.cwd, ...relativePath.split("/"));

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: relativePath, content: "export const value = 1;\n" })]),
      fauxAssistantMessage("created unicode path file"),
    ]);

    await session.prompt("create unicode path file");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "unicode path after snapshot was not created");
    await waitForText(filePath, "export const value = 1;\n", "unicode path file should be created");

    await session.prompt("/undo");
    await waitForExists(filePath, false, "unicode path file should be removed after /undo");

    await session.prompt("/redo");
    await waitForText(filePath, "export const value = 1;\n", "unicode path file should be restored after /redo");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testUndoAndRedoBlockOnUnsnapshottedManualChanges(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);
    const filePath = path.join(ctx.cwd, "guard.txt");

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "guard.txt", content: "turn one\n" })]),
      fauxAssistantMessage("created guard file"),
    ]);

    await session.prompt("create guard.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "guard after snapshot was not created");

    await writeFile(filePath, "manual edit\n", "utf8");
    const undoLeafBefore = session.sessionManager.getLeafId();
    await session.prompt("/undo");
    const undoLeafAfter = session.sessionManager.getLeafId();

    assert.equal(undoLeafAfter, undoLeafBefore, "/undo should be blocked by unsnapshotted manual edits");
    assert.equal(normalizeEol(await readText(filePath)), "manual edit\n", "manual edits should remain after blocked /undo");

    await session.prompt("/checkpoint guard-manual");
    await session.prompt("/undo");
    await waitForExists(filePath, false, "file should be removed after undo once manual edits are checkpointed");

    await session.prompt("/redo");
    await waitForText(filePath, "manual edit\n", "redo should restore the last successfully undone location");

    await writeFile(filePath, "manual redo edit\n", "utf8");
    const redoLeafBefore = session.sessionManager.getLeafId();
    await session.prompt("/undo");
    await session.prompt("/redo");
    const redoLeafAfter = session.sessionManager.getLeafId();

    assert.equal(redoLeafAfter, redoLeafBefore, "/redo should be blocked by unsnapshotted manual edits");
    assert.equal(normalizeEol(await readText(filePath)), "manual redo edit\n", "manual edits should remain after blocked /redo");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testGitignoreStopsManagingIgnoredPaths(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);
    const ignoredFilePath = path.join(ctx.cwd, "generated.txt");

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "generated.txt", content: "turn one\n" })]),
      fauxAssistantMessage("created generated file"),
      fauxAssistantMessage([fauxToolCall("write", { path: ".gitignore", content: "generated.txt\n" })]),
      fauxAssistantMessage("ignored generated file"),
    ]);

    await session.prompt("create generated.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "generated file after snapshot was not created");

    await session.prompt("ignore generated.txt in .gitignore");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 2, ".gitignore update after snapshot was not created");

    await writeFile(ignoredFilePath, "manual ignored edit\n", "utf8");
    await session.prompt("/undo");

    await waitForText(ignoredFilePath, "manual ignored edit\n", "ignored file should no longer be managed after .gitignore excludes it");
    await waitForExists(path.join(ctx.cwd, ".gitignore"), false, ".gitignore should be removed when undoing to the earlier snapshot");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testRestoreFailureDoesNotDeleteCurrentWorkspace(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);
    const filePath = path.join(ctx.cwd, "safe.txt");

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "safe.txt", content: "keep me\n" })]),
      fauxAssistantMessage("created safe file"),
    ]);

    await session.prompt("create safe.txt");
    await waitFor(async () => await countSnapshots(session, ctx.cwd, "after") >= 1, "safe file after snapshot was not created");

    const sessionId = session.sessionManager.getSessionId();
    const workspaceHash = createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 24);
    const gitDir = path.join(getAgentDir(), "state", "workspace-history", "workspaces", workspaceHash, "sessions", sessionId, "repo.git");
    await rm(gitDir, { recursive: true, force: true });

    const baseline = session.sessionManager
      .getEntries()
      .find((entry) => entry.type === "custom" && entry.customType === "workspace-history.snapshot" && (entry as any).data?.kind === "baseline");
    assert.ok(baseline, "baseline snapshot should exist for restore failure test");

    const originalLeaf = session.sessionManager.getLeafId();
    const nav = await session.navigateTree(baseline!.id, { summarize: false });

    assert.equal(nav.cancelled, true, "tree navigation should be cancelled when restore fails");
    assert.equal(session.sessionManager.getLeafId(), originalLeaf, "leaf should remain unchanged after restore failure");
    assert.equal(normalizeEol(await readText(filePath)), "keep me\n", "current workspace should remain intact after restore failure");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function main(): Promise<void> {
  const tests: Array<{ name: string; run: () => Promise<void> }> = [
    { name: "session start does not create baseline eagerly", run: testSessionStartDoesNotCreateBaselineEagerly },
    { name: "idle warmup is reused by first turn", run: testIdleWarmupIsReusedByFirstTurn },
    { name: "non-project workspace disables extension", run: testNonProjectWorkspaceDisablesExtension },
    { name: "undo/redo restores workspace", run: testUndoRedo },
    { name: "undo preserves manual changes before next turn", run: testManualChangesProtectedAcrossUndo },
    { name: "repeated undo walks back turn by turn", run: testRepeatedUndo },
    { name: "checkpoint and dirty tree guard", run: testCheckpointAndTreeGuard },
    { name: "tree switching restores branch-specific workspace", run: testTreeBranchSwitching },
    { name: "undo does not leak across sessions", run: testUndoDoesNotLeakAcrossSessions },
    { name: "undo works from tree-selected user node", run: testUndoWorksFromTreeSelectedUserNode },
    { name: "legacy snapshot entries rebuild turn snapshots", run: testLegacySnapshotEntriesRebuildTurnSnapshots },
    { name: "windows reserved names are excluded from snapshot paths", run: testWindowsReservedNamesAreExcludedFromSnapshotPaths },
    { name: "before commit reuses previous after commit when workspace unchanged", run: testBeforeCommitReusesPreviousAfterCommitWhenWorkspaceUnchanged },
    { name: ".pi files are managed except internal state", run: testPiFilesAreSnapshotManagedExceptInternalState },
    { name: "history is stored outside workspace", run: testHistoryIsStoredOutsideWorkspace },
    { name: "new session reuses workspace shadow repo", run: testNewSessionReusesWorkspaceShadowRepo },
    { name: "stale shadow repo lock is recovered", run: testStaleShadowRepoLockIsRecovered },
    { name: "unicode paths survive undo and redo", run: testUnicodePathsSurviveUndoRedo },
    { name: "undo and redo block on unsnapshotted manual changes", run: testUndoAndRedoBlockOnUnsnapshottedManualChanges },
    { name: ".gitignore stops managing ignored paths", run: testGitignoreStopsManagingIgnoredPaths },
    { name: "restore failure does not delete current workspace", run: testRestoreFailureDoesNotDeleteCurrentWorkspace },
  ];

  for (const test of tests) {
    process.stdout.write(`RUN ${test.name}\n`);
    await test.run();
    process.stdout.write(`PASS ${test.name}\n`);
  }
}

await main();
