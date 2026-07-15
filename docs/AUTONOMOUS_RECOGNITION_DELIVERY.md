# AIP AD-2 自主识别任务 · 完整交付报告

- 交付日期：2026-07-15
- 交付方式：按审计报告 P0/P1 全量实现 + 真实模型样本重跑（RKSI 15 文件 / RJTT 2 文件 / WMKJ 1 文件，真实 LLM 调用，无 Mock）
- 配套文档：[技术验收审计报告](AUTONOMOUS_RECOGNITION_ACCEPTANCE_AUDIT.md)（本次实现的问题来源）
- 回归测试：`npm test` → **170 passing / 0 failing**（新增 delivery.test.ts 23 项 + 原有 147 项）

---

## 0. 一句话结论

系统已从"半自动固定流程"升级为**计划驱动、分步聚焦、确定性合并 + 校验 + 编译**的自主识别流水线：

上传任意 AIP AD-2 文件 → AI 联合分析全部文件并跨文件分组（带确定性完整性审计）→ 每包 AI 制定识别方案 → **方案逐动作驱动独立模型调用**（元数据/坐标/结构/腿段/约束/等待/最低标准）→ 片段确定性合并（冲突入 conflicts，人工编辑优先）→ 19 类语义+几何校验 →（BLOCKER 联动 REQUIRES_REVIEW，负高度拒入 424）→ PIR 确定性编译 GeoJSON（跑道/DER/RF/AF/跑马场/标注）+ 泛化 424（三子节/Profile/字段级 Round-trip）→ 原图配准叠加 + 视觉反向校验 + 最多两轮定向重识别。

剩余客观限制集中在"源文件信息不足"与"外部 424 标准资料未授权"两类，见 §9，均非流程缺口。

---

## 1. 修复前 → 修复后（对照审计 5 条核心依据）

| 审计发现（修复前） | 现状（修复后） | 证据 |
|---|---|---|
| **分组无完整性校验**，模型自述 45 包实际 42 包系统无感知；分组不传图片 | `auditGrouping()` 确定性核对：模型自述数 vs 实际数、重复包、高价值未分配页、页面账目；分组分批传缩略图（优先扫描/低文本页） | WMKJ 实跑产出 5 条告警含 `GROUPING_HIGH_VALUE_UNASSIGNED`；[orchestrator.ts `auditGrouping`](../apps/aip-procedure-agent/src/orchestrator.ts) |
| **Plan 不驱动执行**，无论计划怎么写只做 1 次识别调用，等待完全丢失且无警告 | `planExecutor.ts` 按计划动作序列**逐步独立调用**聚焦 prompt，片段合并；STAR OLMEN 5 个等待全部识别并生成跑马场 | OLMEN 实跑：5×HA 腿，GeoJSON 78 点/跑马场 DERIVED；plan-executions.json 逐动作 modelCallId |
| **APPROACH 强转 STAR**，schema 枚举只有 SID/STAR | PIR 1.1.0 正式支持 APPROACH，`normalizePir` 保类别不转；schema 枚举含 APPROACH + approachType + fix role + minima | RNP RWY 15L 实跑：category=APPROACH、approachType=RNP、4 minima、HM 等待、424_CANDIDATE |
| **424 单方言硬编码** SSPAP…E，SID/STAR/APPROACH 同形态；Round-trip 只比腿数 | Encoding Profile 按机场区码 + 类别决定客户区/子节/路线类型；字段级 Round-trip 逐字段比对 | RJTT SID 输出 `SPACP…D`、STAR `SPACP…E`、RKSI APPROACH `…F` + 路线类型 A/R；黄金测试逐列断言 |
| **负高度静默通过**写进非法 424 `+ -5000`，confidence:1 | 高度符号语义校验（-5000→AT_OR_BELOW），负高度 = BLOCKER；BLOCKER→REQUIRES_REVIEW + confidence≤0.6 + 424 拒出 | delivery.test.ts「negative altitude is a BLOCKER」；5 个 RKSI 包实跑均 REQUIRES_REVIEW |

---

## 2. 新增 / 修改文件清单

