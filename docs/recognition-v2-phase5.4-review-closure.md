# Recognition V2 Phase 5.4 — 发布审核闭环

## 目标

Phase 5.4 把 `REVIEW_REQUIRED` 从一个只读状态变成可操作、可审计的字段审核流程。它不直接发布 424，也不覆盖 V1；它只在独立 V2 Run 中产生 reviewed fusion、重新校验结果和 READY canonical 预览。

## 审核队列

审核队列同时读取：

- Fusion 的 `unresolvedItems`；
- 仍为 `OPEN` 的证据冲突；
- Semantic Validation 的开放 BLOCKING/WARNING；
- 各专项抽取的候选和 `SourceEvidence`。

相同 `entityKey + fieldName` 的信号合并成一个字段审核项。比如“坐标字段需要复核”“纬度越界”和由该坐标导致的“航段定位点缺少有效坐标”会回收到根坐标字段，不要求审核者重复处理下游症状。

## API

- `POST .../runs/:runId/review/initialize`：建立或恢复审核草稿；
- `GET .../runs/:runId/review`：读取草稿或最终审核结果；
- `PATCH .../runs/:runId/review/items/:reviewItemId`：确认或修正单个字段；
- `POST .../runs/:runId/review/complete`：应用决议并重新校验，仅 READY 时完成阶段。

更新接口使用 `expectedUpdatedAt` 做乐观并发检查，避免两个审核页面互相覆盖。

## Artifact

- `human-review-draft.json`：可恢复的审核草稿；
- `human-review-stage-attempt-N.json`：最终审核输出；
- `reviewed-fusion-attempt-N.json`：应用确认/修正后的融合结果；
- `reviewed-validation-attempt-N.json`：重新执行的确定性校验；
- `canonical-preview-reviewed-attempt-N.json`：READY 只读预览；
- `v1-v2-diff-reviewed-attempt-N.json`：审核后 V1/V2 差异。

每次字段决议记录审核人、时间、动作、原值/修正值和说明。原始 extraction、fusion 和 validation artifact 保持不变。

## READY 门禁

Run 只有同时满足以下条件才从 `REVIEW_REQUIRED` 进入 `APPROVED`：

1. 所有关键字段审核项均为 `CONFIRMED` 或 `CORRECTED`；
2. 修正值已应用到 reviewed fusion；
3. 全套确定性语义校验重新执行；
4. 没有开放 BLOCKING；
5. 没有开放 WARNING。

如果修正产生新的范围、引用、拓扑或几何问题，完成接口返回冲突并刷新审核队列。原始 PDF 证据缺失的字段不能直接确认。

## 安全边界

`APPROVED / READY` 仍不是正式发布。`PUBLISH_CANONICAL` 继续禁用，Phase 6 才允许把经审核的 canonical 数据接入现有地图、GeoJSON 和 424 发布基础设施。

## Phase 5.4.1 效率层

工作台在字段级审核项之上增加业务卡片，不改变底层门禁：

- `FIX/NAVAID`：同一实体的 identifier、原始坐标、纬度、经度和格式合并为坐标/导航台行；
- `LEG`：同一物理程序航段的序号、Path Terminator、端点、航向、距离、高度和特殊几何合并为航段行；
- `TOPOLOGY`：同一节点或边的校验项合并为拓扑关系；
- 身份冲突等高风险字段继续单字段显示。

整卡确认通过 `PATCH .../review/batch` 原子保存。任一字段不可确认时，整个批次不写入。字段修正仍使用单字段入口。

包级 `shared-review-decisions.json` 保存可复用决议。复用必须同时满足：

1. source package hash 完全一致；
2. entity、field 和当前/候选值完全一致；
3. PDF 文件、页码、bbox、原文/视觉描述和证据状态完全一致；
4. 原决议具有审核人和决定时间。

复用不会删除原始审核历史，目标 Run 会新增带 `reusedFromRunId` 的审计事件。首次真实航空数据确认仍不能由系统或模型代替。
