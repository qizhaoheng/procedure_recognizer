# Recognition V2 Phase 5.2：真实流水线 Golden 验收

## 目标

Phase 5.2 不再把 golden case 只当作静态 JSON 校验，而是为每个 case 创建独立的真实 V2 run，依次执行：

`PAGE_LAYOUT -> PROCEDURE_IDENTITY -> PROCEDURE_TABLE -> WAYPOINT_NAVAID -> NOTES_CONSTRAINTS -> CHART_TOPOLOGY -> EVIDENCE_FUSION -> SEMANTIC_VALIDATION`

每次运行都会保存 V2 原生阶段 artifact，并额外生成包含实际得分、阶段耗时、阶段指标、golden 差异和完整 424 阻断原因的 JSON/Markdown 报告。

## 运行方法

运行全部六例：

```powershell
npm run eval:phase5.2
```

只运行指定 case：

```powershell
npm run eval:phase5.2 -- vhhh-bekol1x-rf
```

报告默认保存在：

`server/data/recognition-v2/evaluations/phase5.2/<timestamp>/report.json`

同目录的 `report.md` 用于人工快速检查；`latest.json` 指向最近一次结果。原始 V2 run 与阶段 artifact 仍保存在对应任务的独立 `recognition-v2` 目录。

## 当前真实基线

2026-07-16 规则模式最终运行结果：

| 顺序 | Case | 类别 | 拓扑得分 | 拓扑结果 | 整包 424 发布 |
| ---: | --- | --- | ---: | --- | --- |
| 1 | `vhhh-bekol1x-rf` | RF | 1.000 | PASS | BLOCKED |
| 2 | `wsss-rnp02l-akoma-holding` | Holding | 1.000 | PASS | BLOCKED |
| 3 | `wsss-asuna2b-vector` | Vector | 1.000 | PASS | BLOCKED |
| 4 | `wsss-rnp02l-missed-approach` | Missed Approach | 1.000 | PASS | BLOCKED |
| 5 | `wmkj-adlov1g-dme-arc` | DME Arc | 1.000 | PASS | BLOCKED |
| 6 | `wmkj-four-star-merge` | 跨程序汇合 | 1.000 | PASS | BLOCKED |

“拓扑 PASS”只表示本 case 人工标注的节点、边、特殊几何和未知值策略全部匹配，不代表整个程序包已经能发布 424。当前六个 run 的完整语义校验仍为 `BLOCKED`，报告会继续列出缺失表格行、坐标、身份或其他非本 case 字段，防止把专项通过误写成系统完工。

## 本阶段新增的通用能力

- Windows 环境下，当 PDF 内嵌文字层只有页眉时，V2 可用本机 Windows Media OCR 读取栅格页；OCR 结果按图像指纹缓存，不写回 V1 `task.json`。
- FMC coding table 通过实际表格线和单词坐标恢复行列；缺失的 RF 距离单元格会单独复识别，单字符转向仍保留复核标记。
- 明确打印的 missed-approach 指令可生成 missed-approach 边；完整 holding 参数块可生成 HM/HOLD 边。
- Radar route 保持 `to=null + openEnded=true`，并优先使用图上带坐标的最后雷达航路锚点；与表格末端不一致时保留警告。
- DME Arc 说明中的入弧径向、中心台、半径、出弧径向和转向可构造 AF/ARC 边；多条程序共用同一出弧点时确定性生成 merge candidate。

所有栅格 OCR、文字规则和几何关联结果均为 `reviewRequired`，不因 golden 得分通过而自动发布。可用 `RECOGNITION_V2_LOCAL_OCR=0` 关闭本机 OCR 降级通道。

## 边界

这六例证明首批复杂拓扑链路已经打通，不代表对所有国家、所有出版社或所有航图版式达到生产准确率。后续重点应转向完整程序表格、坐标和身份字段的真实 case，把 `SEMANTIC_VALIDATION` 的整包发布决策从 `BLOCKED` 逐步降到 `REVIEW_REQUIRED/READY`。