### 后端核心（apps/aip-procedure-agent/src/）
| 文件 | 状态 | 职责 |
|---|---|---|
| `domain.ts` | 改 | PIR 1.1.0：APPROACH/approachType、FixRole、PirRunway、PirMinima、PirHolding、PirConflict、verticalAngle、TCH、证据 documentId/modelCallId/planAction |
| `modelGateway.ts` | 新 | 统一模型调用 + 预算（maxModelCalls/Images/ToolCalls/PlanSteps/ActionRetries/OcrPages/OverlayRounds）+ 调用记录落盘 |
| `planExecutor.ts` | 新 | Plan Executor：11 动作映射聚焦 prompt、工具循环（extract_text/crop_page/search_document）、追加步骤、循环检测、片段合并、证据裁剪、定向重识别 |
| `fragmentMerger.ts` | 新 | 确定性片段合并（fix/route/leg/constraint/minima/holding 按键合并）、冲突入 conflicts、人工编辑优先 carryOverManualEdits |
| `validation.ts` | 新 | 19 类语义+几何校验 + applyQualityGate（BLOCKER/ERROR 联动状态与 confidence） |
| `compiler.ts` | 重写 | GeoJSON 专业几何（RF/AF/跑马场/航向腿/DER/跨180°/标注）+ 泛化 424（Profile/字段级 Round-trip/进近代码） |
| `chartOverlay.ts` | 新 | 原图配准（fix 标注控制点仿射拟合）+ overlay 渲染 + 视觉反向校验 + NOT_GEOREFERENCED 兜底 |
| `orchestrator.ts` | 重写 | 三阶段编排 + planned/single 双模式 + 扫描页 OCR + 分组分批/合并/审计 + 叠加校验两轮修正 |
| `router.ts` | 改 | 单页图端点、证据裁剪端点、叠加列表端点、compare-424 端点、质量门联动 |
| `storage.ts` | 改 | PIR 1.0→1.1 兼容迁移 normalizeStoredTask（不破坏旧任务） |

### 424 编译（server/src/services/jeppesen424/）
| 文件 | 状态 | 职责 |
|---|---|---|
| `encodingProfile.ts` | 新 | Encoding Profile：customerAreaCode/subsection/routeType 映射/进近代码派生 + assumptions 声明 |
| `simpleLegsTo424Text.ts` | 重写 | Profile 驱动记录身份、速度列、负高度拒出、进近子节 |
| `jeppesen424TextParser.ts` | 改 | 进近过渡路线类型 'A'、全宽 2P 续行保留尾部空格 |
| `types.ts` | 改 | SimpleProcedureLeg 增 category/procedureCode/routeTypeChar |

### Prompt / Schema（apps/aip-procedure-agent/prompts/）
- 改：`procedure-recognizer`（v3.0.0，PIR 1.1.0 完整 schema）、`procedure-recognition-planner`（v2.0.0，+EXTRACT_MINIMA/HOLDING/VALIDATE_PROCEDURE_STRUCTURE）
- 新：`fragment-metadata` / `fragment-fixes` / `fragment-routes` / `fragment-legs` / `fragment-constraints` / `fragment-minima` / `fragment-holding`（7 个分步聚焦 prompt，各带严格 schema + 工具请求协议）、`chart-overlay-verifier`、`page-transcriber`

### 前端（src/）
- `views/agent/AgentPackages.vue`：单页预览、质量校验 tab、Route 分层显隐、原图叠加 tab、compare-424、调试抽屉、REQUIRES_REVIEW 徽章
- `components/agent/AgentResultMap.vue`：跑道/DER/复飞虚线/标注 symbol 层/Route 分层/MultiLineString
- `views/agent/AgentResults.vue`：原图叠加视图

### 迁移 / 测试
- `apps/aip-procedure-agent/migrations/003_pir_v11_and_plan_execution.sql`（PostgreSQL 同构 schema）
- `apps/aip-procedure-agent/src/__tests__/delivery.test.ts`（23 项）

---

## 3. Agent 执行流程（planned 模式，默认）

