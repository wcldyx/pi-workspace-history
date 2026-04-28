# workspace-history

[English version](./README.md)

## 这是什么

`workspace-history` 是一个面向 `@mariozechner/pi-coding-agent` 的工作区历史插件。

它不是单纯给 `pi` 增加一个 `/undo` 命令，而是要让聊天历史和本地工作区文件状态一起回到过去、回到未来、或切换到任意历史分支节点。

它的核心目标是：

```text
当用户在历史聊天树中切换到任意节点时，
聊天上下文和工作区文件状态都应该同步恢复到那个节点对应的真实状态。
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

这个插件解决的不是“单步撤销文本编辑”，而是“把整个工作区和聊天状态一起时光穿梭”。

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
3. 当用户通过 `/tree`、`/undo`、`/redo` 切换历史节点时，工作区必须同步恢复。
4. `/undo` 恢复的应该是“这一轮开始前的真实状态”，而不是简单回到上一轮 Agent 完成后的状态。
5. 如果用户在两轮 Agent 之间手动删了文件、改了代码、建了新文件，这些变化在下一轮开始前应被记录进 `before snapshot`。
6. 如果当前工作区有还没有被快照保存的手动修改，插件不应该默默覆盖，而应该阻止切换，提示用户先 `/checkpoint`。
7. 插件自己的内部状态应该和用户项目主 Git 历史隔离，不能污染用户仓库。
8. 多个 session 之间的快照和 redo 状态应该相互隔离，不能串台。

## 主要功能

- `/undo`
  - 回到最近一轮 Agent 开始前的工作区状态
  - 把该轮用户 prompt 放回输入框，方便修改后重试

- `/redo`
  - 回到刚才 `/undo` 之前的位置
  - 同步恢复对应的工作区状态

- `/checkpoint [label]`
  - 保存当前工作区为一个手动检查点
  - 用于保护尚未发送新 prompt 的手动修改

- 基于 `/tree` 的工作区恢复
  - 切换历史节点时自动恢复对应的工作区状态
  - 支持在不同历史分支之间来回切换

- Dirty guard
  - 如果当前工作区有未快照的手动修改，会阻止危险切换
  - 默认要求先执行 `/checkpoint`

- Session isolation
  - 每个 session 使用独立的 shadow git 和 redo 状态
  - 避免新会话 `/undo` 时串到旧会话历史

## 工作方式

插件内部使用独立的 shadow git 来保存快照，而不是依赖用户项目本身的 `.git` 历史。

默认快照范围：

- Git tracked 文件
- 未被 ignore 的 untracked 文件

默认排除：

- `.git/`
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

恢复时，插件只恢复它纳管的文件集合，不会粗暴地对整个工作区做无差别清理。

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

运行自动化测试：

```bash
npm test
```

运行类型检查：

```bash
npm run typecheck
```

## 存储目录

插件会在工作区下创建内部状态目录：

```text
.pi/workspace-history/
  sessions/
    <sessionId>/
      repo.git/
      redo.json
  logs/
    timemachine.log
```

这个 shadow git 与用户项目自身的 `.git` 历史隔离。
