# Pi Coding Agent Workspace Timemachine：`/tree`、`/undo`、`/redo` 需求与技术设计文档

## 1. 背景与目标

本项目目标是在 `@mariozechner/pi-coding-agent` 中实现类似 Claude Code `/undo` 的体验，但其本质不应是一个孤立的撤销命令，而应是一个完整的“工作区时光机”。

用户在使用 Agent 编程时，经常会出现以下情况：

- Agent 改坏代码；
- Agent 误删文件；
- Agent 创建大量无用文件；
- 用户想回到某个历史聊天节点重新探索；
- 用户担心上下文污染，导致错误路线影响后续推理；
- 用户在两轮 Agent 之间手动修改、创建或删除文件。

因此，本功能的核心目标是：

> 用户在历史聊天树中选中任意节点时，聊天上下文和整个工作区文件状态都应同步恢复到该节点对应的真实状态。

换句话说：

```text
/tree = 真正的时间机器
/undo = /tree 向后导航一步的快捷命令
/redo = /tree 向前恢复刚才撤销状态的快捷命令
```

## 2. 核心设计原则

### 2.1 `/tree` 是唯一真相来源

所有历史恢复都应通过 `/tree` 的统一恢复能力完成。

包括：

- 用户手动执行 `/tree`；
- 用户执行 `/undo`；
- 用户执行 `/redo`；
- 未来 UI 点击历史节点；
- 未来可能出现的 `/checkout`、`/branch` 等命令。

都必须走同一套恢复逻辑。

禁止为 `/undo` 单独实现一套文件恢复逻辑。

### 2.2 `/undo` 不是恢复系统，只是导航快捷键

`/undo` 的语义是：

> 找到当前分支上最近一轮已经完成的 Agent turn，然后跳回这轮用户消息发送前的状态，并把该用户消息重新填回输入框。

例如：

```text
初始状态 S0
用户发送 A
Agent 执行 A
状态 S1

用户发送 B
Agent 执行 B
状态 S2

用户手动修改代码、创建文件 X、删除文件 Y
状态 S2'

用户发送 C
Agent 执行 C
状态 S3

用户执行 /undo
```

正确结果：

```text
输入框内容 = C
工作区状态 = before_C = S2'
```

注意：这里不是简单恢复到 `B 完成后状态 S2`。因为用户在 B 和 C 之间可能手动修改过工作区。`/undo C` 必须恢复到 C 这一轮 Agent 开始前的真实状态。

### 2.3 上下文与工作区必须同步

禁止出现以下错位状态：

```text
聊天上下文已经回到过去
但文件还停在未来
```

或：

```text
文件已经恢复到过去
但聊天上下文仍然停在未来
```

如果工作区恢复失败，必须取消 `/tree` 导航。

### 2.4 支持自由穿梭与分支探索

用户应该能够：

- 回到过去；
- 回到未来；
- 跨分支切换；
- 从旧节点重新发起新分支；
- 任意犯错后安全回退；
- 不担心错误上下文继续污染后续 Agent 行为。

## 3. 功能范围

### 3.1 必须支持

1. 每轮 Agent 开始前记录 `before` 快照。
2. 每轮 Agent 完成后记录 `after` 快照。
3. `/tree` 切换任意历史节点时恢复对应工作区状态。
4. `/undo` 回到最近一轮 Agent 开始前。
5. `/redo` 回到刚才撤销前的位置。
6. 文件内容修改必须恢复。
7. 新建文件必须在更早历史节点消失，在未来节点重新出现。
8. 删除文件必须在对应节点保持删除或重新出现。
9. 跨分支切换时，文件状态必须跟随分支节点切换。
10. 恢复失败必须阻止 tree navigation。
11. 插件自身状态不得污染用户项目主 Git 历史。
12. 插件状态不得进入 LLM 上下文。

### 3.2 第一版可以暂缓

以下功能可以作为增强项，不必阻塞 MVP：

