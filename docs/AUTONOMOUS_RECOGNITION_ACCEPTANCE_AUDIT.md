# AIP AD-2 自主识别任务 · 技术验收审计报告

- 审计日期：2026-07-14
- 审计方式：静态代码审查 + 真实样本运行（RKSI 15 文件 204 页 / RJTT 2 文件 7 页，真实模型调用，无 Mock）
- 审计范围：`apps/aip-procedure-agent/`（后端核心）、`server/src/services/jeppesen424/`（424 编译）、`src/views/agent/`（前端）、prompts、迁移脚本、自动化测试
- 本轮未修改任何代码

---

# 1. 总体结论

## 当前系统是否已经实现了真正的 AIP AD-2 自主识别？

**结论：部分达到预期。**

系统不是"固定流程包装"——分组、规划、识别三个环节都由真实模型调用驱动，产出内容随程序包变化，中间模型（PIR）真实存在并驱动 GeoJSON 与 424 的确定性编译。但它也没有达到"自主识别"：识别执行是**固定的单次模型调用**，计划不驱动执行；APPROACH 在 schema 层面断裂；424 编码锁死在单一 Jeppesen 方言上；语义校验层几乎为空，错误数据（负高度）静默通过并写进 424。

### 核心依据（5 条）

1. **分组是内容驱动的真 AI 输出**：RKSI 15 个 PDF、204 页，一次 `airport-package-grouper` 调用产出 42 个程序包，每包带页面角色、分组理由、置信度，118 个未分配页面均附原因（"Aerodrome Chart, general airport layout" 等）。证据：`server/data/aip-procedure-agent/691d90c2.../airport-package-analysis.json`。但分组只用文本摘要（不传图片），且**无任何确定性完整性校验**——模型自己的 decisionSummary 声称 45 个包（14 SID + 9 STAR + 20 IAP + 2 Visual），实际存储 42 个（13 SID + 7 STAR + 22 APPROACH），系统无感知。

2. **Recognition Plan 真实且随程序包变化，但不驱动执行**：三类程序的计划确实不同（SID 检出跑道过渡、STAR 检出三条进场汇聚于 SEL/LASIG 并点名 5 个等待应编 HA/HF、APPROACH 检出 missed approach 与 IAF/IF/FAF/SDF/MAPt）。但执行器 [orchestrator.ts:72-84](../apps/aip-procedure-agent/src/orchestrator.ts) 无论计划怎么写都只做**一次** `procedure-recognizer` 调用，计划仅作为上下文文本传入；计划中的 `BUILD_GEOJSON`、`VALIDATE_AGAINST_SOURCE_CHART` 等动作没有执行器，`requiredTools` 从不执行。实锤：STAR 计划点名 5 个等待程序，识别结果 26 条腿全部是 TF，等待完全丢失且无任何警告。

3. **APPROACH 全链路断裂**：分组能发现 22 个进近包、Planner 能输出 APPROACH 计划，但 `procedure-recognizer` 的 output-schema `procedure.category` 枚举只有 `["SID","STAR"]`，`normalizePir()`（[orchestrator.ts:91](../apps/aip-procedure-agent/src/orchestrator.ts)）把 APPROACH 强制改写为 STAR；真实运行 RNP RWY 15L 的结果：category=STAR、feeder 被标成 ENROUTE_TRANSITION、最后进近折进 COMMON_ROUTE、无 DA/MDA/OCA 表达、424 直接 INCOMPLETE（"无法从程序名 RNP RWY 15L 推导 6 位路线代码"）。

4. **424 是确定性编译 + 真实 Jeppesen 版式锁定，但只覆盖一种方言**：132 列定宽由 [simpleLegsTo424Text.ts](../server/src/services/jeppesen424/simpleLegsTo424Text.ts) 生成，列位实测自真实 WMKJ Jeppesen 静态文本并有黄金测试（[jeppesen424Export.test.ts](../server/src/services/__tests__/jeppesen424Export.test.ts)），生成后回读解析。但记录身份 `SSPAP …E`（客户区 SPA + 子节 E）**硬编码**，SID/STAR/APPROACH 全部输出同一记录形态——仓库内真实 RJTT Jeppesen SID 样本是 `SPACP …D`（[jeppesen424Compare.test.ts:45](../server/src/services/__tests__/jeppesen424Compare.test.ts)），可直接证明当前输出与真实数据身份列不符。Round-trip 只比对腿数（`reparsed.length === legs.length`），不比对字段值。

5. **语义校验层缺位，错误数据静默通过**：真实样本 EGOBA 2C 中，AIP 标注 "-5 000"（应为"至或低于 5000ft"）被识别为 `{type:"AT_OR_ABOVE", lowerFt:-5000}`，校验器（[compiler.ts:163-270](../apps/aip-procedure-agent/src/compiler.ts)）没有高度值域检查，负高度一路写进 424 记录成为非法编码 `+ -5000`；同时该程序 `confidence:1`。校验只有 9 条结构规则（fix 引用、序号重复、经纬度范围等），没有航向/距离反算、没有约束合理性、没有与参考 424 对比（前端"与 Jeppesen 424 对比"按钮是 disabled 占位）。

---

# 2. 当前真实架构和调用链

## 2.1 代码级真实流程（非理想架构）

```
POST /api/agent/tasks (multipart, ≤200 个 PDF)
  router.ts:50  创建 AgentTask{documents[]}，持久化 task.json（纯文件存储，无数据库）
  └─ autoAnalyze=true 时 → startTaskAnalysis()

【阶段 A：分析】orchestrator.analyzeAirportFiles()
  1. 逐文档 PdfDocumentTools.preprocess()          [pdfPreprocessor.ts:11]
     pdfjs-dist 提取原生文本 span(带bbox)+矢量操作符，@napi-rs/canvas 渲染 200DPI PNG + 55DPI 缩略图
     语言检测 / isScanned(原生文本<20字符) —— 无 OCR
  2. groupAirportPackages()                        [orchestrator.ts:48]
     ★模型调用 1：airport-package-grouper v1.0.0
     输入：taskName + 各文档 {pageNumber,title,summary(1800字符),languages,nativeTextQuality}
     ⚠ 不传任何页面图片
     输出 schema：packages[]{procedureKey,procedureCategory(SID/STAR/APPROACH),sources[]{documentId,pages,roles},
                  sharedSources,groupingConfidence,groupingReason} + unassignedPages[]{reason} + decisionSummary
  3. toBusinessPackage() 确定性转换 → BusinessProcedurePackage（含 packagePages 跨文档页引用）
  4. 落盘 airport-package-analysis.json / procedure-packages.json；stage=PACKAGES_READY，停下等人

【阶段 B：规划（每包，惰性）】orchestrator.planPackage()   [orchestrator.ts:59]
  ★模型调用 2：procedure-recognition-planner v1.0.0
  输入：机场 + 包元数据 + 包内页面(原生文本≤18000字符/页) + CHART 角色页图片(≤6张) + sharedAirportSources(按页标题正则匹配 COORDINATE|RUNWAY|NAVAID 的包外页)
  输出：RecognitionPlan{procedureType(SID/STAR/APPROACH), detectedStructure(6个布尔),
        recognitionPlan[]{action×8枚举,sourcePages}, geometryStrategy, arinc424Strategy,
        requiredTools, risks, missingInformation}
  落盘 packages/<id>/recognition-plan.json

【阶段 C：识别（每包）】orchestrator.recognizePackage()   [orchestrator.ts:72]
  ★模型调用 3：procedure-recognizer v2.0.0 —— 唯一一次识别调用
  输入：机场 + 包 + recognitionPlan(仅作上下文文本) + 全部包内页文本 + CHART|TABLE 角色页图片(≤6张)
  输出：ProcedurePIR 1.0.0（routes/fixes/legs/notes/sourceEvidence/conflicts/quality）
  ⚠ 计划中的动作序列没有对应执行器；requiredTools 不执行；无二次调用、无局部裁剪、无字段级重试

【阶段 D：确定性编译】全部纯代码，不再调模型      [compiler.ts]
  normalizePir() → validatePir()(9条结构规则) → compileGeoJson() → compile424Candidate()
  compile424Candidate → simpleLegsTo424Text()(132列) → parseJeppesen424Text() 回读 → 腿数比对
  落盘 procedures/<id>/pir-vN.json / geojson-vN.json / 424-vN.txt（版本递增，不覆盖）

【前端】src/views/agent/：任务列表 → 上传 → 程序包工作台(3s轮询,包编辑/合并/拆分/单包识别) → 结果页(MapLibre 地图 + legs + 424)
```

