# pi-workspace-history

[Chinese version / 中文版](./README.zh-CN.md)

Real workspace undo/redo for Pi.

Bring OpenCode style `/undo` to Pi, with the kind of workspace rollback safety that makes Claude Code feel trustworthy.

![workspace-history demo](./demo.gif)

## Why It Matters

- Undo the real workspace, not just chat history
- Roll back agent turns with confidence
- Restore branch-specific workspace state with `/tree`
- Protect manual edits with `/checkpoint`

## What It Is

`workspace-history` is a workspace history plugin for `@mariozechner/pi-coding-agent`.

It is not just an extra `/undo` command. The goal is to make chat history navigation restore the real workspace state as well, so the user can move backward, forward, or across branches in history without leaving files behind in the wrong state.

Its core goal is:

```text
When the user navigates to any node in the chat history tree,
both the chat context and the workspace file state should be restored
to the real state associated with that node.
```

In other words:

- `/tree` is the actual time machine
- `/undo` is a shortcut that moves one step backward through `/tree`
- `/redo` moves back to the location that was just undone

## Why It Exists

When using an agent for coding, these problems happen often:

- The agent breaks working code
- The agent deletes files by mistake
- The agent creates many useless files
- You want to go back to an earlier branch and try a different path
- You manually edit, create, or delete files between agent turns
- You do not want bad context to keep affecting later reasoning

This plugin does not try to solve simple text-editor undo. It is meant to restore the entire workspace together with chat history navigation.

Its value is:

- `/undo` can revert a whole agent turn instead of partially rolling back files
- `/tree` becomes real workspace history navigation, not just chat navigation
- You can move safely between historical branches
- Manual changes made between agent turns are preserved correctly
- Plugin state stays isolated from the user project Git history

## Requirements It Is Designed Around

This plugin is built around the following concrete requirements:

1. Record a `before` snapshot before each agent turn starts.
2. Record an `after` snapshot after each agent turn completes.
3. Restore the workspace when the user navigates with `/tree`, `/undo`, or `/redo`.
4. `/undo` must restore the real state from before that turn started, not just the previous post-agent state.
5. If the user manually deletes files, edits code, or creates files before the next prompt, those changes must be captured in the next `before` snapshot.
6. If the workspace contains unsnapshotted manual changes, the plugin should not silently overwrite them. It should block the switch and ask the user to create a `/checkpoint` first.
7. Internal plugin state must stay isolated from the user project's main Git history.
8. Multiple sessions must be isolated so snapshots and redo state do not leak across sessions.

## Main Features

- `/undo`
  - Restore the workspace to the state from before the most recent agent turn
  - Put the original user prompt back into the editor for retrying

- `/redo`
  - Restore the location that was just undone
  - Restore the corresponding workspace state at the same time

- `/checkpoint [label]`
  - Save the current workspace as a manual checkpoint
  - Protect manual changes before the next prompt is sent

- Workspace restore through `/tree`
  - Restores the matching workspace state when switching history nodes
  - Supports moving between historical branches

- Dirty guard
  - Blocks risky navigation when the workspace contains unsnapshotted manual changes
  - By default, the user is expected to run `/checkpoint` first

- Session isolation
  - Each session uses its own shadow git and redo state
  - Prevents a new session from undoing into an older session's history

## How It Works

The plugin stores snapshots in an internal shadow git repository instead of relying on the user's project `.git` history.

Default snapshot scope:

- Git tracked files
- Untracked files that are not ignored
- Paths matched by the workspace `.gitignore` are filtered out even if they were previously snapshotted

Default exclusions:

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

During restore, the plugin restores only the managed file set instead of doing a broad destructive cleanup of the entire workspace.

## Configuration

Configure via Pi settings:

- Global: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`

Example:

```json
{
  "workspaceHistory": {
    "storageDir": "D:\\pi-history",
    "maxSessionsPerWorkspace": 3,
    "maxWorkspaces": 10
  }
}
```

Settings:

- `workspaceHistory.storageDir`
  - External storage root for shadow history
  - Default: `~/.pi/agent/state/workspace-history`
- `workspaceHistory.maxSessionsPerWorkspace`
  - Keep only the most recently used sessions per workspace
  - Default: `3`
- `workspaceHistory.maxWorkspaces`
  - Keep only the most recently used workspaces globally
  - Default: `10`

## Installation And Usage

Install from a package source:

```bash
pi install npm:pi-workspace-history
```

After publishing this package to npm, users can install it directly with the command above.

Or install from a local checkout:

```bash
pi install /path/to/workspace-history
```

## Local Development

This repository is also configured for direct local extension loading while developing:

```text
.pi/extensions/workspace-history.ts
.pi/settings.json
```

Start `pi` in this directory, or run `/reload` to test local changes.

You can also place `workspace-history.ts` in:

- `~/.pi/agent/extensions/`
- `.pi/extensions/`

## Testing

Run automated tests:

```bash
npm test
```

Run type checking:

```bash
npm run typecheck
```

## Recent Changes

- History is stored outside the workspace by default
- Added `workspaceHistory.storageDir`
- Added retention limits for sessions and workspaces
- Reduced runtime overhead with cached settings/paths and throttled cleanup

## Storage Layout

The plugin stores history outside the workspace by default:

```text
~/.pi/agent/state/workspace-history/
  workspaces/
    <workspaceHash>/
      meta.json
      sessions/
        <sessionId>/
          repo.git/
          redo.json
          meta.json
  logs/
    timemachine.log
```

Notes:

- History is isolated from the user's project `.git` history
- Old workspace-local `.pi/workspace-history/` state is not migrated automatically
- Cleanup is LRU-style based on recent use