- 恢复前 diff 预览；
- 可视化时间线；
- 快照压缩；
- 大文件存储优化；
- 远程同步快照；
- 多人协作冲突解决；
- 图形化分支命名。

### 3.3 明确不做

第一版不应做：

- 使用用户项目主 Git history 作为核心恢复依据；
- 自动提交到用户项目 Git 仓库；
- 修改用户正常开发分支；
- 把所有历史恢复逻辑写死在 `/undo` 内部；
- 只做单步 diff 回滚，不支持 `/tree` 任意节点恢复。

## 4. 用户体验语义

### 4.1 `/undo` 语义

执行完 C 后：

```text
/undo
```

应该发生：

```text
1. 找到 C 这一轮对应的 after snapshot
2. 找到 after snapshot 关联的 userEntryId，也就是用户消息 C
3. 调用 tree navigation 跳到 userEntryId
4. tree navigation 将 leaf 设置为 userEntryId.parent
5. 编辑器填充用户消息 C
6. workspace 恢复到 before_C
```

用户感知：

```text
刚才 C 的执行结果被撤销了
但 C 这条 prompt 回到了输入框
我可以修改 C 后重新执行
```

### 4.2 连续 `/undo`

```text
当前：A 完成 -> B 完成 -> C 完成
```

第一次 `/undo`：

```text
输入框 = C
工作区 = C 开始前真实状态
```

第二次 `/undo`：

```text
输入框 = B
工作区 = B 开始前真实状态
```

第三次 `/undo`：

```text
输入框 = A
工作区 = A 开始前真实状态
```

### 4.3 `/redo` 语义

用户执行 `/undo` 前，应保存当前位置作为 redo target。

```text
当前 leaf = after_C 或 C 完成后的某个结果节点
执行 /undo
保存 redo target = 当前 leaf
导航到 C 的 userEntryId
```

用户执行 `/redo`：

```text
读取 redo target
调用 tree navigation 跳回 redo target
workspace 恢复到 redo target 对应状态
```

### 4.4 用户手动修改后的语义

场景：

```text
Agent 执行完 B
用户手动修改代码
用户手动创建 X
用户手动删除 Y
用户发送 C
Agent 执行 C
用户 /undo
```

正确行为：

```text
恢复到发送 C 后、Agent 执行 C 前的状态
也就是保留用户手动修改、保留 X、保持 Y 删除
只撤销 C 这一轮 Agent 造成的变更
```

这要求 `before_C` 必须在 C 这一轮 Agent 开始前即时记录。

### 4.5 用户没有发送新消息但直接 `/tree`

场景：

```text
Agent 执行完 C
用户手动修改文件
用户没有发送 D
用户直接 /tree 跳到历史节点
```

这些手动修改尚未被任何 `before` snapshot 捕获。

必须提供 dirty guard：

```text
检测到当前工作区存在未快照变更。
请选择：
1. 保存为 manual checkpoint 后切换
2. 丢弃这些变更并切换
3. 取消切换
```

第一版如果交互 API 不方便，也至少应默认取消切换，并提示用户先执行 `/checkpoint`。

## 5. 技术架构概览

### 5.1 推荐实现方式

第一版建议实现为 Pi extension：

```text
.pi/extensions/workspace-history.ts
```

或全局安装：

```text
~/.pi/agent/extensions/workspace-history.ts
```

更推荐全局安装，避免插件文件本身被项目工作区恢复逻辑影响。

### 5.2 使用 Pi extension 能力

需要用到：

```ts
pi.on("before_agent_start", ...)
pi.on("agent_end", ...)
pi.on("session_before_tree", ...)
pi.registerCommand("undo", ...)
pi.registerCommand("redo", ...)
pi.registerCommand("checkpoint", ...)
pi.appendEntry(...)
ctx.navigateTree(...)
ctx.waitForIdle()
ctx.sessionManager.getBranch()
ctx.sessionManager.getLeafId()
ctx.sessionManager.getEntry(...)
```

### 5.3 状态存储

