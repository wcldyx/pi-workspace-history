# pi-workspace-history

[English version](./README.md)

给 Pi 补上真正可用的工作区级 Undo / Redo。

把接近 OpenCode 的 `/undo` 体验带给 Pi，并补上类似 Claude Code 那种让人敢放心改代码的工作区回退安全感。

![workspace-history 演示](./demo.gif)

## 为什么值得用

- 撤销的是整个工作区，不只是聊天记录
- 让你敢放心让 Agent 真改代码
- 通过 `/tree` 恢复历史分支对应的工作区状态
- 只回退对话上下文时保留当前文件
- 通过 `/checkpoint` 保护手动修改

## 这是什么

`workspace-history` 是一个面向 `@earendil-works/pi-coding-agent` 0.84.4 及以上版本的工作区历史插件，需要 Node.js 22.19.0 或更高版本。

它不是单纯给 `pi` 增加一个 `/undo` 命令，而是要协调聊天历史与本地工作区的真实状态，同时允许用户选择是否随导航恢复文件。

它的核心目标是：

```text
当用户在历史聊天树中切换到任意节点时，
可以同时恢复聊天上下文和工作区文件状态，
也可以只回退对话并保留当前文件。
```

换句话说：

- `/tree` 是真正的时间机器
- `/undo` 是沿着 `/tree` 向后导航一步的快捷命令
- `/redo` 是回到刚才撤销前位置的快捷命令

## 这个插件有什么用

在使用 Agent 编程时，经常会遇到这些问题：

- Agent 改坏了代码
- Agent 误删了文件
- Agent 创建了很多无用文件
- 你想回到某个历史节点重新探索另一条路线
- 你在两轮 Agent 之间手动改过代码、创建过文件、删掉过文件
- 你不希望错误上下文继续污染后续推理

这个插件解决的不是“单步撤销文本编辑”，而是协调整个工作区快照与聊天历史导航，也支持保留当前文件的纯对话回退。

它的价值在于：

- 让 `/undo` 真正撤销一整轮 Agent 的结果，而不只是恢复一部分文件
- 让 `/tree` 不只是切换聊天视图，还能同步恢复工作区
- 让你安全地在历史分支之间来回切换
- 保留用户在 Agent 回合之间的手动修改语义
- 避免把插件内部状态污染进用户项目自己的 Git 历史

## 具体诉求

这个插件围绕下面这些明确诉求设计：

1. 每轮 Agent 开始前，记录一份 `before` 快照。
2. 每轮 Agent 完成后，记录一份 `after` 快照。
3. 用户通过 `/tree` 或 `/undo` 导航时，可以选择同时恢复对话和工作区，或只回退对话。
4. 选择恢复工作区时，`/undo` 应恢复“这一轮开始前的真实状态”，而不是简单回到上一轮 Agent 完成后的状态。
5. 如果用户在两轮 Agent 之间手动删了文件、改了代码、建了新文件，这些变化在下一轮开始前应被记录进 `before snapshot`。
6. 如果当前工作区有尚未快照的手动修改，恢复工作区时不能默默覆盖；只回退对话时则自动保存并锚定这些修改。
7. 插件自己的内部状态应该和用户项目主 Git 历史隔离，不能污染用户仓库。
8. 多个 session 之间的快照和 redo 状态应该相互隔离，不能串台。

## 主要功能

- `/undo`
  - 可选择同时恢复对话和工作区，或只回退对话
  - 第一项默认保持原有的同步恢复行为
  - 把该轮用户 prompt 放回输入框，方便修改后重试
  - 把原始 prompt、全部工具轮次、自动重试、compaction continuation，以及排队的 `steer` / `followUp` 输入视为同一个操作

- `/redo`
  - 回到刚才 `/undo` 之前的位置
  - 自动沿用 `/undo` 选择的模式，不重复询问

- `/checkpoint [label]`
  - 保存当前工作区为一个手动检查点
  - 用于保护尚未发送新 prompt 的手动修改

