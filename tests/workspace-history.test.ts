import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
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

async function createContextForWorkspace(rootDir: string, cwd: string): Promise<TestContext> {
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
  return createContextForWorkspace(rootDir, cwd);
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

async function waitFor(condition: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function countSnapshots(session: Awaited<ReturnType<typeof createSession>>, kind?: string): number {
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
    await waitFor(() => countSnapshots(session, "after") >= 1, "first-turn after snapshot was not created");
    assert.equal(await exists(filePath), true, "file should exist after the first turn");
    assert.equal(normalizeEol(await readText(filePath)), "hello from turn 1\n");

    await session.prompt("/undo");
    assert.equal(await exists(filePath), false, "file should be removed after /undo");

    await session.prompt("/redo");
    assert.equal(await exists(filePath), true, "file should be restored after /redo");
    assert.equal(normalizeEol(await readText(filePath)), "hello from turn 1\n");

    session.dispose();
  } finally {
    await disposeContext(ctx);
  }
}

async function testSessionStartDoesNotCreateBaselineEagerly(): Promise<void> {
  const ctx = await createContext();
  try {
    const session = await createSession(ctx);

    assert.equal(countSnapshots(session), 0, "session start should not create baseline eagerly");

    ctx.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "lazy.txt", content: "lazy baseline\n" })]),
      fauxAssistantMessage("created lazy file"),
    ]);

    await session.prompt("create lazy.txt");
    await waitFor(() => countSnapshots(session, "after") >= 1, "after snapshot was not created for lazy baseline flow");

    assert.equal(countSnapshots(session, "baseline") >= 1, true, "baseline should be created lazily before the first turn");

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
    await waitFor(() => countSnapshots(session, "after") >= 1, "A turn after snapshot was not created");
    assert.equal(await exists(fileA), true);

    await rm(fileA, { force: true });
    assert.equal(await exists(fileA), false, "A should not exist after manual deletion");

    await session.prompt("create B.txt");
    await waitFor(() => countSnapshots(session, "after") >= 2, "B turn after snapshot was not created");
    assert.equal(await exists(fileB), true);

    await session.prompt("/undo");
    assert.equal(await exists(fileB), false, "B should be removed after undoing the second turn");
    assert.equal(await exists(fileA), false, "manually deleted A should not reappear");

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
    await waitFor(() => countSnapshots(session, "after") >= 1, "checkpoint test after snapshot was not created");
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
    await waitFor(() => countSnapshots(session, "after") >= 1, "A turn after snapshot was not created");
    await session.prompt("create B.txt and C.txt");
    await waitFor(() => countSnapshots(session, "after") >= 2, "B/C turn after snapshot was not created");

    assert.equal(await exists(fileA), true);
    assert.equal(await exists(fileB), true);
    assert.equal(await exists(fileC), true);

    await session.prompt("/undo");
    assert.equal(await exists(fileA), true, "A should remain after the first undo");
    assert.equal(await exists(fileB), false, "B should be removed after the first undo");
    assert.equal(await exists(fileC), false, "C should be removed after the first undo");

    await session.prompt("/undo");
    assert.equal(await exists(fileA), false, "A should be removed after the second undo");

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
    await waitFor(() => countSnapshots(session, "after") >= 1, "A branch after snapshot was not created");
    await session.prompt("change branch.txt to C");
    await waitFor(() => countSnapshots(session, "after") >= 2, "C branch after snapshot was not created");

    const currentAfter = session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "workspace-history.snapshot" && (entry as any).data?.kind === "after");
    const cAfter = currentAfter[currentAfter.length - 1];
    assert.ok(cAfter, "C after snapshot should exist");

    await session.prompt("/undo");
    assert.equal(normalizeEol(await readText(fileA)), "A\n", "after undoing back before C, the file should be A");

    await session.prompt("change branch.txt to D");
    await waitFor(() => countSnapshots(session, "after") >= 3, "D branch after snapshot was not created");
    assert.equal(normalizeEol(await readText(fileA)), "D\n", "D branch should write D");

    const dAfter = session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "workspace-history.snapshot" && (entry as any).data?.kind === "after")
      .at(-1);
    assert.ok(dAfter, "D after snapshot should exist");

    const cTreeResult = await session.navigateTree(cAfter!.id, { summarize: false });
    assert.equal(cTreeResult.cancelled, false, "switching back to C branch should not be cancelled");
    assert.equal(normalizeEol(await readText(fileA)), "C\n", "workspace should restore C when switching back to C branch");

    const dTreeResult = await session.navigateTree(dAfter!.id, { summarize: false });
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
    await waitFor(() => countSnapshots(session1, "after") >= 1, "session1 after snapshot was not created");
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
    await waitFor(() => countSnapshots(session, "after") >= 1, ".pi file after snapshot was not created");
    assert.equal(normalizeEol(await readText(piFile)), "pi managed file\n");

    await session.prompt("/undo");
    assert.equal(await exists(piFile), false, ".pi regular file should be removed after /undo");

    await session.prompt("/redo");
    assert.equal(normalizeEol(await readText(piFile)), "pi managed file\n", ".pi regular file should be restored after /redo");

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
    await waitFor(() => countSnapshots(session, "after") >= 1, "outside storage after snapshot was not created");

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
    await waitFor(() => countSnapshots(session, "after") >= 1, "guard after snapshot was not created");

    await writeFile(filePath, "manual edit\n", "utf8");
    const undoLeafBefore = session.sessionManager.getLeafId();
    await session.prompt("/undo");
    const undoLeafAfter = session.sessionManager.getLeafId();

    assert.equal(undoLeafAfter, undoLeafBefore, "/undo should be blocked by unsnapshotted manual edits");
    assert.equal(normalizeEol(await readText(filePath)), "manual edit\n", "manual edits should remain after blocked /undo");

    await session.prompt("/checkpoint guard-manual");
    await session.prompt("/undo");
    assert.equal(await exists(filePath), false, "file should be removed after undo once manual edits are checkpointed");

    await session.prompt("/redo");
    assert.equal(normalizeEol(await readText(filePath)), "manual edit\n", "redo should restore the last successfully undone location");

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
    await waitFor(() => countSnapshots(session, "after") >= 1, "safe file after snapshot was not created");

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
    { name: "undo/redo restores workspace", run: testUndoRedo },
    { name: "undo preserves manual changes before next turn", run: testManualChangesProtectedAcrossUndo },
    { name: "repeated undo walks back turn by turn", run: testRepeatedUndo },
    { name: "checkpoint and dirty tree guard", run: testCheckpointAndTreeGuard },
    { name: "tree switching restores branch-specific workspace", run: testTreeBranchSwitching },
    { name: "undo does not leak across sessions", run: testUndoDoesNotLeakAcrossSessions },
    { name: ".pi files are managed except internal state", run: testPiFilesAreSnapshotManagedExceptInternalState },
    { name: "history is stored outside workspace", run: testHistoryIsStoredOutsideWorkspace },
    { name: "undo and redo block on unsnapshotted manual changes", run: testUndoAndRedoBlockOnUnsnapshottedManualChanges },
    { name: "restore failure does not delete current workspace", run: testRestoreFailureDoesNotDeleteCurrentWorkspace },
  ];

  for (const test of tests) {
    process.stdout.write(`RUN ${test.name}\n`);
    await test.run();
    process.stdout.write(`PASS ${test.name}\n`);
  }
}

await main();
