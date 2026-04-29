import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

async function createWorkspace(rootDir: string, fileCount: number, fileSize: number): Promise<string> {
  const cwd = path.join(rootDir, "workspace");
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(cwd, "src"), { recursive: true });

  const payload = "x".repeat(fileSize);
  for (let i = 0; i < fileCount; i += 1) {
    const dir = i % 10 === 0 ? path.join(cwd, "src", `group-${Math.floor(i / 10)}`) : path.join(cwd, "src");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `file-${i}.ts`), `export const v${i} = ${JSON.stringify(payload)};\n`, "utf8");
  }

  return cwd;
}

async function main(): Promise<void> {
  const fileCount = Number(process.argv[2] ?? 2000);
  const fileSize = Number(process.argv[3] ?? 256);
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-history-bench-"));

  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0 },
    branchSummary: { skipPrompt: true },
  });

  const provider = registerFauxProvider({
    provider: "timemachine-bench",
    api: "faux",
    models: [
      {
        id: "faux-1",
        name: "Timemachine Bench Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      },
    ],
  });

  try {
    const cwd = await createWorkspace(rootDir, fileCount, fileSize);

    modelRegistry.registerProvider("timemachine-bench", {
      api: "faux",
      apiKey: "TIMEMACHINE_BENCH_KEY",
      baseUrl: "http://localhost:0",
      models: [
        {
          id: "faux-1",
          name: "Timemachine Bench Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 4096,
        },
      ],
    });
    authStorage.setRuntimeApiKey("timemachine-bench", "test-key");

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

    const model = provider.getModel();
    const { session } = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      model,
      thinkingLevel: "off",
      authStorage,
      modelRegistry,
      resourceLoader,
      tools: ["read", "write", "edit"],
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });

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

    provider.setResponses([
      fauxAssistantMessage([
        fauxToolCall("write", {
          path: "bench-output.txt",
          content: "ok\n",
        }),
      ]),
      fauxAssistantMessage("done"),
    ]);

    const start = performance.now();
    await session.prompt("create bench-output.txt");
    const end = performance.now();

    console.log(JSON.stringify({
      fileCount,
      fileSize,
      elapsedMs: Math.round(end - start),
      cwd,
    }, null, 2));

    session.dispose();
  } finally {
    provider.unregister();
    await rm(rootDir, { recursive: true, force: true });
  }
}

await main();