- 基于 `/tree` 的工作区恢复
  - 选定历史节点后，可选择是否恢复对应的工作区状态
  - 同时覆盖 `/tree` 和 Pi 的双击 `Esc` 历史树入口
  - 支持在不同历史分支之间来回切换
  - 选择“只回退对话”时支持生成分支摘要；请求摘要时仍会阻止“同时恢复工作区”，因为摘要生成可能在对话切换完成前被取消
  - 如果此前中断的恢复仍待处理，摘要导航会在不修改文件的情况下取消；可改用不生成摘要的导航，或先用 `/checkpoint` 保留后续修改
  - user、assistant、tool result、custom message、compaction 和 branch summary 节点都会解析到对应操作的精确快照；没有精确语义锚点时会取消恢复

- Dirty guard
  - 如果当前工作区有未快照的手动修改，会阻止危险的工作区恢复
  - 只回退对话时会保留并快照这些修改，不会覆盖

- Session isolation
  - 每个 session 使用独立的 shadow git 和 redo 状态
  - 避免新会话 `/undo` 时串到旧会话历史

## 工作方式

插件内部使用独立的 shadow git 来保存快照，而不是依赖用户项目本身的 `.git` 历史。

同一套文件历史流程可用于 Git 仓库、Jujutsu 仓库以及 Git/Jujutsu colocated 仓库。仓库元数据（`.git/` 和 `.jj/`）不会进入快照，也不会被恢复。因此，工作区撤销只恢复文件内容，不会回退 Git 的 commit、branch 或 index，也不会回退 Jujutsu 的 commit、bookmark 或 operation。撤销后，`git status` 或 `jj status` 可能会把恢复的文件显示为工作区修改；如需回退仓库历史，请使用对应 VCS 自身的恢复命令。

即使工作区只使用 Jujutsu，扩展仍需要 Git 可执行文件来维护私有 shadow 仓库。

一个撤销单元从原始 prompt 开始，直到 Pi 报告 Agent 已 settled 为止。中间工具轮次各自拥有 `/tree` 锚点，但排队输入不会替换该操作最初的 prompt 或 `before` 快照。因此，一次 `/undo` 会完整撤销多轮工具调用的全部结果，`/redo` 也会把它作为整体恢复。

只回退对话且不生成分支摘要时，插件会先处理此前中断恢复留下的待恢复工作；如果中断恢复后文件又被修改，这些后续修改会自动保留。随后插件快照当前文件，并将其作为后续历史分支的起点。继续对话后，分支中正常可见的消息节点即可通过 `/tree` 恢复这份保留的工作区状态。取消选择时，对话和工作区都不改变；非交互模式继续沿用原来的“对话和工作区一起恢复”行为。

默认快照范围：

- 已由内部 shadow 仓库纳管的文件
- 未被 ignore 的新文件
- 命中工作区 `.gitignore` 的路径会被过滤掉，即使它们此前已经进入过快照范围

默认排除：

- `.git/`
- `.jj/`
- `.pi/workspace-history/`
- `node_modules/`
- `dist/`
- `build/`
- `.cache/`
- `.next/`
- `.turbo/`
- `coverage/`
- `.env`
- `.env.*`

这些路径属于硬排除。即使工作区 `.gitignore` 写了 `!.env.local` 或 `!node_modules/example.js`，也不能把它们重新纳入快照。升级后，新快照还会移除旧版本曾纳管的排除路径；恢复旧快照时也不会覆盖当前的排除文件。

恢复时，插件只恢复它纳管的文件集合，不会粗暴地对整个工作区做无差别清理。

在 Windows 上，恢复操作会重试短暂锁定的纳管文件。如果文件持续被占用，导航会取消而不会跳过该文件，并在提示中指出失败的 Git 文件操作。待恢复状态可跨会话或扩展重载保留；恢复失败后产生的新编辑不会被自动覆盖，可先用 `/checkpoint` 保留。

插件会在使用前校验当前 session 的 shadow repo。如果已校验的仓库在 session 运行期间消失，插件会检测并自动重建。如果当前 session repo 或工作区 reusable repo 无效，插件会先将其原样保留为同级的 `repo.git.invalid-<timestamp>-<uuid>`，再自动重建可用仓库。后续快照可继续正常工作，但仅存在于丢失或无效仓库中的旧快照可能不可用。其他 session 的无效仓库只会被跳过，不会被修改。

## 配置

通过 Pi 的 settings 配置：

- 全局：`~/.pi/agent/settings.json`
- 项目：`.pi/settings.json`

示例：

```json
{
  "workspaceHistory": {
    "storageDir": "D:\\pi-history",
    "maxSessionsPerWorkspace": 3,
    "maxWorkspaces": 10
  }
}
```

