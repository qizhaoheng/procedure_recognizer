# Recognition V2 Phase 6：424 发布与回滚

## 目标

把 `APPROVED / READY` 从“可以考虑发布”变成一条不可跳步、可审计、可回滚的正式发布链路：

`READY 锁定 → 发布前预检 → 424 dry-run → 回读差异 → 人工接受 → 正式发布 → 可回滚`

## 安全边界

- 锁定同时记录源程序包哈希与 canonical 哈希，后续每一步重新核对。
- 预检或 dry-run 不修改 `group.procedureUnderstanding`，不影响地图和现有 424。
- dry-run 的每条记录必须严格为 132 列。
- dry-run 会被重新解析，并与锁定前的结构化航段逐程序、逐航段比较。
- 存在任何非 `MATCH` 航段时禁止接受差异；未人工接受时禁止正式发布。
- 正式发布生成不可覆盖的 release artifact，并把版本写入包级发布账本。
- 回滚不会删除发布文件，只切换当前生效 canonical；没有上一发布版时恢复首次发布前的数据。

## 持久化

- Run artifact：`publication-workspace.json`，保存锁、预检、dry-run、差异与当前状态。
- Run artifact：`release_<timestamp>_<id>.json`，保存正式 424 文本、canonical、发布前快照和哈希。
- Package artifact：`publication-ledger.json`，保存当前生效 release 与全部发布/回滚历史。
- `PUBLISH_CANONICAL` 仅在正式发布完成后进入 `COMPLETED`；dry-run 不伪装成发布完成。

## API

- `POST .../runs/:runId/publication/lock`
- `POST .../runs/:runId/publication/preflight`
- `POST .../runs/:runId/publication/dry-run`
- `POST .../runs/:runId/publication/diff`
- `POST .../runs/:runId/publication/diff/accept`
- `POST .../runs/:runId/publication/publish`
- `GET .../runs/:runId/publication/dry-run.txt`
- `POST .../publication/rollback`

## 当前验收结果

- Phase 6 专项测试覆盖 READY 锁定、源数据变化阻断、132 列 dry-run、424 往返零差异、人工接受门禁和 canonical 变化失效。
- 全量回归：198/198 通过。
- 前端生产构建通过，工作台新增“424 发布门禁”页签和六步操作区。

## 仍需真实人工验收

真实程序包必须先在 Phase 5.4 完成全部关键字段审核并进入 `APPROVED`。如果当前真实 Run 仍为 `REVIEW_REQUIRED`，Phase 6 会正确拒绝锁定；这不是功能失败，而是发布门禁在生效。
