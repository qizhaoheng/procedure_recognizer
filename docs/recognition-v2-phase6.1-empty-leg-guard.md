# Recognition V2 Phase 6.1：空航段 READY 漏洞修复

## 根因

BEKOL 的程序编码表位于扫描型 PDF 第 80 页。页面只有标题文字层，表格内容在像素中；分组把该页标为普通图页。本地扫描表恢复器虽然能识别网格，但曾错误要求表内必须存在 RF 航段，因此标准 CF/TF 表被整体丢弃。

同时，`PROCEDURE_LEGS_REQUIRED` 虽然由语义校验标为 `BLOCKING`，审核层却允许操作员确认这个无当前值的规则项，并把重新产生的同一问题标为 `HUMAN_RESOLVED`，最终造成零航段也能 READY。

## 修复

- `PROCEDURE_LEGS_REQUIRED` 变为不可人工豁免的结构规则；审核按钮不能确认，旧审核记录也不能在重新校验时消除它。
- 扫描表恢复器不再限定 RF，接受具备 Path Descriptor 与 Waypoint Identifier 的通用 424 编码表。
- 修复 `Waypoint Identifier` 的 OCR 拆词和 `I/l` 混淆，恢复 `HH311`。
- 恢复扫描表中的小数距离、RNP 1、尾置正号；OCR 明明检测到墨迹却读不出数值时生成 `[UNREADABLE]`，转成待人工修正项，不再静默当作空白。
- 上游阶段重跑后，旧 Phase 6 锁在查询时显示为 `STALE`，不能继续预检或发布；新的审核完成后必须重新锁定。

## BEKOL 真实结果

- P80 恢复 1 张表、8 个航段实体。
- 已恢复航段顺序：`HH301 → PORPA → HH311 → RAMEN → HH381 → HH382 → AGOMU → BEKOL`。
- `HH311` 坐标已从同页 Waypoint List 恢复为 `22 14 52.34N 114 05 12.73E`。
- 新审核队列已建立：24 张业务卡片（8 FIX、8 LEG、8 TOPOLOGY），共 107 个待确认字段。
- 必须人工修正的已知 OCR 项包括：首航段 `pathTerminator=CF`、RAMEN 航段 `distanceNm=5.2`、HH382 高度限制 `-8000`。
- 当前 Run 为 `REVIEW_REQUIRED`，旧发布锁为 `STALE`；尚未 dry-run，未正式发布。