配置项：

- `workspaceHistory.storageDir`
  - shadow history 的外部存储根目录
  - 默认：`~/.pi/agent/state/workspace-history`
  - 必须位于工作区之外。如果它等于工作区或位于工作区内部，即使 `enabled` 为 `true`，插件也会禁用，且不会在其中创建历史目录。
- `workspaceHistory.maxSessionsPerWorkspace`
  - 通过清理最久未使用的非活跃 session，使每个工作区的 session 总数尽量保持在上限内
  - 活跃 session 永远不会被清理，因此总数可能暂时超过此上限
  - 默认：`3`
- `workspaceHistory.maxWorkspaces`
  - 通过清理最久未使用的非活跃工作区，使全局工作区总数尽量保持在上限内
  - 包含活跃 session 的工作区永远不会被清理，因此总数可能暂时超过此上限
  - 默认：`10`
- `workspaceHistory.enabled`
  - `auto`（默认）在当前目录或祖先目录存在已声明项目标记时启用
  - `true` 强制启用
  - `false` 完全禁用
- `workspaceHistory.allowHomeDirectory`
  - 是否允许在用户 home 目录启用
  - 默认：`false`
- `workspaceHistory.requireProjectMarker`
  - 是否要求当前目录或祖先目录存在 `.git`、`.jj`、`package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml` 等项目标记
  - 默认：`true`
  - 设为 `false` 时，自动模式允许文件系统根目录和用户 home 目录以外的任意目录（home 目录仍需同时启用 `allowHomeDirectory`）
- `workspaceHistory.maxScanFiles`
- `workspaceHistory.maxScanDirs`
- `workspaceHistory.maxScanMs`
  - 恢复时扫描工作区的安全限制
- `workspaceHistory.gitTimeoutMs`
  - 插件内部 git 操作超时时间

## 安装与使用

如果作为插件包安装：

```bash
pi install npm:pi-workspace-history
```

当这个包发布到 npm 后，用户就可以直接用上面的命令安装。

如果从本地仓库安装：

```bash
pi install /path/to/workspace-history
```

## 本地开发

当前仓库也支持项目内直接加载扩展，便于开发调试：

```text
.pi/extensions/workspace-history.ts
.pi/settings.json
```

在这个目录启动 `pi`，或执行 `/reload` 后即可测试本地修改。

也可以把 `workspace-history.ts` 放到：

- `~/.pi/agent/extensions/`
- `.pi/extensions/`

## 测试

开发与 CI 使用 `@earendil-works/pi-coding-agent` 0.84.4 和 Node.js 22.19.0，并同时在 Linux 与 Windows 上运行。

运行自动化测试：

```bash
npm test
```

运行类型检查：

```bash
npm run typecheck
```

## 最近更新

- Git、Jujutsu 和 colocated 仓库共用同一套文件历史流程，同时保持各自的 VCS 元数据不变
- 完整的多轮 Agent 操作现在作为一个 undo / redo 单元
- 即使 `.gitignore` 使用反向规则，硬排除路径也不会重新被纳管
- Git、Rust、Go、Python 等项目标记可从祖先目录识别
- 无效 shadow repo 会自动隔离并重建
- 并发运行的活跃 session 不会被保留清理误删

## 存储目录

插件默认把历史存到工作区外：

```text
~/.pi/agent/state/workspace-history/
  workspaces/
    <workspaceHash>/
      meta.json
      sessions/
        <sessionId>/
          active-session.json
          repo.git/
          redo.json
          meta.json
  logs/
    timemachine.log
```

说明：

- shadow git 与用户项目自身的 `.git` 历史隔离
- 自动恢复时，无效的 shadow repo 会保留为 `repo.git.invalid-<timestamp>-<uuid>`
- 旧的工作区内 `.pi/workspace-history/` 状态不会自动迁移
- 非活跃 session 按最近使用时间清理（LRU 风格）
- 进程租约会保护活跃 session 及其工作区。租约对应进程已不存在时通常按非活跃处理；PID 被复用的极少数情况下只会保守地多保留旧历史，不会导致活跃历史被删除
- 保留清理只删除元数据有效的非活跃目录；元数据损坏的目录会保留，便于人工恢复
- 在 `auto` 模式下，插件会在像用户 home 目录这样的宽泛目录里自动禁用，避免启动扫描过大导致卡顿