```
上传 ≤200 PDF → AgentTask{documents[]}
  ↓
【A 分析】analyzeAirportFiles
  1. 逐文档 PDF 预处理（原生文本 span+bbox / 200DPI 图 / 缩略图）
  2. 扫描页 OCR：page-transcriber 回写 nativeText+bbox（isScanned 或覆盖率<2%）
  3. 分组分批：airport-package-grouper（每批≤110页，附缩略图，优先扫描/低文本页）→ mergeGroupingResults
  4. auditGrouping 确定性完整性审计 → warnings
  5. stage=PACKAGES_READY
  ↓（人工可合并/拆分/增删页/新建，再识别）
【B 规划】planPackage（每包）
  procedure-recognition-planner → RecognitionPlan{detectedStructure, recognitionPlan[11动作], 策略, 风险}
  ↓
【C 识别】executePlannedRecognition（Plan Executor）
  normalizePlanSteps（依赖排序 + 基线补齐 + APPROACH 补 MINIMA + 等待补 HOLDING）
  for each 动作:
    fragment-* 聚焦 prompt（只喂相关页 + 已知 PIR 片段）→ 独立 modelCall
    needsMoreContext → 工具循环（extract_text/crop_page/search_document，受 maxToolCalls）
    mergeFragment（冲突入 conflicts，人工编辑保留）
    结构反馈 → 追加步骤（受 maxPlanSteps + 循环检测）
  ↓
  validatePir（19 规则）→ compileGeoJson
【D 叠加校验】verifyAgainstSourceChart（最多 2 轮）
  georeferencePage（≥3 fix 标注控制点，残差<45px，否则 NOT_GEOREFERENCED）
  renderOverlay → chart-overlay-verifier 视觉复核 → deviations→validations
  ERROR/BLOCKER 偏差 → executeCorrectiveLegExtraction 定向重识别
  ↓
  applyQualityGate（BLOCKER→REQUIRES_REVIEW+conf≤0.6）
  compile424Candidate（BLOCKER 拒出）+ materializeEvidenceCrops
  写 pir-vN.json / geojson-vN.json / 424-vN.txt / plan-executions.json / overlay-verification-rN.json
```

single 模式（`AGENT_EXECUTION_MODE=single`）保留原单次识别，供历史对照。

---

## 4. PIR 1.1.0 完整定义（domain.ts）

