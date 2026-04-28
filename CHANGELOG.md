# Changelog

## 0.1.0

- 实现 `workspace-history` Pi 扩展
- 支持 `before` / `after` / `baseline` / `manual checkpoint` 快照
- 支持 `/undo`、`/redo`、`/checkpoint`
- 支持基于 `/tree` 的工作区恢复
- 增加 dirty guard，阻止未快照手改被手动 `/tree` 覆盖
- 增加 Windows / `.gitignore` 兼容的快照收集逻辑
- 增加自动化集成测试