使用 shadow git 仓库存储工作区快照：

```text
.pi/workspace-history/
  repo.git/
  redo.json
  logs/
  config.json
```

不要使用用户项目 `.git` 作为恢复依据。

原因：

```text
用户项目 Git = 用户自己的开发历史
shadow git = 插件内部时光机状态
```

二者必须隔离。

## 6. Snapshot 数据模型

### 6.1 Snapshot 类型

```ts
type SnapshotKind = "baseline" | "before" | "after" | "manual";

interface WorkspaceSnapshot {
  v: 1;
  kind: SnapshotKind;
  commit: string;

  turnId?: string;

  // before snapshot
  promptText?: string;

  // after snapshot
  beforeSnapshotId?: string;
  userEntryId?: string;
  resultLeafId?: string;

  // manual checkpoint
  label?: string;

  createdAt: string;
}
```

### 6.2 字段解释

#### `kind`

- `baseline`：插件启用时或新 session 开始时的初始状态；
- `before`：某轮 Agent 开始前的真实工作区状态；
- `after`：某轮 Agent 完成后的真实工作区状态；
- `manual`：用户手动保存的检查点。

#### `commit`

shadow git 中对应的 commit hash。

#### `turnId`

用于关联同一轮 Agent 的 before/after。

#### `beforeSnapshotId`

`after` snapshot 指向对应的 `before` snapshot entry id。

#### `userEntryId`

`after` snapshot 指向该轮用户消息 entry id。

`/undo` 需要用它跳回用户消息，使输入框重新填入该 prompt。

#### `resultLeafId`

`after` snapshot 记录创建 after snapshot 前的 leaf。

这非常关键。

原因：用户在 `/tree` 中选择某个 assistant/tool result 节点时，不能简单寻找祖先链上的最近 snapshot。因为在一轮 Agent 执行期间，assistant 节点的祖先上最近 snapshot 往往是 `before`，但用户选择 assistant 结果节点时，预期工作区应恢复为该轮完成后的 `after` 状态。

因此必须用 `resultLeafId` 建立：

```text
visible result node -> after snapshot
```

的映射。

## 7. Session 节点结构

理想结构：

```text
baseline snapshot
  ↓
before_A snapshot
  ↓
user A
  ↓
assistant/tool result A
  ↓
after_A snapshot
  ↓
before_B snapshot
  ↓
user B
  ↓
assistant/tool result B
  ↓
after_B snapshot
```

如果用户 `/undo B`：

```text
找到 after_B
读取 userEntryId = user B
navigateTree(user B)
恢复 before_B
编辑器填充 B
```

如果用户 `/tree` 选择 assistant result A：

```text
根据 resultLeafId 找到 after_A
恢复 after_A
leaf 切到 assistant result A
```

如果用户 `/tree` 选择 user B：

```text
leaf 切到 user B.parent
恢复 before_B
编辑器填充 B
```

## 8. Shadow Git 设计

### 8.1 初始化

伪代码：

```ts
async function ensureShadowRepo(pi, cwd: string) {
  const root = `${cwd}/.pi/workspace-history`;
  const gitDir = `${root}/repo.git`;

  await pi.exec("mkdir", ["-p", root]);

  if (!(await exists(gitDir))) {
    await pi.exec("git", ["init", "--bare", gitDir]);
  }

  await pi.exec("git", [
    "--git-dir", gitDir,
    "--work-tree", cwd,
    "config", "user.name", "workspace-history",
  ]);

  await pi.exec("git", [
    "--git-dir", gitDir,
    "--work-tree", cwd,
    "config", "user.email", "workspace-history@local",
  ]);
}
```

### 8.2 创建快照 commit