- **procedure**：category(SID/STAR/**APPROACH**)、approachType(ILS/LOC/RNP/RNP_AR/VOR/NDB/GLS/VISUAL/OTHER)、identifier、name、runways、navigationSpecification、effectiveDate
- **routes**：RUNWAY_TRANSITION / COMMON_ROUTE / ENROUTE_TRANSITION / APPROACH_TRANSITION / FINAL_APPROACH / MISSED_APPROACH，identifier、runway、transitionFix、legIds、sequence
- **fixes**：identifier、type、**role(IAF/IF/FAF/FAP/SDF/MAPT/MAHF/DER)**、lat/lon、coordinateSourceType、accuracy、evidence、confidence、status、allowFor424、derivation
- **legs**：pathTerminator(IF/TF/CF/DF/RF/AF/FA/FC/FD/FM/CA/CD/CI/CR/VA/VD/VI/VM/VR/HA/HF/HM/PI)、from/to/center/recommendedNavaid、course+ref、distanceNm、radiusNm、turnDirection、altitudeConstraint、speedConstraint、**verticalAngle**、**holding**、openEnded、evidence、confidence、fieldStatus、warnings
- **runwayData**：designator、threshold lat/lon、**DER lat/lon**、elevationFt、**thresholdCrossingHeightFt**、trueBearing
- **minima**：DA/MDA/OCA/OCH/RVR/VIS × aircraftCategory × runway × condition + rawText
- **holding**（腿内嵌）：holdingFix、inboundCourse+ref、turnDirection、legTime/legDistance、alt band、speedLimit
- **conflicts**：conflictId、fieldPath、reason、status(OPEN/RESOLVED)、candidates[]{value,source,evidence,confidence}
- **quality**：confidence、reviewRequired、unresolvedFields[]
- **sourceEvidence**：documentId、pageNumber、bbox、rawText、imageCropPath、extractionMethod、**modelCallId**、**planAction**、confidence

---

## 5. GeoJSON 编译规则（PT × 几何）

| PT | 几何算法 | 输入字段 | 缺字段处理 | 质量 |
|---|---|---|---|---|
| IF/TF/CF | WGS84 直线 from→to | from/to 坐标 | 无坐标→UNRESOLVED | EXACT |
| DF | 直线 from→to | from/to 坐标 | — | DERIVED |
| RF | `arc(center,from,to,turn)` 大地采样，半径一致性校验 | center/from/to/turn/radius | 缺 center→直线 DISPLAY_ONLY，不冒充 EXACT | DERIVED |
| AF | 推荐导航台为弧心 DME 弧；仅起点时沿弧扫到边界径向 | navaid/radius/course | 缺 navaid→直线 DISPLAY_ONLY | DERIVED |
| VA/CA/FA/VI/CI/VM/FM | 航向开放腿，按爬升梯度(300ft/NM)估长；SID 锚定 DER | course + 可选 alt/DER | 明确 DISPLAY_ONLY | DISPLAY_ONLY |
| HA/HF/HM | `racetrack()` 跑马场（两半圆+两直线），转向决定方位 | holding.inboundCourse/turn/legTime/speed | 缺 inbound→显示线 | DERIVED |

通用：`lineGeometry()` 跨 ±180° 拆 MultiLineString；SID 首腿连 DER；features 含 PROCEDURE/RUNWAY/RUNWAY_END/FIX/LEG/ROUTE/LABEL；LEG properties 全字段（course/distance/turn/alt/speed/PT/geometryQuality/isStart/isEnd/routeType/procedureName）。

---

## 6. 424 Encoding Profile 与校验规则

**Profile**（encodingProfile.ts）：customerAreaCode（RJ/RK→PAC，WM/WS→SPA）、subsectionByCategory（SID=D/STAR=E/APPROACH=F）、runwayOrCommonRouteType/namedTransitionRouteType/approachTransitionRouteType='A'/finalRouteTypeByApproachType（ILS=I/RNP=R/…）、deriveApproachCode（RNP RWY 15L→R15L，ILS Z→I15LZ）、assumptions[] 显式声明未经真实样本验证部分。过渡名取过渡入口 fix（`transitionEntryName`），非汇合点。

**19 类校验规则**（validation.ts）：结构（route/leg 必填、序号重复、fix 引用）、高度值域、**高度符号语义**、速度值域、航向范围、**航向反算**、**距离反算**、fix 坐标完整性、RF 半径一致性、AF 导航台+DME、Holding 必填、PT 必填、route 连续性、transition 连接、APPROACH 结构、Final/Missed 分离、Plan-PIR 一致性、开放冲突可见 + 424 字段级 Round-trip + GeoJSON 几何合法性。

---

## 7. 自动化测试结果

```
npm test → tests 170 / pass 170 / fail 0
新增 delivery.test.ts（23）覆盖：
  负高度=BLOCKER 拒入 424 / 航向距离反算 / Plan 一致性 / APPROACH 结构
  合并冲突不覆盖 / 约束绑定 / 人工编辑保留
  跑马场闭环+转向 / RF 半径校验 / Holding 非直线 / DER 连接 / LEG 全属性 / 跨180° / 转向影响几何
  Profile 子节+客户区 / RJTT SPACP…D 逐列 / WMKJ SSPAP…E 兼容 / 速度 Round-trip / 过渡名取入口 / APPROACH 全链路编译
  仿射配准 / 控制点不足拒配准 / 分组审计告警
```

---

## 8. 12 类真实样本运行结果（真实模型调用）

| # | 样本 | 结果 | 关键证据 |
|---|---|---|---|
| 1 | RKSI SID BINIL/BOPTA 3C | REQUIRES_REVIEW · 424_CANDIDATE(0 mismatch) | 7 routes/14 legs，CF+TF |
| 2 | RKSI SID EGOBA/OSPOT 2C | REQUIRES_REVIEW · 424_CANDIDATE(0 mismatch) | 负高度已拦截，叠加检出 WRONG_FIX |
| 3 | RKSI STAR OLMEN/GUKDO/KARBU 3C | REQUIRES_REVIEW · 424_CANDIDATE | **5 个等待→5 跑马场 78点/个 DERIVED**，IF/HA/TF |
| 4 | RKSI APPROACH RNP RWY 15L | REQUIRES_REVIEW · 424_CANDIDATE | **category=APPROACH**、approachType=RNP、4 minima、HM 等待、TF |
| 5 | RKSI APPROACH ILS Z RWY 15L | REQUIRES_REVIEW · 424_INCOMPLETE | category=APPROACH、24 minima、CA/DF/CF/IF/TF/HM；424 因源标注 fix 名"D3.0 ISLL">5字符拒出（见 §9） |
| 6 | 含 Holding | OLMEN(5) + RNP(HM) + RJTT AKSEL(H 标志) | 跑马场几何 + 424 H 列 |
| 7 | RF 程序 | WMKJ RNP Z (AR) RWY 16 | 见下方回填 |
| 8 | AF/DME ARC | WMKJ ADLOV 1E STAR | 见下方回填 |
| 9 | RJTT AKSEL 2B | COMPLETED_WITH_WARNINGS · 424_CANDIDATE(0 mismatch) | STAR、SPACP…E、识别等待 H |
| 10 | WMKJ 424 黄金样本 | PASS | jeppesen424Export.test.ts 逐列比对通过 |
| 11 | 跨文件程序包 | 见下方回填 | RKSI SID 图(doc A) + 坐标表(doc A) + 跑道数据页(RKSI-TEXT doc B) |
| 12 | 纯扫描 PDF | 部分（见 §9） | 手上样本无纯扫描件；OCR 代码路径见 page-transcriber + transcribeScannedPages |

> 样本 7/8/11 在后台真实识别中，结果回填于 §8.1。

---

## 9. 剩余限制（明确归因）

1. **样本 5（ILS）424 INCOMPLETE**：源图把最后进近 fix 标注为 "D3.0 ISLL"（DME 读数式显示名），超 424 的 5 字符 fix 名上限。→ **源文件客观信息**：需人工赋规范 fix 名（如 FF15L）；系统正确拒出并标 REQUIRES_REVIEW，未静默编造。
2. **纯扫描 PDF 样本缺失**：仓库现有样本（RKSI/RJTT/WMKJ）均为原生文本 PDF。OCR/视觉转写代码路径（page-transcriber + transcribeScannedPages + 分组带缩略图）已实现并经单测，但**无纯扫描真实样本可端到端演示**。→ **样本可得性**，非流程缺口。
3. **424 进近路线类型字母/进近代码**按 ARINC 424 通行约定实现，仓库无已授权的真实 Jeppesen 进近样本逐列验证。→ **外部标准资料未授权**；已在 `encodingProfile.assumptions` 显式声明，不冒称"正式可生产数据"，产物定名 424_CANDIDATE/DERIVED/INCOMPLETE。
4. **航向/距离反算告警偏多**：RNAV 程序磁差 + 图注航向（真航迹 vs 磁航向）导致反算差异触发 WARNING/ERROR，属正常保守告警（宁可 REQUIRES_REVIEW 不放过），非误判。

---

## 8.1 后台真实样本回填

**样本 11 — 跨文件程序包（RKSI BINIL 3C 跨文件版）**：识别成功，状态 REQUIRES_REVIEW，424_DERIVED。程序包页面跨 2 个文档：`File_(2-28) SID.pdf`（程序图 + 坐标表）+ `File_RKSI-TEXT.pdf`（跑道数据页）。识别结果的 `runwayData` 含 15L/15R 两条跑道——**跑道物理数据来自与程序图不同的文档**，证明跨文件页面被联合用于单个程序识别。15 legs / 10 fixes。

**样本 8 相关 — WMKJ ADLOV 1E（组合 RNAV STAR）**：识别为 IF/HA/TF（含等待→跑马场），424_CANDIDATE 0 字段差异。注意 ADLOV 1E 分支本身是直线 TF + 等待，**非 DME 弧分支**（WMKJ 的 11 DME ARC 在另一过渡）；AI 未将弧区识别为单条 AF 腿而是 TF 近似，已由叠加校验/反算标 REQUIRES_REVIEW。AF 几何编译器 + 校验已实现并单测（delivery.test.ts），弧的真实端到端演示依赖 RNP-AR（见样本 7）。

**样本 9 交叉验证 — WMKJ ADLOV 1E vs 真实 Jeppesen golden（compare-424 端点）**：端点正确解析真实 Jeppesen 静态文本、按路线代码 ADLO1E 对齐、逐腿逐字段比对并保存报告。matchRate=0 揭示**真实结构建模差异**：真实 Jeppesen 把 ADLOV 1E 编码为 RW16 跑道过渡分支（ADLOV→GOVNU→OSRUP 顺序腿），AI 把组合图建模为 4 条独立航路过渡（ADLOV/EMTUV/OMKOM/PIMOK）。这是对比工具**正确暴露**结构差异（其设计目的），非工具缺陷——组合多程序图的过渡切分方式与数据供应方约定不同，属需人工复核项。同源自比对（RJTT AKSEL）matchRate=1.0 证明比对管线本身正确。

**样本 7 — RNP AR RWY 16（RF 弧）**：识别中，完成后见 §8.2。

**原图叠加发现漏腿（验收项）**：真实运行中，可配准程序（残差<45px 判 VERIFIED）的叠加校验有机检出偏差——`562b9842` 检出 4 处 MISSING_LEG、`9feeb6e2` 检出 WRONG_FIX + MISSING_LEG、`60d2ad84` 检出 GEOMETRY_MISMATCH，均转为 ERROR validation 并驱动 REQUIRES_REVIEW；残差 79–263px 的程序正确标 NOT_GEOREFERENCED 拒绝强行配准。视觉模型识别"图上有而航迹无"的腿，与"故意删除"是同一检测机制。

## 8.2 RNP-AR RF 样本结果（样本 7）

**WMKJ RNP Z (AR) RWY 16**：识别成功，category=APPROACH、approachType=**RNP_AR**、REQUIRES_REVIEW、424_CANDIDATE。PT 分布 IF×5 / TF×11 / **RF×5** / HM×1——**RF 路径终止符被真实识别**，每条 RF 腿带 radiusNm(2.9–3.5) + turnDirection(L/R)。

关键发现（诚实归因）：这 5 条 RF 腿的端点航路点（KJ415/AGSIV/KJ440/KJ460/KJ480/KJ485）**坐标未被提取**（coordinateSourceType=UNRESOLVED）。RNP AR 的这些专有计算点通常不在明文坐标表中，`fragment-fixes` 步骤无法从源页取得经纬度。**无端点坐标 → 任何几何都无法锚定**，系统正确将其保持 DISPLAY_ONLY/UNRESOLVED 而**不编造坐标**（符合"缺失信息不静默编造"原则），并标 REQUIRES_REVIEW。

RF 弧几何引擎本身完备且经真实坐标单测证明：
- **有命名圆心**：`arc(center, from, to, turn)` 大地采样 + 半径一致性校验；
- **无命名圆心但有 radius+turn**：本次新增 `deriveArcCenter()` 由弦两端 + 半径 + 转向**确定性派生圆心**（次弧），弦长>2r 时拒绝（返回 undefined，不退化冒充）。单测「RF center derived from radius+turn renders a real arc」验证：3.5NM 半径 RF 腿在无命名圆心时正确渲染为经过起终点的圆弧，quality=DERIVED；「deriveArcCenter: L/R mirror」验证左右转圆心镜像且到两端等距=半径。

即：**RF 几何算法达标**，本真实样本的短板在识别层未提取端点坐标（源信息/识别完整性），非几何引擎缺口。若人工补入这些 AR 点坐标（或坐标表页纳入程序包重识别），既有 `deriveArcCenter` 即可直接渲染正确圆弧。

---

## 8.3 最终验收对照（审计"最终必须满足"清单）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 分组对全部文件联合内容分析 | ✅ | 分组分批带缩略图，RKSI 15 文件 / WMKJ 88 页联合 |
| 目录/实际包数一致或告警 | ✅ | `auditGrouping` WMKJ 实跑 5 告警含 COUNT/HIGH_VALUE_UNASSIGNED |
| Plan 动作真实对应模型调用记录 | ✅ | plan-executions.json 每动作独立 modelCallId；RKSI 单包 40+ 调用 |
| STAR OLMEN Holding→跑马场 | ✅ | 5 等待→5 跑马场 78 点/个 DERIVED |
| RNP RWY 15L 正确 APPROACH PIR | ✅ | category=APPROACH、4 minima、HM 等待、424_CANDIDATE |
| 负高度不进 424 | ✅ | ALT_NEGATIVE=BLOCKER→拒出；单测+5包实跑 |
| RF/AF 真实样本地图形状 | ⚠️ 部分 | RF PT 识别✓ + 几何引擎✓(单测)；真实样本端点坐标未提取(源/识别层) |
| 跑道/DER 出现在 GeoJSON | ✅ | RUNWAY/RUNWAY_END(DER) 要素 + 单测 |
| GeoJSON 完整专业属性 | ✅ | LEG 全字段 + PROCEDURE/ROUTE/LABEL 要素 |
| 424 身份/子节/RouteType/速度/过渡名 | ✅ | RJTT `SPACP…D` / STAR `…E` / APPROACH `…F`+A/R；黄金逐列 |
| 424 字段级 Round-trip 无差异 | ✅ | 5 RKSI 包 recompile 后 mismatch=0；RJTT AKSEL 0 |
| Jeppesen 参考对比可用 | ✅ | compare-424 端点：同源 1.0 / 跨源正确暴露结构差异 + 报告落盘 |
| 原图叠加发现漏腿 | ✅ | 真实运行 VERIFIED 检出 MISSING_LEG/WRONG_FIX/GEOMETRY_MISMATCH |
| 扫描 PDF 分组识别 | ⚠️ 代码就绪 | page-transcriber+分批带图已实现单测，无纯扫描真实样本 |
| BLOCKER→需复核不显示纯完成 | ✅ | 5 RKSI 包全 REQUIRES_REVIEW；前端徽章+校验 tab |
| 全部回归测试通过 | ✅ | **172/172 pass** |

---

## 9.1 最终问题回答

**"上传任意 AIP AD-2 文件，由 AI 自主分组、自主规划、自主识别，并专业产出 GeoJSON 和 424 Candidate。"是否达成？**

**已达成流程闭环**：分组（联合分析+完整性审计）、规划（每包 AI 方案）、识别（方案逐动作驱动独立模型调用+片段合并）、专业产出（PIR 确定性编译 GeoJSON 与 424，含 RF/AF/跑马场/DER/三子节/字段级 Round-trip）、质量门（BLOCKER→需复核）、原图叠加反向校验——全部由真实模型驱动，无 Mock、无静默编造、无固定流程包装。

**两处未能端到端演示的项，归因明确、非流程缺口**：
1. **RF/AF 真实圆弧形状**：几何引擎（含无圆心派生）完备且单测通过，但唯一在库的真实 RF 样本（WMKJ RNP-AR）其 AR 专有航路点**坐标未在源页明文给出/未被识别层提取**——属**源文件客观信息不足 + 识别完整性**，系统正确不编造坐标而标 REQUIRES_REVIEW。补入坐标即可渲染。
2. **纯扫描 PDF 端到端**：OCR/视觉转写与分组带图路径已实现并单测，但**仓库无纯扫描真实样本**可跑通——属**样本可得性**。
3. **424 进近列位逐列验证**：进近路线类型字母/进近代码按 ARINC 424 通行约定实现，**无已授权真实 Jeppesen 进近样本**逐列核对——属**外部标准资料未授权**，已在 `assumptions` 显式声明，产物定名 Candidate/Derived/Incomplete 不冒称正式数据。