## 2.2 分阶段属性表

| 阶段 | 入口 | 调模型 | Prompt/Schema | 持久化 | 参与后续 | 失败处理 | 独立重试 |
|---|---|---|---|---|---|---|---|
| 上传/文档管理 | router.ts:50,95 | 否 | — | task.json + uploads/ | 是 | 400/409 | 可增删文档 |
| PDF 预处理 | pdfPreprocessor.ts:11 | 否 | — | pages PNG + task.pages | 是 | 单文档 FAILED 不阻断其余 | 重新分析全量重跑 |
| 程序包分组 | orchestrator.ts:48 | ★ | airport-package-grouper 1.0.0 | airport-package-analysis.json | 是（构建包） | 任务 FAILED | `/tasks/:id/packages/reanalyze` |
| 识别规划 | orchestrator.ts:59 | ★ | procedure-recognition-planner 1.0.0 | recognition-plan.json | **仅作为识别调用的上下文文本** | 包 FAILED | `/packages/:id/plan` |
| 程序识别 | orchestrator.ts:72 | ★ | procedure-recognizer 2.0.0 | pir-vN.json | 是 | 包 FAILED + validations 记录，批量模式隔离 | `/packages/:id/recognize` |
| PIR 校验 | compiler.ts:163 | 否 | — | 存 procedure.validations | 仅展示，不阻断 424/GeoJSON | — | 编辑字段后自动重校 |
| GeoJSON 编译 | compiler.ts:9 | 否 | — | geojson-vN.json | 前端地图 | 缺坐标→null geometry+UNRESOLVED | `/procedures/:id/compile-geojson` |
| 424 编译 | compiler.ts:287 | 否 | — | 424-vN.txt | 前端展示/导出 | 缺字段→424_INCOMPLETE+missingFields | `/procedures/:id/compile-424` |
| 崩溃恢复 | storage.ts:48（服务启动时） | 否 | — | 中断包置 FAILED+中文警告 | — | — | 重新识别时清除警告 |

**持久化说明**：实际持久化 100% 是文件系统（`server/data/aip-procedure-agent/<taskId>/`，原子写 + Windows 重命名重试 + 每文件串行队列）。`migrations/001、002_*.sql` 两个 PostgreSQL 迁移脚本**在代码中零引用，是死代码**（grep 无任何 import/执行点），"数据库记录"验收项按文件产物替代评估。

**预算**：`AGENT_MAX_MODEL_CALLS=80`、每次 ≤6 图；本轮 RKSI 全任务共消耗 9 次模型调用（1 分组 + 4×规划/识别）。

---

# 3. 四项核心能力验收矩阵