```ts
async function createSnapshotCommit(pi, cwd: string, label: string) {
  const gitDir = `${cwd}/.pi/workspace-history/repo.git`;

  await pi.exec("git", [
    "--git-dir", gitDir,
    "--work-tree", cwd,
    "add", "-A", "--",
    ".",
    ":(exclude).git",
    ":(exclude).pi/workspace-history",
  ]);

  await pi.exec("git", [
    "--git-dir", gitDir,
    "--work-tree", cwd,
    "commit", "--allow-empty", "-m", `[workspace-history] ${label}`,
  ]);

  const result = await pi.exec("git", [
    "--git-dir", gitDir,
    "--work-tree", cwd,
    "rev-parse", "HEAD",
  ]);

  return result.stdout.trim();
}
```

### 8.3 恢复快照

```ts
async function restoreSnapshotCommit(pi, cwd: string, commit: string) {
  const gitDir = `${cwd}/.pi/workspace-history/repo.git`;

  await pi.exec("git", [
    "--git-dir", gitDir,
    "--work-tree", cwd,
    "reset", "--hard", commit,
  ]);

  await pi.exec("git", [
    "--git-dir", gitDir,
    "--work-tree", cwd,
    "clean", "-fdx",
    "-e", ".git",
    "-e", ".pi/workspace-history",
  ]);
}
```

`git clean -fdx` 很关键。没有它，后来新建的文件不会在回到更早节点时消失。

## 9. 文件范围策略

### 9.1 默认策略

默认应快照：

- Git tracked 文件；
- 未被 ignore 的 untracked 文件。

默认应排除：

```text
.git/
.pi/workspace-history/
node_modules/
dist/
build/
.cache/
.next/
.turbo/
coverage/
.env
.env.*
```

### 9.2 精确恢复与安全性的取舍

严格来说，如果排除了 ignored 文件，那么它不是字面意义上的“整个目录完全恢复”。

但这是现实工程中的必要折中：

- 避免快照巨大；
- 避免保存敏感文件；
- 避免缓存目录污染；
- 避免性能不可控。

可以提供高级配置：

```json
{
  "includeIgnored": false,
  "includePatterns": [],
  "excludePatterns": [
    ".git/**",
    ".pi/workspace-history/**",
    "node_modules/**",
    ".env*"
  ]
}
```

若用户显式开启 `includeIgnored: true`，才捕获 ignored 文件。

## 10. 事件时序设计

### 10.1 初始化 baseline

插件首次启用或当前 session 首次使用时：

```text
ensureShadowRepo
create baseline commit
append baseline snapshot custom entry
```

如果是已有老 session 中途启用，只能保证启用后的节点可以精确恢复。旧历史节点没有 snapshot 时，应明确提示无法恢复。

### 10.2 `before_agent_start`

目标：捕获这一轮 Agent 开始前的真实工作区状态。

伪代码：

```ts
let pendingTurnId: string | undefined;
let pendingBeforeSnapshotId: string | undefined;

pi.on("before_agent_start", async (event, ctx) => {
  await ensureShadowRepo(pi, ctx.cwd);

  clearRedoStackIfNeeded(ctx);

  const turnId = crypto.randomUUID();
  const commit = await createSnapshotCommit(pi, ctx.cwd, `before ${turnId}`);

  pi.appendEntry("workspace-history.snapshot", {
    v: 1,
    kind: "before",
    commit,
    turnId,
    promptText: event.promptText,
    createdAt: new Date().toISOString(),
  });

  // 注意：不要假设 pi.appendEntry 返回 id。
  // append 后应通过 getLeafId 获取新 entry id。
  pendingBeforeSnapshotId = ctx.sessionManager.getLeafId();
  pendingTurnId = turnId;
});
```

关键点：

```text
不要写 const id = pi.appendEntry(...)
```

应写：

```ts
pi.appendEntry(...);
const id = ctx.sessionManager.getLeafId();
```

### 10.3 `agent_end`

目标：捕获这一轮 Agent 完成后的真实工作区状态。

但要注意：`agent_end` 可能不一定代表“最终稳定结束”。如果 Pi 内部后续还有 retry、auto-compaction、pending follow-up，那么在 `agent_end` 立刻记录 after 可能捕获到中间态。

