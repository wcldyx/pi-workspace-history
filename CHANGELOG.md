# Changelog

## 0.5.0 - 2026-10-08

### Added

- `/diff [n]` shows the files and lines changed by the latest agent operation that changed files, as a scrollable, colored diff in the TUI.
- `/history-status` shows whether workspace history is active (and why not), the storage path, operation and redo counts, skipped large files, and the last snapshot failure.
- The footer shows `⟲ history` while workspace history is active, and `⟲ history: snapshot failed` after a failed snapshot until the next operation is captured. Set `workspaceHistory.showStatus` to `false` to hide it.
- New files larger than `workspaceHistory.maxUntrackedFileSizeMB` (10 MB by default) are skipped and reported once. Undo and redo leave them alone. Files already in history are not affected.
- `llms.txt`, a plain-text summary for AI assistants.

### Changed

- Supports Pi 1.x. Development uses Pi 1.0.4, CI also tests Pi 0.84.4, and the release was also tested on Pi 1.1.0.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are declared as host-provided peer dependencies (`*`), as Pi's package documentation recommends.
- The package now ships a `LICENSE` file.
- Directories where workspace history is off because they have no project marker, are the home folder or a filesystem root, or are disabled in settings no longer show a warning when Pi starts or a prompt is sent. The footer has no `⟲ history`, `/history-status` explains why, and `/undo`, `/redo`, `/checkpoint`, and `/diff` say so when used. A folder of repositories, Jujutsu metadata without a workspace, and a `storageDir` inside the workspace are still reported once.

### Fixed

- Undo, redo, and `/tree` failed in workspaces with more than 20,000 files or 3,000 directories ("workspace scan exceeded"). Above the scan limits, excluded paths are now listed with Git.
- Undo, redo, and `/tree` re-read `.gitignore` for every file in the workspace before restoring. In a 20,000-file workspace on Windows, undo now takes about 1.4 s instead of 5.5 s, and about 1 s instead of 2 s at 5,000 files.
- On Windows, the first snapshot of a large workspace could exceed the 60-second Git timeout (about 85 s for 20,000 files). It now writes one pack instead of a loose object per file and takes about 5 s at that size.
- On Linux and macOS, undoing an agent's edit to an executable file (such as `gradlew` or a shell script) restored its contents but removed its executable bit. Files that are executable before a restore now stay executable.
- On Pi 1.x, `workspaceHistory` settings in `.pi/settings.json` were applied even when the user had not trusted the project folder. They now apply only to trusted folders, like Pi's own project settings.
- After every operation on the branch had been undone, `/undo` offered the last one again. With Pi 1.x, the system entry Pi records before a prompt was also linked to the operation that followed, so selecting it in `/tree` restored the files to after that operation. Existing history recorded this way is handled too.
- With diagnostic logging enabled (`PI_WORKSPACE_HISTORY_LOG=1`), a background task that ran after the session was replaced (`/new`, `/resume`, `/fork`) could crash Pi with an unhandled error. The idle baseline snapshot is now cancelled when a session shuts down.
- Starting Pi in the home folder warned that `workspaceHistory.storageDir must be outside the workspace`, because the default storage directory is inside the home folder. `/history-status` and the history commands now report the actual reason: history is off in the home folder.
- Shadow repositories are created without Git's template, so sample hooks are not copied and a user's `init.templateDir` does not apply. This also shortens the deepest paths under the storage directory on Windows.

## 0.4.8 - 2026-10-03

- Snapshots after file changes stage only the changed files instead of rescanning the whole workspace.

## 0.4.7 - 2026-10-03

- Prompts after the first are sent without waiting for the workspace snapshot. The agent's first tool call waits for it.

## 0.4.6 - 2026-10-02

- Each snapshot scans the workspace fewer times.

## 0.4.5 - 2026-10-02

- Inaccessible paths are skipped when probing for nested repositories (#14).

## 0.4.4 - 2026-09-30

- Snapshot commits no longer use Git signing (#13).

## 0.4.3 - 2026-09-17

- Git operations and nested repository snapshots are protected against concurrent writers.

## 0.4.2 - 2026-09-10

- Tree navigation skips the mode choice when the target files are identical.

## 0.4.1 - 2026-09-04

- Multi-repo container directories without a root repository are skipped (#9).

## 0.4.0 - 2026-09-03

- Jujutsu and colocated Git/Jujutsu repositories are supported (#8).

## 0.3.1 - 2026-09-02

- Active shadow repositories are protected from cleanup.

## 0.3.0 - 2026-09-01

- Complete multi-round agent operations form one undo/redo unit.
- Conversation-only history navigation keeps current files.
- History navigation resolves exact anchors; cleanup is conservative; Windows file locks are retried during restore.