| 核心能力 | 检查项 | 状态 | 代码证据 | 运行证据 | 主要问题 | 严重度 |
|---|---|---|---|---|---|---|
| 一 分组 | 多文件同机场上下文 | PASS | orchestrator.ts:27-46 全文档页合并后一次分组 | RKSI 15 文件一次分组 42 包 | — | — |
| 一 分组 | task/document/page/package 关联 | PASS | domain.ts:14-19 PackagePageRef{documentId,pageNumber,pageRole,isShared} | packagePages 真实落盘 | — | — |
| 一 分组 | 跨文件页面引用 | PARTIAL | schema 允许 sources[] 多 documentId | RKSI/RJTT 样本中 0 个跨文件包（样本本身单图单文件） | 能力存在但无正样本验证 | P2 |
| 一 分组 | 页面被多包共享 | PASS | RJTT: GODIN 2A/2K/1C 三包共享 doc 页 1 | task.json 可见 | isShared 标志未被模型使用（全 false） | P3 |
| 一 分组 | 内容驱动（非文件名/连续页码） | PARTIAL | 输入只有 title/summary 文本；无文件名规则、无连续页码规则 | 42 包 groupingReason 均引用图表标题/表格 | **不传图片**：扫描页(原生文本<20字符)对分组不可见；无 OCR | P1 |
| 一 分组 | 完整性校验 | FAIL | 代码中无任何分组后确定性校验 | decisionSummary 自述 45 包 vs 实存 42 包，无人报警 | 无目录比对、无重复检测、无遗漏检测 | P1 |
| 一 分组 | 未分配页面+理由 | PASS | schema 强制 unassignedPages{reason} | 118 页均有理由 | — | — |
| 二 规划 | Planner 独立存在且每包执行 | PASS | orchestrator.ts:59-64；recognizePackage 无计划时先规划 | 4 个包 4 份不同 plan 落盘 | — | — |
| 二 规划 | 计划随程序类型/结构变化 | PASS | — | SID/STAR/APPROACH 的 detectedStructure、strategy、风险各不相同且引用真实 fix 名 | — | — |
| 二 规划 | **计划驱动执行** | SURFACE_ONLY | orchestrator.ts:79 计划仅作 prompt 上下文；无步骤执行器 | STAR 计划点名 5 个等待→结果 0 个等待腿、无警告 | 动作/工具/校验计划均无执行语义 | **P0** |
| 二 规划 | AI 可追加步骤/看新页/局部裁剪/字段重试 | FAIL | 无任何工具调用循环（旧 inspector 工具链已删）；cropPage 等工具存在但无人调用 | — | 单次调用定终身 | **P0** |
| 二 识别 | SID 必须要素 | PARTIAL | PIR 支持跑道过渡/公共段/离场过渡/约束/转弯 | EGOBA 2C：5 route、DER 标 UNRESOLVED | 无导航规范级差异化字段清单 | P2 |
| 二 识别 | STAR 必须要素 | PARTIAL | 同上 | OLMEN 3C：3 过渡+公共段、18 速度限制 | **等待程序无模型字段**（PirLeg 无 holding 表达） | P1 |
| 二 识别 | APPROACH 必须要素 | FAIL | recognizer schema category=["SID","STAR"]；normalizePir 强转 STAR；PIR 无 DA/MDA/OCA/OCH 字段 | RNP RWY 15L：category=STAR、feeder→ENROUTE_TRANSITION、final→COMMON_ROUTE | 全链路断裂 | **P0** |
| 二 识别 | 缺失标记不编造 | PARTIAL | fix 坐标缺失→UNRESOLVED+null（EGOBA DER 实证）；llmClient 无 mock 兜底（抛错） | 但 "-5 000" 被解释成负高度静默通过；confidence=1 | 语义级编造无防线 | **P0** |
| 二 识别 | 冲突保留多候选 | NOT_VERIFIED | schema 有 conflicts[]（自由对象） | 所有真实样本 conflicts=0 | 无冲突正样本，无法证实行为 | P2 |
| 三 数据 | PIR 独立语义模型 | PASS | domain.ts:22-28，GeoJSON/424 均由 PIR 编译 | 4 份真实 PIR 落盘 | 缺 holding/minima/跑道实体 | P1 |
| 三 数据 | 版本化/人工编辑 | PARTIAL | 识别结果版本递增不覆盖；PATCH fields 标 MANUALLY_EDITED | rerun 生成 v2 | **重跑不合并人工修改**（新版本从零识别） | P2 |
| 三 数据 | 424 确定性编译+定宽 | PASS | simpleLegsTo424Text.ts 132 列，模型不产 424 文本 | 真实输出全部行=132 列 | — | — |
| 三 数据 | 424 记录身份/RouteType | FAIL | :129-134 硬编码 'SSPAP'+子节'E'+路线型'2/3' | RKSI SID 输出 …E（真实 RJTT SID 应 …D）；STAR 过渡名取汇合点 LASIG 而非 GUKDO | 单方言、无 PD/PE/PF 区分、无进近路由类型 | **P0** |
| 三 数据 | 424 Round-trip | PARTIAL | compiler.ts:344-355 生成→回读 | roundTrip 26/26 matched | 只比对**腿数**，不比字段值 | P1 |
| 三 数据 | 与参考 424 对比 | SURFACE_ONLY | simpleProcedureComparator 存在但 agent 零引用；前端按钮 disabled"待导入数据" | — | 对比能力在旧管线，未接入 | P1 |
| 三 数据 | 完整性边界表达 | PASS | 424_CANDIDATE/424_INCOMPLETE+missingFields；从不自称正式生产数据 | RNP RWY 15L 正确报 INCOMPLETE | 缺 424_DERIVED 使用场景 | P3 |
| 三 数据 | 校验体系 | PARTIAL | validatePir 9 条结构规则 | 负高度、缺等待均 0 告警 | 无语义/几何/反算校验 | **P0** |
| 三 数据 | 可追溯性 | PARTIAL | evidence ID 链 + model-calls 原始响应落盘 + promptVersion | 14 条 sourceEvidence | bbox 全是 [0,0,1,1] 整页；imageCropPath 恒 null | P2 |
| 四 几何 | Fix Point / [lon,lat] / WGS84 | PASS | compiler.ts:13-26 | 真实 GeoJSON 核验通过 | 球体近似(R=3440.065NM)非椭球 | P3 |
| 四 几何 | RF/AF 圆弧 | PARTIAL | compiler.ts:94-109 arc() 圆心+方位扫描采样(≤5°步长)，左右转影响扫掠方向 | **真实样本未触发**（无 RF/AF 正样本）；单测 4 断言 | 无半径一致性校验、无跨180°处理、AF 无 DME 半径语义 | P1 |
| 四 几何 | Holding HA/HF/HM | FAIL | 无任何实现 | RNP RWY 15L 的 HM→直线 DISPLAY_ONLY | 跑马场几何完全缺失 | P1 |
| 四 几何 | 航向腿 VA/VM/CA/CI | PARTIAL | compiler.ts:123-135 起点+course 画 5NM 显示线，标 DISPLAY_ONLY | — | 无高度终止点推算 | P2 |
| 四 几何 | 跑道表现 | FAIL | GeoJSON 无任何 RUNWAY 要素 | 真实输出 featureType 仅 FIX/LEG/ROUTE | SID 起点=DER 无坐标→首腿 null | **P0**(并入#1) |
| 四 几何 | 标注/属性完备性 | FAIL | LEG properties 无 course/distance/altitude/speed/名称 | 真实 leg properties 仅 8 个键 | 无 labelPlan（旧管线有，未复用） | P1 |
| 四 几何 | 原图叠加反向校验 | FAIL | 无实现；前端"原图叠加"按钮 disabled | — | — | P1 |
| 前端 | 业务信息为主 | PASS | 工作台以文件/分组/状态/地图/424 为主；Prompt版本/模型调用列表已不在主页面 | — | 校验结果与 unresolvedFields **未展示**（quality 徽章缺失） | P2 |

---

# 4. 程序包分组审计（核心能力一）

**判定：基本实现（PARTIAL）**

## 是否内容驱动

**是，但仅文本驱动。** [orchestrator.ts:48-51](../apps/aip-procedure-agent/src/orchestrator.ts)：分组输入是全部文档的 `{pageNumber, title, summary(前1800字符), languages, nativeTextQuality}`，`images: []`——**没有任何页面图片**。42 个包的 groupingReason 全部引用内容（"Chart and waypoint table define GUKDO 1A and KARBU 1A arrivals"）。代码中不存在文件名正则、连续页码、固定页数、国家模板等规则分组路径（旧 inspector/planner 工具链已删除）。

后果：纯扫描页（`isScanned = nativeText<20字符`，[pdfPreprocessor.ts:23](../apps/aip-procedure-agent/src/pdfPreprocessor.ts)）对分组器完全不可见。RKSI/RJTT 样本恰好是原生文本 PDF 所以表现良好；对扫描件 AIP（大量东南亚/非洲机场）分组将失明。此前 5 机场样本试验中 RKSI/RJTT 曾被"乱码"挡住，正是该盲区。

## 是否支持跨文件

**模型可以，样本未证。** Schema 的 `sources[]` 每项带独立 documentId，允许跨文件；`sharedSources` 允许共享页。但两个真实任务中跨文件包为 0（RKSI 每个程序图恰好独立成文件），`isShared` 全部为 false。RJTT 中 doc 页 1 被 GODIN 2A/2K/1C 三个包同时引用，证明**同文档页面复用**成立。跨文件复用（如坐标总表在文件 A、程序图在文件 B）状态：**NOT_VERIFIED，需构造样本**。

## 是否完整

**无保障。** 实测：模型 decisionSummary 自称 45 包（14+9+20+2），实存 42 包（13 SID+7 STAR+22 APPROACH）——2 个 Visual Approach 被声明但未入列，SID/STAR 计数不符，系统零告警。代码中不存在：程序目录（PROCEDURE_INDEX 角色页）与分组结果比对、重复分组检测、高价值页面未引用检测。页面账目本身是平的（86 引用 + 118 未分配 = 204 页），但那是模型自觉，不是系统校验。

## 是否可追溯

**基本可以。** airport-package-analysis.json 原样落盘；每包 groupingReason + groupingConfidence；unassignedPages 118 条每条有 reason；模型原始响应存 model-calls/<callId>.json；promptVersion 记录在 ModelCall。

## 伪实现检查

- ❌不存在"按文件名/连续页码分组"（伪实现 #5、#6 排除）；
- ❌不存在"程序包只是名称列表"（#4 排除，packagePages 有真实页面关系）；
- ⚠ `toBusinessPackage`（orchestrator.ts:53-57）用**正则匹配角色字符串**把 packagePages 折算回旧版 `sources` 分类（/CHART/i、/COORDINATE/i…），角色拼写不在枚举内时会静默丢类——工程瑕疵非伪实现。

---

# 5. 自适应程序识别审计（核心能力二）

**判定：部分实现（规划真实，执行固定；PARTIAL 偏 SURFACE）**

## Planner 是否真实

**真实。** 每包一次独立模型调用（[orchestrator.ts:59-64](../apps/aip-procedure-agent/src/orchestrator.ts)），输入含包内页图（CHART 角色，≤6 张）、原生文本（≤18000 字符/页）、包元数据、`sharedAirportSources`（按页标题正则挑出的包外坐标/跑道/导航台页）。输出结构齐全（detectedStructure/动作序列/几何与 424 策略/风险/缺失信息）。

未包含的输入（验收清单要求 vs 实际）：表格结构化数据（detectedTables 恒为空数组，从未提取）、页面角色候选置信度、"当前已知/缺失信息"上下文（首次规划无历史）。

## 计划是否驱动执行 —— **不驱动（本能力的核心缺陷）**

- 计划传给 recognizer 仅作为 user prompt 中的一段 JSON 文本（orchestrator.ts:79），**语义上是"提示"而非"程序"**；
- 8 种动作没有任何执行器映射：`BUILD_GEOJSON`/`BUILD_ARINC_424_CANDIDATE` 实际由固定确定性编译完成（与计划无关），`VALIDATE_AGAINST_SOURCE_CHART` **没有任何对应实现**；
- `requiredTools`（"Chart Reader"、"Geometry Builder"…）是自由字符串，无工具注册表，从不执行；
- 无二次模型调用、无局部裁剪（`PdfDocumentTools.cropPage` 存在但零调用方）、无字段级重试（重试=整包重跑）；
- **运行实锤**：STAR OLMEN 3C 计划的 arinc424Strategy 明确写"Encode holding procedures at BOPKI, SANLA, NODUN, UPSOM, ANPEM using HA/HF descriptors"，最终 PIR 26 条腿全为 TF、0 条等待、0 条告警、confidence=1。计划知道的事，执行层既做不到也不知道自己没做到。

按验收标准：recognitionPlan 影响力=prompt 上下文 > 纯展示，因此判 PARTIAL 而非 SURFACE_ONLY，但距"按计划识别"相差一个执行引擎。

## 是否因程序类型/表现方式变化

计划层：是（三类程序 detectedStructure 与策略实质不同，且引用了各包真实 fix 名，排除伪实现 #1/#2 "固定模板/全同步骤"——两个 SID 包的动作顺序也不同）。
执行层：否（同一 recognizer prompt、同一次调用、同一 PIR schema 处理一切）。

## 必须要素覆盖

- SID：跑道过渡/公共段/离场过渡/约束/转弯/导航规范 —— PIR 可表达且真实样本产出 ✔；DER 无坐标正确标 UNRESOLVED ✔。
- STAR：过渡/公共段/约束 ✔；**等待程序不可表达**（PirLeg 无 holdingAtFix/腿时间/入航道次数等字段）✘；与进近衔接无表达 ✘。
- APPROACH：**schema 层不存在**。`procedure.category` 枚举 `["SID","STAR"]`（output-schema.json），system.md 开头"You recognize exactly one SID or STAR package"；PIR 无 IAF/FAF 角色字段（本次模型自发把角色写进 `fix.type`："IAF"/"IF"/"SDF"/"FAF"/"MAPt"/"MAHF"——这是模型越出 schema 期望的自由字符串，不是设计），无 VPA 专用语义（verticalAngle 捕到 -3.05 属幸运）、无 DA/MDA/OCA/OCH、无 Final/Missed 的 424 路由类型。

## 缺失和冲突处理

- UNRESOLVED：✔ 实证（EGOBA DER fix null 坐标 + unresolvedFields 列表 + reviewRequired=true）；
- DERIVED/AI_INFERRED：枚举存在，真实样本未出现（NOT_VERIFIED）；
- 冲突多候选：conflicts[] 是自由对象数组，无 schema 约束选值理由，真实样本恒空（NOT_VERIFIED）；
- bbox：sourceEvidence.bbox 全部是 `[0,0,1,1]` 整页占位，imageCropPath 恒 null —— **字段级定位证据未实现**；
- 静默编造：坐标层有防线（null+UNRESOLVED）；**语义层无防线**（负高度实证）；模型失败时抛错、无静态数据兜底（llmClient.ts:76-88，排除伪实现 #16）。

---

# 6. PIR、GeoJSON 和 424 审计（核心能力三）

## 6.1 PIR

**已实现**：独立语义模型（[domain.ts:22-28](../apps/aip-procedure-agent/src/domain.ts)）：Airport/Procedure/Route(6 类 routeType)/Fix(8 类坐标来源)/Leg(PT/course/distance/turn/alt/speed/verticalAngle/openEnded)/证据/字段状态(6 态)/置信度/校验结果。GeoJSON 与 424 都由它编译（单一事实源，排除伪实现 #14）；版本递增不覆盖历史。

**缺失**：Holding；进近角色（IAF/IF/FAF/MAPt/MAHF 作为一等字段）；DA/MDA/OCA/OCH/minima；跑道实体（DER/跑道端坐标、离/着陆端）；导航台记录（recommendedNavaidId 指向普通 fix）；程序间衔接（STAR→APPROACH）。

**错误设计**：`procedure.category` 只有 SID/STAR 而包分类有三值——同一体系内两个枚举失配，靠 `normalizePir` 强转掩盖。

**数据风险**：quality.confidence 由模型自评（真实样本清一色 0.98~1.0），与校验结果不挂钩；fieldStatus 稀疏（EGOBA 的 leg 只标了 1 个字段）。

## 6.2 ARINC 424 Candidate

**已实现**：确定性编译器（模型零参与 424 文本，排除伪实现 #11）；132 列定宽全行验证（实测输出 `lines lens: [132]`）；主记录+2P 续行；序号 3 位补零；缺跑道/缺 toFix → 424_INCOMPLETE + missingFields（不硬编）；生成后回读解析（排除 #13 的"完全没有 Round-trip"）；黄金测试用**真实 Jeppesen WMKJ 静态文本**逐列锁定版式；`procedureNameForRoute`+`deriveRouteCode` 解决联合图表命名（RKSI BINI3C/OSPO2C 测试实证）。

**缺失/错误**（按验收 6.2 逐项）：

| 项 | 状态 | 证据 |
|---|---|---|
| 记录身份（客户区/子节） | **FAIL** | `put(chars,0,'SSPAP')`、`put(chars,12,'E')` 硬编码（simpleLegsTo424Text.ts:129,132）。真实 RJTT SID 参考行是 `SPACP RJTTRJD…`。SID/STAR/APPROACH 输出同一身份 |
| Route Type | FAIL | 恒 '2'（有跑道）或 '3'（有过渡名）；无进近路由类型（A/I/R…），无 SID/STAR 路由类型语义区分 |
| Transition Identifier | FAIL | `normalizeTransitionName(route.transitionFix ?? identifier)` 取的是**汇合点**：STAR GUKDO 3C 输出 `3LASIG`（应为过渡起点 GUKDO）；SID BINIL 3C 输出 `3CG100` |
| Course/theta/rho | PARTIAL | 磁航向只在 AF/CA/CF/CI/CR 编码（:73），TF 恒空；无推荐导航台 theta/rho |
| Altitude | **FAIL（值域）** | 符号+5 位编码正确，但负值不拦截 → 实际输出 `+ -5000`（EGOBA 记录 001 实测），Round-trip 也不报 |
| Speed | FAIL | SimpleProcedureLeg 有 speedLimitKias 字段但 primaryRecord **从不写入**（列缺失）；STAR 样本 18 个速度限制全部丢失 |
| Round-trip 深度 | PARTIAL | 只比 `parsedLegs.length === emittedLegs.length`（compiler.ts:350-353），字段值不比对 |
| 与参考 424 对比 | SURFACE_ONLY | comparator + ROUTE_CODE 对齐机制在旧管线且有测试，agent 结果无入口（前端按钮 disabled） |
| 完整性边界 | PASS | 状态机 424_CANDIDATE/INCOMPLETE 诚实，README 亦声明 MVP 边界 |

**结论**：这是"以单一 Jeppesen SID/STAR 方言为模板的候选生成器"，不是可覆盖三类程序的 424 编码器。未达专业生产要求，但边界表达诚实（未自称生产数据）。

## 6.3 GeoJSON

**已实现**：由 PIR 编译；合法 FeatureCollection；[lon,lat]；WGS84（球体近似）；Fix→Point（含 identifier/confidence/status/evidence）；每 Leg 独立 Feature；Route 聚合 Feature（去重相邻点，公共段不重复）；geometryQuality 四级（EXACT/DERIVED/DISPLAY_ONLY/UNRESOLVED）；**缺坐标输出 null geometry 而非假坐标**（EGOBA 两条 DER 腿实证，排除伪实现 #7）。

**缺失**：LEG properties 无 course/distance/altitudeConstraint/speedConstraint/turnDirection/fix 名（实测仅 8 个键）；无程序名/跑道名于要素级（仅 metadata）；无跑道要素；无标注要素（labelPlan 机制在旧管线 procedureUnderstandingGeojson.ts:1577，agent 零复用）；无起点/终点语义标记。

## 6.4 校验体系

现有 9 条（compiler.ts:163-270）：route 非空、route 有腿、序号重复、course∈[0,360)、distance∈(0,500]、alt 上下界次序、from/to fix 存在、纬度、经度。
**缺失全部语义/几何校验**：高度值域（放过 -5000）、速度值域、航向与坐标反算偏差、距离反算偏差、RF 半径一致性（起/终点到圆心距离差）、转弯方向与几何一致、Route-Transition 连接点闭合、程序完整性（对照计划的 detectedStructure：计划说有 5 个等待而 PIR 无等待应告警）、424 字段值 Round-trip、与参考 424 diff。校验不只是"JSON 能解析"（排除伪实现 #19），但深度不足以支撑专业数据。

## 6.5 分项判定

| 项 | 判定 |
|---|---|
| PIR | PARTIAL（SID/STAR 真实可用；APPROACH/Holding/minima/跑道缺失） |
| GeoJSON | PARTIAL（诚实、结构正确；属性与专业要素不足） |
| 424 Candidate | PARTIAL 偏 FAIL（确定性+版式锁定真实；单方言身份硬编码+速度丢失+过渡名错误） |
| 校验体系 | FAIL（仅结构层，语义层空白，错误数据静默通过） |
| 可追溯性 | PARTIAL（证据链/版本/原始响应齐；bbox 整页占位无字段级定位） |

---

# 7. GeoJSON 几何表现审计（核心能力四）

| 对象/腿型 | 当前表现 | 算法（代码位置） | 专业合理？ | 测试 | 缺失项 |
|---|---|---|---|---|---|
| Fix | Point + 状态/证据属性 | compiler.ts:13-26 | 基本合理 | core.test.ts | 无类型符号区分（VOR/NDB/WPT 渲染语义） |
| 跑道 | **无任何要素** | — | 否 | 无 | 中心线/跑道端/DER/编号全部缺失；SID 首腿因 DER 无坐标变 null geometry |
| IF | 与前点直线，EXACT | compiler.ts:110-122 | IF 本质是定位点，作直线可接受 | 间接 | — |
| TF | 大圆直线，EXACT | 同上 + geodesicForward/Inverse（coordinate.ts:31-45，球体 R=3440.065NM） | 合理（显示级） | ✔ round-trip 单测 | 椭球误差 ~0.3%（P3） |
| CF | 直线 from→to，EXACT | 同上 | 近似可接受；未用 course 验证/构造 | 无专测 | 航向与连线夹角校验 |
| DF | 直线，EXACT | 同上 | **偏宽松**：DF 含转弯段，直线标 EXACT 高估质量 | 无 | 转弯圆滑过渡 |
| RF | 圆心+起止方位角扫掠采样（≤5°/段，≥8 段），L/R 决定扫掠符号 | compiler.ts:94-109, arc():142-161 | 算法方向正确 | ✔ 4 断言（端点重合/采样数） | 无半径一致性校验（radiusNm 字段完全未使用！）、无跨180°、无>180°弧专测、**无真实样本触发** |
| AF | 复用 RF 的 arc()（圆心=centerFix） | 同上 | 部分：AF 语义是导航台 DME 弧（rho + 边界径向），当前把 centerFix 当圆心可用但 recommendedNavaid/rho 未参与 | 无专测 | DME 半径、边界径向裁剪 |
| VA/CA | 起点+course 画 5NM 显示线，DISPLAY_ONLY | compiler.ts:123-135 | 诚实标注，几何粗糙 | 无 | 按爬升梯度+目标高度推算长度 |
| VI/CI/VM/FM | 同上（有 from+course 时）否则 null | 同上 | 同上 | 无 | 拦截点推算 |
| HA/HF/HM | **无实现**：有坐标→直线 DISPLAY_ONLY，无→null | （落入通用分支） | **否** | 无 | 跑马场（入航道、两条平行直线+两个半圆、左/右程序、腿长/时间） |
| 转弯方向 | 仅 RF/AF 扫掠方向使用；直线腿忽略 | arc() | 部分 | RF 单测含 R | 直线腿转弯圆角、方向与图一致性校验 |
| Route/Transition | 每 route 一条聚合 LineString + routeType 属性；类型枚举含 6 类 | compiler.ts:52-69 | 结构正确，可按属性分层显隐 | 无 | 前端未做分层显隐/线型区分；Missed Approach 属性已分离(实证 RNP 15L)但样式相同 |
| 标注 | 无标注要素；properties 缺约束/名称 | — | 否 | — | labelPlan 类机制（旧管线已有范式） |
| 起点/终点/顺序 | sequence 属性存在；无起终点标记 | — | 部分 | — | — |
| 原图叠加反向校验 | **无实现**（前端按钮 disabled 占位） | — | 否 | — | 见 §10 方案 F |

**分项判定**：跑道 FAIL；Fix PASS；直线腿 PASS；转弯腿 PARTIAL；圆弧腿 PARTIAL（算法真实但字段未闭环、无实样验证）；Holding FAIL；Transition 结构 PASS/表现 PARTIAL；程序标注 FAIL；反向校验 FAIL。

**明确结论（对应伪实现 #8/#9）**：并非"所有腿都直线"——RF/AF 圆弧算法真实存在且方向语义正确；但 radiusNm 完全未参与计算与校验，等待全部直线化，本次真实样本中圆弧代码路径 0 次触发（RKSI 所选样本无 RF/AF 腿），**圆弧能力状态实为 NOT_VERIFIED-in-production**。

---

# 8. 真实样本运行结果

全部为本日真实模型调用（qwen 系 provider，9 次调用），产物在 `server/data/aip-procedure-agent/691d90c2-…/` 与 `1c4ed387-…/`。无 Mock。

## 样本 1：SID RNAV BINIL 3C / BOPTA 3C（RKSI，联合图表，含跑道+公共段+双离场过渡）

- 分组：File_(2-28) SID.pdf 2 页（PROCEDURE_CHART + WAYPOINT_COORDINATE_TABLE），confidence 1
- Plan：8 动作，检出 runway/common/enroute 结构；策略点名 CG050/CG100
- PIR：5 routes / 11 legs（CF+TF）/ 12 fixes（EXPLICIT_TABLE），DER-15L/15R 无坐标→UNRESOLVED+reviewRequired
- GeoJSON：28 features，11 EXACT + 2 UNRESOLVED（null geometry，诚实）
- 424：424_CANDIDATE，26 行×132 列，Round-trip 13/13；联合名正确拆出 BINI3C/BOPT3C ✔
- 问题：高度 "-5 000" → `+ -5000` 非法编码；过渡名 3CG100 存疑；速度列缺失

## 样本 2：SID RNAV EGOBA 2C / OSPOT 2C（RKSI，拼写体名称）

- 拼写体 "TWO CHARLIE" 经 deriveRouteCode 对齐 EGOB2C/OSPO2C ✔（该修复有回归测试）
- 磁盘 424-v1.txt 是修复前的 INCOMPLETE 旧产物，task.json 内为重编译后的 CANDIDATE——**产物文件与最新状态可能不同步**（P2）

## 样本 3：STAR RNAV OLMEN/GUKDO/KARBU 3C（RKSI，4 页，三过渡汇聚+5 个等待）★含 Transition 样本

- Plan：正确检出三过渡汇聚 SEL/LASIG，**明确要求 HA/HF 编码 5 个等待（BOPKI/SANLA/NODUN/UPSOM/ANPEM）**
- PIR：4 routes（3 ENROUTE_TRANSITION + 1 COMMON_ROUTE）/ 26 legs 全 TF / 26 fixes / 18 速度+16 高度约束
- **等待全部丢失，0 告警，confidence=1，validations=none** ← 计划不驱动执行的最直接运行证据
- 424：CANDIDATE，Round-trip 26/26；但速度约束 18 条全部未编码；过渡名 GUKD3C→`3LASIG`（错，应 GUKDO）
- GeoJSON：56 features 全 EXACT 直线

## 样本 4：APPROACH RNP RWY 15L（RKSI，2 页）★进近样本

- Plan：procedureType=APPROACH，检出 missed approach、双 feeder（MUNAN/BITIM）、IAF/IF/FAF/SDF/MAPt 齐全——规划层没问题
- PIR：**category=STAR**（schema 强转）；feeder→ENROUTE_TRANSITION；final→COMMON_ROUTE（FINAL_APPROACH 枚举未被使用）；MISSED_APPROACH 正确分离（2 腿含 HM）；fix.type 自由字符串带出 IAF/IF/SDF/FAF/MAPt/MAHF；verticalAngle -3.05 捕获；**无 DA/MDA/OCA**
- 424：**424_INCOMPLETE**（"无法从程序名 RNP RWY 15L 推导 6 位路线代码"）——进近在编码器无路可走
- GeoJSON：10 EXACT + 2 DISPLAY_ONLY（HM 等待=直线）
- 包状态 COMPLETED、confidence=1、validations=none——**"已完成"掩盖三处实质缺陷**（伪实现 #15 在进近场景成立）

## 样本 5：STAR AKSEL 2B（RJTT，2 文件任务，页面复用）★多页/共享页样本

- 2 文件 7 页，5 个 STAR 包，doc-71 页 1 被 3 个包共享引用 ✔
- 424：CANDIDATE（RWY22 归一化 RW22 ✔，有回归测试）；PIR 全 TF，confidence 0.98
- 跨文件单包：样本结构不含该场景，NOT_VERIFIED

## 样本 6：含 RF/AF 圆弧程序

**未能验证。** 本轮所选 RKSI 样本识别结果无 RF/AF 腿（RKSI RNAV SID/STAR 主要为 TF/CF）。圆弧仅有单元测试证据（arc() 4 断言）。需 WMKJ DME ARC（AF）或含 RF 的 RNP AR 样本做生产级验证——列入验收清单。

---

# 9. P0 / P1 问题清单

## P0-1 APPROACH 全链路断裂

- **位置**：`prompts/procedure-recognizer/output-schema.json`（category 枚举）、`system.md`（"exactly one SID or STAR"）、[orchestrator.ts:91](../apps/aip-procedure-agent/src/orchestrator.ts)（normalizePir 强转 STAR）、[domain.ts](../apps/aip-procedure-agent/src/domain.ts)（无进近角色/minima 字段）、[compiler.ts:287](../apps/aip-procedure-agent/src/compiler.ts) + routeCode.ts（进近命名无法推导路线代码）
- **为什么不满足**：目标明确要求 SID/STAR/APPROACH 三类结构；当前 22/42 个 RKSI 程序包（进近类）产出语义错误的 PIR 和必然 INCOMPLETE 的 424
- **影响**：一半以上真实程序包不可用；错误 category 会污染下游任何消费方
- **修复原则**：schema/PIR/编码器三层同步扩展，禁止枚举强转；进近专用路由类型与 minima 模型
- **验收**：RNP RWY 15L 重跑后 category=APPROACH、routes 含 APPROACH_TRANSITION+FINAL_APPROACH+MISSED_APPROACH、DA/MDA 捕获、424 产出进近记录或明确列出缺失字段

## P0-2 Recognition Plan 不驱动执行

- **位置**：[orchestrator.ts:72-84](../apps/aip-procedure-agent/src/orchestrator.ts)（单次调用）、recognition-plan 动作枚举无执行器、requiredTools 无工具注册表、cropPage 零调用
- **为什么不满足**：验收原则 3/4 明确要求计划真正影响执行；现状=计划是给模型看的备忘录。STAR 等待丢失实证
- **影响**：核心能力二名存实亡；复杂程序（跨页表格、等待、多过渡）识别质量靠单次调用运气
- **修复原则**：把 plan 变成执行引擎的输入（按动作分步调用/工具循环），并用 plan 的 detectedStructure 反向校验 PIR 完整性
- **验收**：STAR OLMEN 3C 重跑捕获 5 个等待；计划-结果差异（如计划有等待而结果没有）产生 BLOCKER 告警

## P0-3 424 记录身份与方言硬编码

- **位置**：[simpleLegsTo424Text.ts:129-134](../server/src/services/jeppesen424/simpleLegsTo424Text.ts)（'SSPAP'、子节 'E'、路线型 '2/3'）、compiler.ts:305-314（transitionName 取 transitionFix 汇合点）
- **为什么不满足**：验收 6.2 要求正确处理 Route Type/记录身份；仓库内真实 RJTT 样本（SPACP…D）直接证伪当前输出；STAR 过渡名 3LASIG 错误
- **影响**：除与 WMKJ 同方言的 STAR 外，一切输出的记录身份不可信；speedLimit 丢失
- **修复原则**：按 PIR category+routeType 映射子节与路线型；过渡名取过渡起点 fix；速度列补齐；Round-trip 升级为字段级比对
- **验收**：SID 输出子节 D、STAR 子节 E、进近子节 F；GUKDO 3C 过渡名=GUKDO；速度 18 条入列；与真实 RJTT 参考行身份列一致

## P0-4 语义校验缺位，错误数据静默成"完成"

- **位置**：[compiler.ts:163-270](../apps/aip-procedure-agent/src/compiler.ts)（仅 9 条结构规则）；quality.confidence 模型自评无钳制
- **为什么不满足**：验收原则 8"缺少信息时不得静默编造"——负高度 -5000（AIP "-5 000"=至或低于 5000）以 confidence=1 通过并编入 424
- **影响**：产出数据不可信任；"COMPLETED"状态失去含义（伪实现 #15 部分成立）
- **修复原则**：高度/速度值域+符号语义校验、航向/距离反算、计划-结果完整性比对、校验结果强制降 confidence/置 reviewRequired
- **验收**：EGOBA 2C 重跑产生 BLOCKER（负高度）或正确解析为 AT_OR_BELOW 5000；含 ERROR/BLOCKER 的程序不得显示纯"识别完成"

## P1 清单

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| P1-1 | Holding 无模型字段、无几何 | domain.ts / compiler.ts | STAR/APPROACH 等待全部丢失或直线化 |
| P1-2 | 分组完整性无校验（45 vs 42 无告警；无目录比对） | orchestrator.ts:43-45 | 程序遗漏不可见 |
| P1-3 | 分组不看图片 + 无 OCR，扫描件失明 | orchestrator.ts:50、pdfPreprocessor.ts:23 | 扫描版 AIP 不可用 |
| P1-4 | GeoJSON 属性不完备（无约束/名称/course），无标注、无跑道要素 | compiler.ts:27-51 | 地图专业表现不足（能力四） |
| P1-5 | RF radiusNm 未参与计算与校验；AF 无 DME 语义；无跨 180° 处理；无生产样本验证 | compiler.ts:94-109 | 圆弧质量不可证 |
| P1-6 | 与参考 424 对比未接入 agent（comparator 闲置、按钮 disabled） | src/views/agent/AgentResults.vue | 无法用真值回归识别质量 |
| P1-7 | Round-trip 仅比腿数不比字段 | compiler.ts:350-353 | 编码回归漏检 |

P2（摘要）：证据 bbox 整页占位无字段级定位；人工修改不并入重跑新版本；424-vN.txt 磁盘产物与重编译后状态不同步；前端不展示 validations/unresolvedFields；跨文件分组无正样本。
P3：球体近似、SQL 迁移死代码、findPackage 全盘扫描、两套旧 prompt 死目录、isShared 恒 false。

---

# 10. 未实现项的具体实现方案

## 方案 A：APPROACH 全链路支持（P0-1）—— 工作量 L

**目标**：进近包产出 category=APPROACH 的 PIR，含进近角色、minima、正确路由类型，424 产出进近记录或精确 INCOMPLETE。

**修改模块**
- `apps/aip-procedure-agent/prompts/procedure-recognizer/`：schema category 枚举 +"APPROACH"；新增 `procedure.approachType`（ILS/LOC/RNP/RNP_AR/VOR/NDB/VISUAL）、`minima[]{type(DA/MDA/OCA/OCH), valueFt, category(A/B/C/D), rawText, evidence}`；fix 增 `role` 枚举（IAF/IF/FAF/FAP/MAPt/MAHF/SDF/NONE）；system.md 增进近分段规则（Approach Transition→Final→Missed 分 route，禁用 COMMON_ROUTE 表达 final）
- `domain.ts`：ProcedurePIR.procedure.category 加 'APPROACH'；PirFix.role；minima 类型；PirRoute 校验规则
- `orchestrator.ts:91`：删除强转，`pir.procedure.category = pkg.procedureCategory`
- `compiler.ts / simpleLegsTo424Text.ts`：见方案 C 的子节/路由类型映射；进近程序标识符生成（如 R15L/I15L 规则，依据项目持有的 Jeppesen 样本实测）
- 校验：FINAL_APPROACH 必须含 FAF→MAPt；MISSED_APPROACH 必须存在且不并入 final（规则码 APPROACH_STRUCTURE_*）
- 前端：结果页显示 approachType 与 minima 表
- 迁移脚本 003（若启用 DB）：procedure_category 检查约束放开

**测试样本**：RKSI RNP RWY 15L（RNP）、ILS Z RWY 15L（ILS，含 LOC 最低标准）、VOR RWY 33R（传统）。
**验收标准**：三样本 category/routes/minima 正确；MISSED_APPROACH 与 FINAL 分离；424 状态为 CANDIDATE（身份列正确）或 INCOMPLETE 且 missingFields 精确到字段。

## 方案 B：计划驱动的分步执行引擎（P0-2）—— 工作量 XL

**目标**：recognitionPlan 的动作序列真实驱动多轮模型调用与工具调用，支持局部补充识别。

**修改模块**
- 新增 `apps/aip-procedure-agent/src/planExecutor.ts`：
  - 动作→执行器注册表：`EXTRACT_PROCEDURE_METADATA|EXTRACT_FIX_COORDINATES|ANALYZE_ROUTE_STRUCTURE|EXTRACT_PROCEDURE_LEGS|EXTRACT_CONSTRAINTS` 各自映射一次**聚焦模型调用**（只带该动作 sourcePages 的文本+图，输出 PIR 片段 schema）；`BUILD_GEOJSON|BUILD_ARINC_424_CANDIDATE` 映射现有确定性编译；`VALIDATE_AGAINST_SOURCE_CHART` 映射方案 F
  - PIR 增量合并器：片段按 fixId/legId 合并，冲突进 conflicts[]（含两个候选值+各自 evidence）
  - 工具白名单重新接入：`extract_text(bbox)`、`crop_page`（PdfDocumentTools 已有实现，补 crop 图回传模型）、`search_document`；每包工具调用预算（沿用 AGENT_MAX_TOOL_CALLS）
  - 完整性反馈环：执行完对照 plan.detectedStructure —— `hasMissedApproach && !routes.MISSED_APPROACH` → 追加一轮针对性提取或产生 BLOCKER
- `orchestrator.recognizePackage` 改为调 planExecutor；保留"单轮模式"开关（AGENT_EXECUTION_MODE=single|planned）用于回归对比
- prompts：每动作一个片段 schema（metadata/fixes/routes/legs/constraints 五个子 schema，从现 PIR schema 拆分）
- ModelCall 记录增加 `planSequence` 字段，前端步骤面板按计划序号展示

**异常处理**：任一动作失败→重试 1 次→仍失败则包 FAILED 并记录失败动作；预算耗尽→以已合并片段出 PARTIAL PIR + reviewRequired。
**测试样本**：STAR OLMEN 3C（等待必须被 EXTRACT_CONSTRAINTS 捕获）、跨页坐标表样本。
**验收标准**：模型调用序列与 plan 序号对应（model-calls 可审计）；OLMEN 3C 捕获 5 个等待；关掉 planned 模式结果可对比回归。

## 方案 C：424 编码器泛化（P0-3 + P1-7）—— 工作量 L

**目标**：按程序类别输出正确记录身份/路由类型/过渡名/速度，Round-trip 字段级。

**修改模块**
- `simpleLegsTo424Text.ts`：
  - SimpleProcedureLeg 增 `procedureCategory`、`routeRole(RUNWAY|COMMON|ENROUTE|APPROACH_TRANSITION|FINAL|MISSED)`
  - 子节映射：SID→'D'、STAR→'E'、APPROACH→'F'（列 13）；客户区代码参数化（options.customerArea，默认按现有样本 'SPA'/'PAC' 可配）
  - 路由类型映射表（以项目持有的 WMKJ/RJTT 真实样本实测为准，逐类落黄金测试）：SID 跑道过渡/公共/离场过渡、STAR 对应三类、进近 transition/final/missed
  - 速度列写入（speedLimitKias→对应列，位置按真实样本实测）
  - 高度编码前值域断言：alt∈[-1500,60000] 之外抛错（联动方案 E 在 PIR 层拦截）
- `compiler.ts:305-314`：`transitionName` 改取过渡 route 的**起点 fix**（route.legIds[0].fromFixId ?? 首腿 toFix），不再用 transitionFix 汇合点
- Round-trip：新增 `compare424RoundTrip(pir, reparsedLegs)`：逐腿比 fix/PT/turn/alt(含符号)/speed/distance，差异写入 candidate424.roundTrip.mismatches[]，非空则状态降为 424_DERIVED
- 接入参考对比：AgentResults"与 Jeppesen 424 对比"按钮启用——新端点 `POST /procedures/:id/compare-424`（body 为参考 424 文本），复用 `simpleProcedureComparator` + deriveRouteCode 对齐

**测试样本**：真实 RJTT SPACP 行（已在仓库）、WMKJ SSPAP 行（已在仓库）、RKSI GUKDO 3C（过渡名=GUKDO 断言）。
**验收标准**：RJTT SID 输出与参考行身份列逐列一致（除文件记录号）；字段级 Round-trip 0 mismatch；速度入列。

## 方案 D：Holding 模型与跑马场几何（P1-1）—— 工作量 M

**目标**：HA/HF/HM 在 PIR 有一等表达，GeoJSON 生成跑马场。

- `domain.ts` PirLeg 增：`holding?: { inboundCourse: number; turnDirection: 'L'|'R'; legTimeMin?: number|null; legDistanceNm?: number|null; }`；recognizer schema 同步 + system.md 增等待提取规则（等待表/图上跑马场符号）
- `compiler.ts` 新增 holdingGeometry()：
  - 输入：holding fix 坐标、inboundCourse、turn、legTime(按 TAS 缺省 210kt 折算距离)或 legDistance、类别标准转弯半径 r = v/(20π·rate)（rate=3°/s 以下按高度分层，MVP 用固定 1min 标准）
  - 算法：以 fix 为入航端点，沿 inboundCourse 反向延腿长得外端；两端各接半径 r 的 180° 半圆（方向按 turnDirection），采样 ≤5°；输出闭合 LineString，quality=DERIVED
  - 缺 inboundCourse → DISPLAY_ONLY 直线并警告；不得标 EXACT
- 校验：holding 腿 PT∈{HA,HF,HM} 且 holding 对象存在，否则 WARNING
- 测试：左/右转、按时间/按距离、跨 0° 航向；验收：RNP RWY 15L 的 MAHF 等待呈跑马场且方向与图一致

## 方案 E：语义校验引擎（P0-4）—— 工作量 M

**目标**：错误数据不能安静通过；质量分与校验联动。

- `compiler.ts` validatePir 扩展（每条规则独立规则码，全部带 fieldPath）：
  - ALT_RANGE：constraint 各值 ∈[0,60000]ft，负值 BLOCKER（直接命中 -5000 案例）；AT_OR_ABOVE 值> AT_OR_BELOW 语义交叉检查 rawText 前缀（"-"前缀+AT_OR_ABOVE → CONFLICTED WARNING）
  - SPEED_RANGE：∈[90,350]KIAS
  - COURSE_BACKCHECK：from/to 均有坐标且 course 非空 → geodesicInverse 反算，|Δ|>10°（考虑磁差±15°容忍带）WARNING、>25° ERROR
  - DIST_BACKCHECK：|反算距离−distanceNm|>max(0.5NM,5%) WARNING
  - RF_RADIUS：|d(center,from)−d(center,to)|>0.2NM ERROR；radiusNm 与实测半径差>10% WARNING
  - ROUTE_CONNECTIVITY：相邻 route 连接点 fix 一致（过渡终点=公共段起点）
  - PLAN_COMPLETENESS：对照 recognitionPlan.detectedStructure（hasMissedApproach/等待清单）缺失→ERROR
- 质量联动（orchestrator.recognizePackage）：存在 BLOCKER → procedure.status 保持 COMPLETED 但 pkg.status=REQUIRES_REVIEW，quality.confidence=min(model, 0.6)，reviewRequired=true
- 前端：包列表徽章区分"识别完成/需复核"；结果页展示 validations 列表与 unresolvedFields（现完全未展示）
- 测试：构造负高度/反航向/半径不齐 PIR 夹具；验收：EGOBA 2C 重跑触发 ALT_RANGE BLOCKER

## 方案 F：原图叠加与几何反向校验（P1 → 支撑 VALIDATE_AGAINST_SOURCE_CHART）—— 工作量 L

**目标**：把 GeoJSON 航迹叠回原图并由模型判偏差。

- 图上配准：利用已有 textSpans bbox——在图页文本中定位 ≥3 个已识别 fix 名的标注位置（pdfPreprocessor 已存 span bbox），与其 WGS84 坐标做仿射拟合（最小二乘），得到 页面像素↔经纬度 变换；拟合残差>阈值则放弃叠加并标 NOT_GEOREFERENCED
- 渲染：@napi-rs/canvas 在 200DPI 页图上画航迹折线/圆弧（按 route 分色），输出 overlay-<procedureId>.png 存 artifact
- 模型复核调用（新 prompt `chart-overlay-verifier`）：输入原图+叠加图，输出 {deviations[]{legId, kind(MISSED_FIX/WRONG_TURN/EXTRA_LEG/MISSING_BRANCH), severity, note}}，写入 validations
- 局部重识别：deviation 指向的 legId → 方案 B 的 EXTRACT_PROCEDURE_LEGS 针对性重跑
- 前端：AgentResults "原图叠加" 标签页启用（现 disabled），显示 overlay PNG
- 验收：对 BINIL 3C 叠加后所有 fix 落点距图上标注 <30px；故意删一条腿能被检出 MISSING_BRANCH

## 方案 G：扫描件支持（分组视觉 + OCR）（P1-3）—— 工作量 L

- 分组调用加图：groupAirportPackages 对 `isScanned` 或 `nativeTextCoverage<0.05` 的页面附缩略图（受 6 图预算限制→分批：每批 ≤6 图多轮调用合并 packages，或改传 每页 300px 缩略拼图）
- OCR：pdfPreprocessor 对 isScanned 页接 OCR（方案二选一：本地 tesseract.js（零外呼）或复用视觉模型做逐页转写 prompt page-transcriber，写回 nativeText 并把 extractionMethod 标 OCR）
- 验收：一个纯扫描 AIP 样本可完成分组且包含正确程序名

## 方案 H：GeoJSON 专业属性与标注（P1-4）—— 工作量 M

- LEG properties 补：`fromFix/toFix(identifier)`、`course/distanceNm/turnDirection`、`altitudeConstraint/speedConstraint(原样对象+格式化文本 alt_text: "+5000")`、`procedureName/runway`
- 新要素：`featureType:"RUNWAY"`（跑道端两点线+编号，坐标源=RUNWAY_DATA 页识别或 PIR 新增 runways[] 实体）、`featureType:"LABEL"`（沿用旧管线 labelPlan 范式：text/text_anchor/anchor 经纬度，由编译器按 leg 中点与 fix 位派生，前端 MapLibre symbol layer 渲染）
- 前端：Route/Transition 分层显隐 checkbox、按 routeType 线型（missed=虚线）
- 验收：地图无需点击即可读出程序名/约束/跑道；Missed Approach 虚线区分

## 其他（P2/P3 摘要）

- 字段级证据：recognizer schema 要求 evidence 带 bbox（模型可从 textSpans 引用）+ 编译期把 bbox 换算像素裁剪 imageCrop —— S/M
- 人工修改保留：重跑时把 fieldStatus=MANUALLY_EDITED 的字段从上一版本复制覆盖新 PIR，并记 warning —— S
- 424 产物同步：recompile 端点写回 424-vN.txt —— S
- 分组完整性：确定性比对 decisionSummary 数字 vs packages.length；PROCEDURE_INDEX 页解析出程序清单与包名模糊匹配，未命中→任务 warning —— M
- 死代码清理（旧 prompts、SQL 迁移或接 DB 二选一、recordBusinessStep）—— S

---

# 11. 推荐实施顺序

**第一阶段（阻断问题）**：方案 A（APPROACH 链路）→ 方案 E（语义校验）→ 方案 C（424 泛化）。
理由：三者都是"产出数据不可信/不可用"级别；A 与 C 有耦合（进近记录身份），建议 A 的 PIR 层先行、C 随后。

**第二阶段（专业数据生成）**：方案 B（计划驱动执行引擎）+ 方案 D（Holding）。B 是能力二的本体，D 依赖 B 的约束提取动作效果最佳。

**第三阶段（几何完善）**：方案 H（属性/标注/跑道）→ RF/AF 补强（radiusNm 校验、跨 180°、真实 RF 样本）→ 方案 F（原图叠加）。

**第四阶段（全球样本扩展）**：方案 G（扫描件/OCR）；构造跨文件单包样本（坐标总表独立文件）；补 WMKJ（AF DME ARC）、含 RF 的 RNP AR、多语言样本进回归集。

**第五阶段（回归评测）**：把 §8 六类样本固化为评测脚本（识别→与人工标注 PIR/参考 424 diff→打分），每次 prompt/编译器变更跑全量；planned/single 双模式对比报表。

---

# 12. 最终验收清单（Checklist）

## 能力一 · 分组
- [ ] 跨文件单包正样本通过（坐标表与程序图在不同 PDF）
- [ ] 纯扫描 PDF 任务可正确分组（OCR/视觉）
- [ ] decisionSummary 与 packages 数量一致性自动校验并告警
- [ ] PROCEDURE_INDEX 目录比对：目录程序数 vs 分组数差异产生 warning
- [ ] isShared 标志被真实使用（共享页在多包中标记）

## 能力二 · 自适应识别
- [ ] 模型调用序列与 recognitionPlan 动作序号对应（model-calls 可审计）
- [ ] plan.detectedStructure 与 PIR 结构不符时产生 ERROR（等待/missed 缺失可检出）
- [ ] STAR OLMEN 3C 重跑捕获 5 个等待程序
- [ ] 工具调用（bbox 取文/局部裁剪）在至少一个样本中真实发生
- [ ] 字段级局部重试可用（不整包重跑）

## 能力三 · PIR/424
- [ ] APPROACH PIR：category/APPROACH_TRANSITION/FINAL/MISSED/minima 齐全（RNP RWY 15L）
- [ ] 424 子节按 SID=D/STAR=E/APPR=F 输出；与仓库 RJTT 参考行身份列一致
- [ ] STAR 过渡名=过渡起点 fix（GUKDO 3C → GUKDO）
- [ ] 速度限制入 424；负高度被 BLOCKER 拦截
- [ ] Round-trip 字段级比对 0 mismatch；mismatch 时状态降级
- [ ] "与 Jeppesen 424 对比"端到端可用（上传参考文本→diff 报告）
- [ ] 人工编辑字段在重跑后保留并标记

## 能力四 · GeoJSON
- [ ] LEG properties 含 course/distance/alt/speed/turn/fix 名/程序名
- [ ] RUNWAY 要素（两端点+编号）出现且 SID 首腿接 DER
- [ ] HM/HF/HA 呈跑马场，方向与原图一致
- [ ] RF：radiusNm 参与校验；真实 RF/AF 样本（WMKJ DME ARC）通过；跨 180° 测试通过
- [ ] LABEL 要素渲染程序名/约束
- [ ] 原图叠加 PNG 产出且 fix 落点误差 <30px；删腿注入测试可被检出
- [ ] 校验结果与 unresolvedFields 在前端可见；BLOCKER→"需复核"状态

## 工程
- [ ] 六类样本回归评测脚本进 CI（`npm test` 之外的 eval 目标）
- [ ] 424-vN.txt 与最新编译状态同步
- [ ] 死代码处理：旧 prompts 目录、SQL 迁移（接 DB 或删除）、recordBusinessStep

---

## 附：伪实现核查结论（对照验收 §十 逐条）

| # | 伪实现 | 结论 |
|---|---|---|
| 1 | Planner 固定模板 | **否**（三类计划实质不同，引用真实 fix 名） |
| 2 | 全部程序同识别步骤 | **模型输入层否 / 执行层是**（执行恒为单次调用） |
| 3 | Plan 保存但执行器不读 | **部分成立**（读了，但只作 prompt 上下文；动作无执行器） |
| 4 | 包=名称列表无页面关系 | 否（packagePages 真实） |
| 5 | 多文件仍逐文件识别 | 否（合并后统一分组） |
| 6 | 按连续页码分组 | 否 |
| 7 | 缺坐标编 0,0/随机 | 否（null+UNRESOLVED 实证） |
| 8 | 所有腿直线 | 部分否（RF/AF 弧算法存在；但等待直线化、真实样本未触发弧） |
| 9 | RF/AF 仅属性标记 | 否（geometry 真为弧），但 radiusNm 未用 |
| 10 | 跑道只画一个点 | **更糟：跑道完全无要素** |
| 11 | 424 由模型直接返回 | 否（确定性编译） |
| 12 | 424 无定宽校验 | 否（132 列+多重字段合法性抛错） |
| 13 | 424 无 Round-trip | 部分成立（有回读，仅比腿数） |
| 14 | GeoJSON/424 两套识别 | 否（同一 PIR） |
| 15 | 页面"已完成"实则大量 unresolved | **进近场景成立**（RNP 15L：COMPLETED+confidence 1+三处实质缺陷）；前端不显示 validations 加重此问题 |
| 16 | 模型失败静态兜底 | 否（抛错、包 FAILED） |
| 17 | 人工确认被重跑覆盖 | 部分成立（旧版本保留但新版本不合并人工修改） |
| 18 | 只有接口/表结构无业务调用 | 表结构层成立（SQL 迁移零引用）；接口层否 |
| 19 | 校验只查 JSON 可解析 | 否，但仅结构层 9 条规则 |
| 20 | 仅对当前样本写特殊规则 | 部分成立（424 方言锁 WMKJ；ROUTE_CODE_TO_PROCEDURE 静态表为 WMKJ 专用+通用推导兜底；prompt 层无机场特例 ✔） |