MVP 可以先过滤明显错误态；更理想的方案是向 Pi core 增加 `agent_settled` hook。

MVP 伪代码：

```ts
pi.on("agent_end", async (event, ctx) => {
  if (!pendingTurnId || !pendingBeforeSnapshotId) return;

  if (isErrorOrRetryIntermediateState(event)) {
    return;
  }

  const resultLeafId = ctx.sessionManager.getLeafId();
  const userEntryId = findUserEntryAfter(ctx, pendingBeforeSnapshotId);

  const commit = await createSnapshotCommit(pi, ctx.cwd, `after ${pendingTurnId}`);

  pi.appendEntry("workspace-history.snapshot", {
    v: 1,
    kind: "after",
    commit,
    turnId: pendingTurnId,
    beforeSnapshotId: pendingBeforeSnapshotId,
    userEntryId,
    resultLeafId,
    createdAt: new Date().toISOString(),
  });

  pendingTurnId = undefined;
  pendingBeforeSnapshotId = undefined;
});
```

## 11. `/tree` 恢复算法

### 11.1 目标解析

用户在 `/tree` 中选择不同类型节点时，Pi 的 leaf 语义不同：

- 选择 user message：leaf 应变为 user message 的 parent，并把 user message 文本放回输入框；
- 选择普通 assistant/tool result：leaf 变为该节点；
- 选择 custom/internal entry：通常应视具体类型决定。

因此恢复算法不能简单地“找目标节点祖先链上的最近 snapshot”。

### 11.2 错误算法示例

错误：

```text
target = assistant_C
nearest ancestor snapshot = before_C
restore before_C
```

这会导致用户点 assistant C 结果时，工作区却恢复到 C 执行前。

正确应该恢复到 after_C。

### 11.3 正确算法

伪代码：

```ts
async function resolveSnapshotForTreeTarget(ctx, targetId: string): Promise<SnapshotEntry | undefined> {
  const entry = ctx.sessionManager.getEntry(targetId);
  if (!entry) return undefined;

  // 1. 如果目标本身就是 workspace snapshot
  if (isWorkspaceSnapshotEntry(entry)) {
    return entry;
  }

  // 2. 如果目标是 user message
  // tree 导航语义是回到 user.parent，并填充编辑器
  // 应恢复该 user message 对应 turn 的 before snapshot。
  if (isUserMessage(entry)) {
    return findBeforeSnapshotForUserEntry(ctx, entry.id)
      ?? findNearestSnapshotOnEffectiveLeaf(ctx, entry.parentId);
  }

  // 3. 如果目标是 assistant/tool/result 节点
  // 优先找 resultLeafId 指向该节点的 after snapshot。
  const after = findAfterSnapshotByResultLeafId(ctx, targetId);
  if (after) return after;

  // 4. 否则寻找覆盖该节点的最近有效 snapshot。
  return findNearestEffectiveSnapshot(ctx, targetId);
}
```

### 11.4 `session_before_tree` 处理

```ts
pi.on("session_before_tree", async (event, ctx) => {
  const targetId = event.preparation.targetId;

  const dirty = await isWorkspaceDirtyAgainstCurrentSnapshot(ctx);
  if (dirty && !isInternalRedoOrUndoNavigation()) {
    ctx.ui.notify(
      "当前工作区有未快照变更。请先执行 /checkpoint 保存，或手动清理后再切换。",
      "error"
    );
    return { cancel: true };
  }

  const snapshot = await resolveSnapshotForTreeTarget(ctx, targetId);

  if (!snapshot) {
    ctx.ui.notify("该历史节点没有 workspace snapshot，无法精确恢复。", "error");
    return { cancel: true };
  }

  try {
    await restoreSnapshotCommit(pi, ctx.cwd, snapshot.data.commit);
    logRestore(ctx, targetId, snapshot);
  } catch (error) {
    ctx.ui.notify(`Workspace restore failed: ${String(error)}`, "error");
    return { cancel: true };
  }
});
```

### 11.5 关于 summary 的重要风险

Pi 的 `/tree` 流程可能是：

```text
session_before_tree
  ↓
summary generation
  ↓
leaf switch
```

如果在 `session_before_tree` 中已经恢复工作区，但后续 summary 失败或 tree navigation 被取消，会导致：

```text
文件已经切过去
聊天没有切过去
```

MVP 处理建议：

```text
/undo 和 /redo 强制 summarize:false。
手动 /tree 如果需要 summary，则第一版应禁用工作区恢复或提示用户选择 no summary。
```

更理想的 core patch：

```text
增加 session_before_tree_commit hook
触发时机：summary 已成功完成，但 leaf 尚未切换
workspace restore 放到该 hook
```

## 12. `/undo` 命令设计

### 12.1 目标

`/undo` 只负责找到目标节点，并调用 `ctx.navigateTree()`。

不得直接操作 shadow git 恢复文件。

### 12.2 伪代码

```ts
pi.registerCommand("undo", {
  description: "Undo last agent turn and restore workspace",
  handler: async (_args, ctx) => {
    await ctx.waitForIdle();

    const branch = ctx.sessionManager.getBranch();
    const after = findLastAfterSnapshot(branch);

    if (!after?.data?.userEntryId) {
      ctx.ui.notify("Nothing to undo.", "info");
      return;
    }

    saveRedoTarget(ctx, ctx.sessionManager.getLeafId());

    markInternalNavigation("undo");

    const result = await ctx.navigateTree(after.data.userEntryId, {
      summarize: false,
    });

    clearInternalNavigationMark();

    if (result.cancelled) {
      ctx.ui.notify("Undo cancelled.", "error");
      return;
    }

    const userEntry = ctx.sessionManager.getEntry(after.data.userEntryId);
    const text = extractUserText(userEntry);
    if (text) {
      ctx.ui.setEditorText(text);
    }

    ctx.ui.notify("Undo complete. Workspace restored to before that turn.", "info");
  },
});
```

## 13. `/redo` 命令设计

### 13.1 redo stack

`redo.json` 示例：

```json
{
  "sessionId": "...",
  "stack": [
    {
      "targetId": "entry-id-before-undo",
      "createdAt": "2026-04-28T00:00:00.000Z"
    }
  ]
}
```

### 13.2 伪代码

```ts
pi.registerCommand("redo", {
  description: "Redo previously undone agent turn and restore workspace",
  handler: async (_args, ctx) => {
    await ctx.waitForIdle();

    const redo = popRedoTarget(ctx);
    if (!redo) {
      ctx.ui.notify("Nothing to redo.", "info");
      return;
    }

    markInternalNavigation("redo");

    const result = await ctx.navigateTree(redo.targetId, {
      summarize: false,
    });

    clearInternalNavigationMark();

    if (result.cancelled) {
      ctx.ui.notify("Redo cancelled.", "error");
      return;
    }

    ctx.ui.notify("Redo complete. Workspace restored.", "info");
  },
});
```

### 13.3 redo 失效规则

以下情况必须清空 redo stack：

- 用户在 undo 后发送新的 prompt；
- 产生新的 Agent turn；
- 用户创建 manual checkpoint；
- 用户手动 `/tree` 跳到其他节点；
- 当前分支产生新历史。

否则会出现旧未来节点和新分支混杂，用户会困惑。

## 14. `/checkpoint` 命令设计

### 14.1 目标

保护用户手动修改但尚未发送新 Agent prompt 的工作区状态。

### 14.2 语义

```text
/checkpoint [label]
```

效果：

```text
记录当前工作区为 manual snapshot
append custom entry 到当前 session branch
当前 leaf 更新为 manual snapshot
```

### 14.3 伪代码

```ts
pi.registerCommand("checkpoint", {
  description: "Save current workspace state as a manual time-machine checkpoint",
  handler: async (args, ctx) => {
    await ctx.waitForIdle();

    const label = args.join(" ") || "manual checkpoint";
    const commit = await createSnapshotCommit(pi, ctx.cwd, label);

  pi.appendEntry("workspace-history.snapshot", {
      v: 1,
      kind: "manual",
      commit,
      label,
      createdAt: new Date().toISOString(),
    });

    clearRedoStack(ctx);

    ctx.ui.notify(`Checkpoint saved: ${label}`, "info");
  },
});
```

## 15. 日志与可观测性

必须记录：

```text
创建 snapshot：
  session id
  entry id
  kind
  turn id
  commit hash
  current leaf id

恢复 snapshot：
  source command: tree / undo / redo
  target id
  resolved snapshot id
  snapshot kind
  commit hash
  restore result

失败：
  error stack
  git command
  cwd
  target id
```

日志位置：

```text
.pi/workspace-history/logs/timemachine.log
```

示例：

```text
[2026-04-28T12:00:00.000Z] create before snapshot turn=abc entry=e1 commit=123 leaf=e1
[2026-04-28T12:01:00.000Z] create after snapshot turn=abc entry=e9 resultLeaf=e8 commit=456
[2026-04-28T12:02:00.000Z] restore source=undo target=userC snapshot=before_C commit=123 ok
```

## 16. UI/UX 要求

### 16.1 成功提示

`/undo`：

```text
Undo complete. Workspace restored to before that turn.
```

`/redo`：

```text
Redo complete. Workspace restored.
```

`/checkpoint`：

```text
Checkpoint saved: <label>
```

### 16.2 失败提示

```text
Workspace restore failed. Tree navigation cancelled.
```

或：

```text
This history node has no workspace snapshot. Cannot restore precisely.
```

### 16.3 当前状态展示

增强项：

```text
Current workspace snapshot:
  kind: after
  turn: 12
  commit: abc123
  branch: main -> experiment-2
  redo: available
```

可以后续实现 `/timemachine-status`。

## 17. 关键边界情况

### 17.1 插件中途启用

如果历史节点没有 snapshot：

```text
不能恢复，必须提示用户。
```

禁止假装恢复成功。

### 17.2 恢复失败

如果 shadow git reset 或 clean 失败：

```text
取消 tree navigation
保留当前聊天 leaf
提示错误
写日志
```

### 17.3 当前工作区有未保存手动修改

不能直接覆盖。

MVP：提示用户先 `/checkpoint`。

增强版：提供交互选择：

```text
Save checkpoint and switch
Discard and switch
Cancel
```

### 17.4 新分支产生

如果用户 undo 后修改 prompt 重新发送：

```text
旧 redo stack 清空
产生新的 before/after snapshot 链
旧分支仍可通过 /tree 找到
```

### 17.5 选择 assistant 中间节点

如果用户选择的是某轮 Agent 中间 tool result，而不是最终 resultLeaf：

第一版可以采用：

```text
如果没有精确 resultLeafId 匹配，则恢复最近完成的 after snapshot 或最近祖先 snapshot。
```

更严格做法：每个 tool result 后都打微快照。但这会导致性能和存储开销大。MVP 不建议。

### 17.6 summary 风险

由于 `session_before_tree` 可能早于 summary 完成，MVP 必须限制：

```text
/undo、/redo：summarize:false
手动 /tree + workspace restore：建议不使用 summary，或提示风险
```

长期应补 core hook。

## 18. 验收标准

### 18.1 基础 undo

步骤：

```text
初始无文件 A
用户让 Agent 创建 A
确认 A 存在
执行 /undo
```

期望：

```text
A 消失
输入框填充创建 A 的 prompt
聊天回到该 prompt 发送前
```

### 18.2 连续 undo

步骤：

```text
第 1 轮创建 A
第 2 轮创建 B、C
执行 /undo
执行 /undo
```

期望：

```text
第一次 undo：B、C 消失，A 保留
第二次 undo：A 消失
```

### 18.3 redo

步骤：

```text
创建 A
/undo
/redo
```

期望：

```text
/undo 后 A 消失
/redo 后 A 重新出现
```

### 18.4 用户手动修改保护

步骤：

```text
第 1 轮 Agent 创建 A
用户手动删除 A
用户发送第 2 轮，让 Agent 创建 B
执行 /undo
```

期望：

```text
B 消失
A 不应复活
```

这是最关键的测试之一，因为它证明 `/undo` 恢复的是 before_C，而不是 after_B。

### 18.5 文件内容多版本

步骤：

```text
第 1 轮新增一行 x=1
第 2 轮改成 x=2
第 3 轮删除该行
/tree 回到第 1 轮结果
/tree 回到第 2 轮结果
/tree 回到第 3 轮结果
```

期望：

```text
第 1 轮：x=1
第 2 轮：x=2
第 3 轮：该行不存在
```

### 18.6 跨分支

步骤：

```text
A -> B -> C
/tree 回到 B
修改 prompt 生成 D 分支
/tree 选择 C
/tree 选择 D
```

期望：

```text
选择 C 时，工作区是 C 分支状态
选择 D 时，工作区是 D 分支状态
C 不污染 D
D 不污染 C
```

### 18.7 恢复失败取消导航

人为制造 shadow git restore 失败。

期望：

```text
/tree 导航取消
聊天 leaf 不变
工作区不应半恢复
日志记录错误
```

### 18.8 手动修改后直接 tree

步骤：

```text
Agent 完成 C
用户手动修改文件 Z
用户直接 /tree 到旧节点
```

期望：

```text
系统检测到未快照变更
取消导航或要求 /checkpoint
不能静默覆盖 Z
```

## 19. 推荐开发顺序

### Phase 1：MVP

1. 创建 extension 文件。
2. 实现 shadow git 初始化。
3. 实现 create snapshot commit。
4. 实现 restore snapshot commit。
5. 实现 baseline snapshot。
6. 在 `before_agent_start` 记录 before。
7. 在 `agent_end` 记录 after。
8. 实现 snapshot entry 查找。
9. 实现 `session_before_tree` 恢复。
10. 实现 `/undo`。
11. 实现 `/redo`。
12. 跑基础验收测试。

### Phase 2：可靠性

1. dirty guard。
2. `/checkpoint`。
3. redo 失效规则。
4. resultLeafId 精确匹配。
5. 日志。
6. 错误恢复与取消导航。

### Phase 3：体验增强

1. diff 预览。
2. `/timemachine-status`。
3. `/timemachine-log`。
4. `/timemachine-prune`。
5. tree UI 隐藏内部 snapshot entry。

### Phase 4：Core patch

建议向 Pi core 增加：

```text
session_before_tree_commit
```

语义：

```text
summary 已经成功完成
leaf 尚未切换
此时允许 extension 执行 workspace restore
restore 失败可以取消最终 leaf switch
```

还建议让 `ctx.navigateTree()` 向 extension 返回完整结果：

```ts
{
  cancelled: boolean;
  editorText?: string;
  leafId?: string;
}
```

## 20. 最终判断

该设计逻辑自洽的前提是：

```text
/tree 是唯一恢复入口
/undo 和 /redo 只做 tree navigation
before snapshot 捕获每轮 Agent 开始前真实状态
after snapshot 捕获每轮 Agent 完成后真实状态
assistant/result 节点通过 resultLeafId 映射到 after snapshot
恢复失败必须取消导航
未快照手动修改必须保护
redo 必须在新分支产生时失效
```

在这些条件满足后，用户可以获得接近“工作区时光机”的体验：

```text
可以随意让 Agent 尝试
可以犯错
可以回退
可以前进
可以开分支
可以避免错误上下文污染
不用担心文件残留或误复活
```

一句话总结：

> `/undo` 没有神秘性，它只是 `/tree` 导航的快捷方式；真正要做好的，是让 `/tree` 成为聊天上下文和工作区状态共同遵循的唯一时间轴。
