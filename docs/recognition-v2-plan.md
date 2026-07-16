# AIP AD-2 → ARINC 424：V2 分阶段识别实施规划

状态：Phase 2 核心识别链路完成，准备进入 Phase 3  
日期：2026-07-16  
适用仓库：`procedure_recognizer`

## 1. 目标

在保留现有项目、现有 PDF/任务/地图/424 基础设施的前提下，把当前“一次整包识别”的 V1 识别内核，逐步替换为可追溯、可校验、可人工复核的 V2 分阶段流水线。

最终目标不是让模型直接生成看似完整的 424，而是：

1. 从 AIP AD-2 PDF 中发现带位置证据的航空事实候选；
2. 按明确策略融合不同来源，不静默覆盖冲突；
3. 形成唯一的规范化机场/程序中间数据；
4. 通过确定性航空规则校验；
5. 对未解决项进行人工复核；
6. 由确定性程序生成并校验 ARINC 424 数据。

## 2. 成功标准

V2 成功不能只看“最终结果像不像”，必须同时满足：

- 每个关键输出字段都能追溯到 PDF 证据，或追溯到带输入证据的确定性推导规则；
- 不确定信息可以保持未知，不以猜测换取表面完整率；
- 同一输入、同一模型/Prompt/Schema 版本能够重放和审计；
- 表格、坐标、图形和注记冲突时生成冲突记录，不自动覆盖；
- 没有 Chart 时，只要目标字段证据足够，仍可形成可用程序数据；
- V1 和 V2 可以并行运行、比较和独立回退；
- GeoJSON、程序图和 424 下游不因 V2 建设被整体重写；
- 新国家主要影响页面布局和符号解释，不改变规范中间模型和输出规则。

## 3. 本阶段明确不做

- 不重写 PDF 上传、解析、分页、图片渲染和任务管理；
- 不重写现有地图、程序图和 GeoJSON 展示；
- 不推翻现有 `ProcedureUnderstanding`，而是把它升级为 V2 的规范输出；
- 不让模型直接生成定长 ARINC 424 文本；
- 不承诺第一期覆盖全部 ARINC 424 记录类型；
- 不建立“某机场/某程序必然包含固定腿段”的特例库；
- 不用单一总体准确率代替字段、拓扑、证据和未知项指标；
- 不在 V2 未通过验收门槛前删除 V1。

## 4. 现有系统边界

### 4.1 保留并复用

- PDF 上传、多文件合并、页面解析和渲染；
- AIP 文档结构、Chart Index、页眉解析和程序包分组；
- LLM Provider、超时、重试、取消和结构化输出调用；
- Prompt 运行记录的版本和输入哈希能力；
- `ProcedureUnderstanding` 主要业务对象；
- Procedure Graph、route materializer 和比较器；
- `ProcedureUnderstanding` → GeoJSON；
- `ProcedureUnderstanding` → SimpleLegs → 424；
- Jeppesen 424 解析、比较和导出测试；
- 现有 golden case 和回归测试。

### 4.2 V1 保持冻结兼容

现有 `run-vision-recognition` 继续作为 V1 接口。除阻断性缺陷外，不再通过增加大量规则扩展 V1 Prompt。V1 的用途是：

- V2 开发期间的可用回退；
- 同一输入的 A/B 对照；
- 帮助发现 V2 初期的召回损失；
- 在 V2 达到发布门槛前维持现有功能。

### 4.3 V2 新增边界

建议新增：

```text
server/src/services/recognition-v2/
├── contracts/       # 阶段输入输出、Schema、版本
├── layout/          # 页面多角色与区域分析
├── extractors/      # 身份、表格、坐标、注记、拓扑专项抽取
├── evidence/        # 证据、候选、冲突、字段来源策略
├── fusion/          # 规范化和多来源融合
├── validation/      # 航空语义与几何规则
├── orchestration/   # 阶段调度、状态机、重试和重放
├── persistence/     # V2 独立运行记录存储
├── evaluation/      # V2 分阶段指标
└── adapters/        # V2 canonical result → 现有 ProcedureUnderstanding
```

## 5. 总体数据流

```text
ProcedurePackage（现有分组结果）
  ↓
S1 页面布局分析
  ↓
PageLayoutResult[]（多角色、区域、阅读顺序）
  ↓
S2 程序身份抽取 ─┐
S3 表格航段抽取 ─┼─→ ExtractionCandidate[] + SourceEvidence[]
S4 坐标/导航台抽取 ┤
S5 注记约束抽取 ──┤
S6 Chart 拓扑抽取 ─┘
  ↓
S7 证据融合
  ↓
CanonicalProcedurePackage + Conflict[] + UnresolvedItem[]
  ↓
S8 确定性语义/几何校验
  ↓
ValidationIssue[] + ReleaseDecision
  ↓
S9 人工复核（仅疑点）
  ↓
Approved CanonicalProcedurePackage
  ↓
现有 ProcedureUnderstanding Adapter
  ↓
现有 GeoJSON / Graph / SimpleLegs / 424
```

## 6. 核心数据模型

### 6.1 页面布局

一页允许多个角色，禁止继续使用单一互斥角色作为 V2 的事实来源。

```ts
type PageRole =
  | 'PROCEDURE_DIAGRAM'
  | 'PROCEDURE_LEG_TABLE'
  | 'WAYPOINT_COORDINATE_TABLE'
  | 'PROCEDURE_TITLE'
  | 'PROCEDURE_NOTES'
  | 'PROFILE_VIEW'
  | 'MINIMA_TABLE'
  | 'MSA'
  | 'SUPPORTING_INFORMATION'
  | 'UNKNOWN';

interface PageRegion {
  regionId: string;
  pageNo: number;
  type: PageRole;
  bbox: [number, number, number, number]; // 归一化 0..1
  rotationDeg: 0 | 90 | 180 | 270;
  readingOrder: number;
  confidence: number;
  reviewRequired: boolean;
}

interface PageLayoutResult {
  pageNo: number;
  pageRoles: PageRole[];
  regions: PageRegion[];
  missingExpectedRoles: PageRole[];
  layoutProfileId?: string;
  modelRunRef?: string;
}
```

`missingExpectedRoles` 只表示对当前专项任务可能缺资料，不得直接判定整个程序不完整。

### 6.2 证据

```ts
type EvidenceStatus = 'OBSERVED' | 'DERIVED' | 'CONFLICTED' | 'UNRESOLVED';

interface SourceEvidence {
  evidenceId: string;
  fileName: string;
  pageNo: number;
  aipPageNo?: string;
  regionId?: string;
  bbox?: [number, number, number, number];
  sourceType: PageRole | 'TEXT_LAYER' | 'DOCUMENT_METADATA';
  rawText?: string;
  visualDescription?: string;
  extractionTask: ExtractionTaskType;
  confidence: number;
  status: EvidenceStatus;
  modelRunRef?: string;
}
```

证据只描述“原文件中看到了什么”。归一化值和航空结论属于候选或推导结果，不反写原始证据。

### 6.3 字段候选

```ts
interface FieldCandidate<T = unknown> {
  candidateId: string;
  entityType: 'AIRPORT' | 'RUNWAY' | 'FIX' | 'NAVAID' | 'PROCEDURE' | 'LEG' | 'CONSTRAINT' | 'TOPOLOGY';
  entityKey: string;
  fieldName: string;
  value: T | null;
  normalizedValue?: T | null;
  unit?: string;
  status: EvidenceStatus;
  sourceEvidenceIds: string[];
  derivation?: {
    ruleId: string;
    ruleVersion: string;
    inputCandidateIds: string[];
  };
  confidence: number;
  reviewRequired: boolean;
}
```

约束：

- `OBSERVED` 必须至少引用一条原始证据；
- `DERIVED` 必须记录规则 ID、规则版本和全部输入候选；
- 没有证据或合法推导链的非空值不得进入 canonical 层；
- confidence 只是排序线索，不是正确性的证明。

### 6.4 冲突和未解决项

```ts
interface EvidenceConflict {
  conflictId: string;
  entityKey: string;
  fieldName: string;
  candidateIds: string[];
  severity: 'INFO' | 'WARNING' | 'BLOCKING';
  selectedCandidateId?: string;
  selectionReason?: string;
  resolution: 'AUTO_RESOLVED' | 'HUMAN_RESOLVED' | 'OPEN';
}

interface UnresolvedItem {
  unresolvedId: string;
  entityKey: string;
  fieldName: string;
  reasonCode: string;
  candidateIds: string[];
  requiredEvidence?: string;
  blockingFor424: boolean;
}
```

### 6.5 Canonical 层

Canonical 层代表“当前系统认可的唯一业务值”，但仍不等于已批准发布。

要求：

- 每个关键字段具有 `fieldEvidence`；
- 保留字段是观察值还是推导值；
- 保留未解决字段，不使用占位值伪装完整；
- 不包含页面布局特例；
- 不包含定长 424 字符串；
- 可通过 Adapter 转换为现有 `ProcedureUnderstandingResult`。

第一期不立刻把现有扁平字段全部改成 `{ value, evidence }`，而是在实体上增加兼容字段：

```ts
interface FieldProvenance {
  selectedCandidateId?: string;
  sourceEvidenceIds: string[];
  status: EvidenceStatus;
  confidence: number;
}

interface CanonicalLeg {
  // 继续保留现有扁平业务字段
  sequence: number;
  pathTerminator: string | null;
  fixIdentifier: string | null;
  // ...
  fieldEvidence: Record<string, FieldProvenance>;
}
```

## 7. 各阶段职责与硬边界

### S1 页面布局分析

输入：页面缩略图/全图、可用文本层、文档元数据。  
输出：`PageLayoutResult`。  
只做：角色、区域、边界、旋转、阅读顺序。  
禁止：生成程序腿、推断 Path Terminator、生成程序完整性结论。

验收重点：区域召回优先于像素级精确边界；区域必须足够覆盖内容且不能错误裁掉列名/行首。

### S2 程序身份抽取

输入：标题、页眉、表格标题、目录匹配和相关文本区域。  
输出：机场、程序类型、程序名、跑道、版本、生效日期、导航规范、过渡候选。  
禁止：把醒目的 waypoint、transition 名或五字码自动当程序名。

优先使用确定性页眉/目录解析；只有规则无法解析时才调用模型。

### S3 表格航段抽取

输入：`PROCEDURE_LEG_TABLE` 区域及其高分辨率裁剪。  
输出：逐行原始单元格、字段候选、行/列位置证据。  
禁止：利用 Chart 想象缺失的表格行；禁止为了完整强制填写 Path Terminator。

表格抽取分两层：

1. 视觉/文本层恢复行列和原始值；
2. 航空语义层将原始列映射成候选字段。

两层结果分别存储，便于发现是 OCR 错误还是语义映射错误。

### S4 坐标和导航台抽取

输入：坐标表、导航台表、跑道表及相关正文。  
输出：Fix/Navaid/Runway 候选和原始坐标证据。  
禁止：从 Chart 上的相对位置直接估算经纬度作为正式坐标。

坐标格式解析、DMS/DM/十进制度转换由确定性程序完成；模型只负责识别原始字符串和列语义。

### S5 注记约束抽取

输入：注记、正文、profile、minima 等相关区域。  
输出：高度、速度、设备、ATC、运行限制候选，以及作用域候选。  
必须区分“某一腿”“某一过渡”“整个程序”“仅背景说明”的作用域；无法确定作用域时标记未知。

### S6 Chart 拓扑抽取

输入：程序主图区以及必要的高分辨率裁剪。  
输出：节点连接、分支、汇合、公共航段、过渡、Holding、DME Arc、RF、Vector、Missed Approach 等拓扑候选。  
禁止：直接输出最终 GeoJSON；禁止用像素位置覆盖正式坐标表；禁止重复生成完整程序对象。

Chart 是拓扑和特殊几何的重要证据，但不是所有字段的默认最高权威。

### S7 证据融合

输入：所有候选、证据和字段来源策略。  
输出：Canonical、Conflict、Unresolved。  
融合器优先使用确定性规则；只有关系消歧确实需要语义判断时才允许调用模型，且模型只能在已有候选中选择或返回未知，不得创造新候选。

### S8 确定性校验

至少包括：

- 程序身份与机场/跑道引用有效；
- 腿段序号、顺序和唯一性；
- 相邻腿连接和 Transition/Common Route 连通；
- 高度上下限不冲突；
- 坐标反算的航向/距离与公布值在容差内；
- DME Arc 有中心台、半径或等价几何依据；
- RF 有半径、转向和足够几何依据；
- Holding 有定位点、入航航向和转向；
- Missed Approach 起点和连接合理；
- 引用的 Fix/Navaid/Runway 存在；
- 关键字段证据完整；
- 表格、正文和 Chart 冲突已记录；
- 424 必填字段缺失时阻止发布。

规则输出结构化 `ValidationIssue`，不得只输出自由文本。

### S9 人工复核

只展示：

- blocking validation issue；
- 未解决关键字段；
- 来源冲突；
- 低置信度关键候选；
- 模型推导且风险较高的 Path Terminator/拓扑关系。

人工决定必须形成新的审核记录，不能修改或删除原始证据。

## 8. 字段来源策略

策略是默认优先级，不是无条件覆盖：

| 字段 | 首选来源 | 备选/联合来源 |
|---|---|---|
| 程序名称、版本 | 正式标题、目录 | 页眉、表格标题 |
| 跑道适用范围 | 正式标题、程序表 | Chart、正文 |
| 腿段顺序、Fix | 程序表 | 正文、Chart 拓扑 |
| 坐标 | 坐标表、跑道表、导航台表 | 正文；Chart 不作为正式坐标 |
| Course、Distance | 程序表 | 正文、Chart 标注、坐标反算校验 |
| Altitude、Speed | 程序表 | 注记、正文、Chart |
| Turn Direction | 程序表 | Chart 拓扑 |
| 分支、汇合、公共航段 | 表格分组 + Chart 联合 | 正文 |
| DME Arc/RF/Holding | 表格 + Chart + 导航台联合 | 正文 |

自动选择必须同时满足：来源允许、证据存在、规范化成功、没有 blocking 冲突、规则校验通过。

## 9. 反幻觉硬规则

这些规则应同时落实到 Schema、Prompt、融合器和测试中，而不是只写在 Prompt：

1. **证据门禁**：非空 canonical 关键字段必须有证据或完整推导链。
2. **未知优先**：证据不足时输出 `UNRESOLVED`，不得使用最可能值填空。
3. **候选封闭**：融合消歧模型只能选择已有候选或返回未知。
4. **观察/推导分离**：模型观察到的原文与规则推导出的值不能混为一条证据。
5. **冲突不可覆盖**：不同来源不一致必须留下冲突记录。
6. **支持资料隔离**：背景导航台/航路点只有被程序明确引用时才能进入程序对象。
7. **程序包边界**：不得从相邻程序包借用腿段补齐当前程序。
8. **例子隔离**：few-shot 中的机场、Fix、数值不得进入当前结果；保留现有通用性测试。
9. **失败不降级**：Schema 或关键校验失败时，不用非法结果覆盖上一版有效 canonical。
10. **发布门禁**：`reviewRequired=false` 不能由模型单独决定，由确定性规则和人工状态共同决定。
11. **可重复性**：每个阶段记录输入哈希、模型、Prompt、Schema、规则版本和输出。
12. **无静默修复**：Normalizer 若修补模型结果，必须生成 `DERIVED` 候选、规则 ID 和复核标记。

## 10. V2 编排与状态机

V2 不复用单一 `AI_RUNNING/AI_COMPLETED` 表达全部状态，新增独立运行状态：

```ts
type V2RunStatus =
  | 'CREATED'
  | 'LAYOUT_RUNNING'
  | 'EXTRACTION_RUNNING'
  | 'FUSION_RUNNING'
  | 'VALIDATION_RUNNING'
  | 'REVIEW_REQUIRED'
  | 'APPROVED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';
```

每个阶段拥有独立状态、尝试次数、输入哈希和错误。重跑单一阶段时：

- 输入哈希相同可复用已验证输出；
- 上游输出改变时，自动使依赖的下游阶段失效；
- 失败不删除旧结果；
- 支持取消整个 run 或单个模型调用；
- 服务重启后根据阶段状态恢复为可重试状态。

## 11. 存储策略

当前 `task.json` 已可能达到数十 MB。V2 的区域、证据、候选和阶段原始响应不能全部继续嵌入其中。

建议：

```text
server/data/procedure-tasks/<taskId>/
├── task.json                         # 现有任务 + V2 轻量摘要/引用
└── recognition-v2/<packageId>/<runId>/
    ├── manifest.json                 # 状态、版本、输入哈希、阶段索引
    ├── layout.json
    ├── identity-candidates.json
    ├── table-candidates.json
    ├── waypoint-candidates.json
    ├── notes-candidates.json
    ├── topology-candidates.json
    ├── evidence.json
    ├── fusion.json
    ├── validation.json
    ├── review.json
    └── canonical.json
```

文件写入继续采用临时文件 + rename 的原子发布方式。`task.json` 只保存：活动 runId、状态、摘要指标、canonical 引用和最后错误。

第一期继续使用文件存储，不提前引入数据库；当并发写入或查询成为实际瓶颈后再迁移。

## 12. API 规划

保留 V1 API，新增 `/recognition-v2` 命名空间：

```text
POST /tasks/:taskId/packages/:packageId/recognition-v2/runs
GET  /tasks/:taskId/packages/:packageId/recognition-v2/runs/:runId
POST /tasks/:taskId/packages/:packageId/recognition-v2/runs/:runId/stages/:stage/run
POST /tasks/:taskId/packages/:packageId/recognition-v2/runs/:runId/cancel
GET  /tasks/:taskId/packages/:packageId/recognition-v2/runs/:runId/evidence
GET  /tasks/:taskId/packages/:packageId/recognition-v2/runs/:runId/conflicts
POST /tasks/:taskId/packages/:packageId/recognition-v2/runs/:runId/reviews
POST /tasks/:taskId/packages/:packageId/recognition-v2/runs/:runId/approve
POST /tasks/:taskId/packages/:packageId/recognition-v2/runs/:runId/publish-canonical
```

`publish-canonical` 只负责通过 Adapter 更新现有 `group.procedureUnderstanding`，从而复用现有 GeoJSON/Graph/424 链路。未达到发布门禁时返回结构化阻断原因。

## 13. 评测设计

### 13.1 分阶段指标

- 页面角色 precision/recall；
- 区域检测 recall 和内容裁切完整率；
- 程序身份准确率；
- 表格行召回率、行顺序准确率、单元格准确率；
- Fix/坐标召回率和坐标误差；
- 腿段召回率和额外腿率；
- Path Terminator、Course、Distance、Altitude、Speed 字段准确率；
- 分支/汇合/公共航段拓扑准确率；
- DME Arc/RF/Holding 识别准确率；
- 字段证据覆盖率；
- 无证据非空字段数（目标必须为 0）；
- 冲突检出率；
- 未知项 precision：被系统标记未知的项是否确实证据不足；
- 错误自信率：错误且未要求复核的关键字段比例；
- 424 可编码率和 round-trip 一致率。

### 13.2 数据集分层

至少包含：

- 已见版式同机场回归集；
- 已见国家不同机场集；
- 未见国家/未见版式集；
- 表格完整但 Chart 缺失；
- Chart 存在但坐标表缺失；
- 同页混合表格和航图；
- 多跑道分支、多航路过渡；
- DME Arc、RF、Holding、Vector、Missed Approach；
- 人工构造的来源冲突和低分辨率样例。

机场/程序级数据必须整体划分训练提示调试集与最终验收集，防止同一机场的相似程序泄漏到两边。

### 13.3 发布门槛

第一期门槛建议：

- 无证据关键字段数 = 0；
- blocking 校验问题 = 0 才能发布；
- Schema 校验 100%；
- 已批准 canonical → 424 导出不得抛出未知编码错误；
- 424 导出后解析 round-trip 的已支持字段一致率 100%；
- 新版式测试不得依赖机场专属 Prompt 规则；
- V1 已通过的下游 GeoJSON/424 回归不得因 V2 接入下降。

具体业务准确率阈值在建立至少三个机场的人工标注基准后确定，禁止在样本不足时拍脑袋承诺百分比。

## 14. 实施阶段

### Phase 0：冻结基线与契约（核心交付已完成）

交付：

- 本规划文档和架构决策；
- V1 基线测试报告；
- V2 支持范围清单；
- 首批 golden cases 清单；
- 字段字典、来源矩阵、校验规则清单；
- `recognition-v2/contracts` 的 TypeScript 类型和 JSON Schema 草案。

退出条件：业务对象、证据状态、未知/冲突含义不再存在重大歧义。

### Phase 1：V2 骨架和持久化（已完成）

交付：

- V2 run/stage 状态机；
- 独立文件存储和原子写入；
- 创建、读取、取消、单阶段重跑 API；
- 运行 manifest、输入哈希和版本记录；
- 空实现阶段能够完整走通但不能发布。

退出条件：不调用模型也能验证状态流转、失败恢复、下游失效和 V1 隔离。

完成记录：

- 建立显式阶段依赖图和纯状态机；
- 支持 `PENDING/RUNNING/COMPLETED/SKIPPED/FAILED/CANCELLED/STALE`，不适用阶段必须携带 `skipReason`；
- 上游重跑自动使所有依赖的下游结果失效，独立兄弟阶段保持有效；
- 建立 `recognition-v2/<packageId>/<runId>` 独立目录、原子 JSON 写入和进程内并发更新队列；
- 运行清单在读取和写入时执行 JSON Schema 校验；
- `task.json` 仅保存活动 run 的状态、来源哈希和 manifest 引用；
- 来源哈希只覆盖程序包输入，不受 V1/V2 输出和任务时间戳影响；
- 提供创建、列举、读取、取消和阶段运行 API 骨架；
- Phase 1 没有阶段执行器，运行阶段 API 明确返回 `501 V2_STAGE_EXECUTOR_NOT_AVAILABLE`，不得写空输出或伪造完成状态；
- 服务启动时把被重启中断的运行阶段恢复为带 `SERVICE_RESTARTED` 的可重试失败，并同步轻量摘要；
- HTTP 测试确认 API 不会在执行器缺失时改变阶段状态。

### Phase 2：页面布局 + 程序身份（核心识别链路已完成）

交付：

- 多角色页面和区域 Schema；
- 规则优先、模型补充的身份抽取；
- 动态区域裁剪；
- 布局和身份 golden cases；
- 页面区域人工检查视图的最小版本。

退出条件：混合页面不再被强制归为单角色；程序名不从 waypoint/transition 猜测。

完成记录：

- 页面可同时具有多个角色，区域使用归一化坐标、旋转角度、阅读顺序、置信度和复核标记；
- `PAGE_LAYOUT` 支持纯规则运行，以及“规则提示 + 视觉模型补充”的混合运行；
- 动态裁剪按模型/规则返回的任意合法区域执行，不依赖固定版式名称；
- `PROCEDURE_IDENTITY` 优先使用页眉和已有确定性解析，视觉模型只读取已验证的 `PROCEDURE_TITLE` 裁剪区域；
- procedure、transition 和醒目的 waypoint 保持为不同字段，模型候选不会覆盖规则候选；
- 模型观察必须引用本次实际提供的 page/region，证据记录源文件、页码、AIP 页码、区域和 bbox；
- 两个阶段均接入 V2 API、取消信号、Schema 校验、阶段依赖和独立 artifact 存储；
- 每次重跑使用带 attempt 编号的输出和审计文件，不覆盖历史证据；下游输入哈希包含上游 artifact 指纹；
- V2 Prompt 已纳入机场特例静态检查；当前仍不写入 `group.procedureUnderstanding`，不影响 V1、地图和 424；
- 人工检查界面不在本次识别内核切片中实现，先通过 artifact API 保留完整检查数据，在 Phase 6 统一建设审核界面。

### Phase 3：表格 + 坐标专项抽取

首批业务范围优先选择有正式 coding/leg table 和坐标表的 RNAV SID/STAR。

交付：

- 表格物理结构结果；
- 表格航空语义候选；
- 坐标/导航台/跑道抽取；
- 确定性坐标格式解析；
- 字段级证据；
- 无 Chart 条件下的 canonical 草案。

退出条件：模型不看 Chart 也能对受支持表格生成带证据的腿段候选；未知字段保持 null/UNRESOLVED。

### Phase 4：融合 + 确定性校验

交付：

- 字段来源策略引擎；
- candidate 选择、冲突和 unresolved；
- `procedureSemanticValidator`；
- 几何反算校验；
- canonical → 现有 `ProcedureUnderstanding` Adapter；
- V1/V2 字段对比报告。

退出条件：无证据字段不能进入 canonical；冲突不静默覆盖；已通过 canonical 可走通现有 GeoJSON 和 424。

### Phase 5：Chart 拓扑专项抽取

交付：

- 图节点/边候选；
- 跑道过渡、公共航段、航路过渡；
- 分支和汇合；
- DME Arc、RF、Holding、Vector、Missed Approach；
- Chart 与表格差异报告。

退出条件：Chart 只补充/验证拓扑和特殊几何，不直接描出最终正式坐标航迹。

### Phase 6：人工复核与发布门禁

交付：

- 证据区域截图；
- 字段候选对比；
- 冲突/未知/校验问题列表；
- 人工决议审计记录；
- approve/publish canonical；
- V2 结果驱动现有地图和 424。

退出条件：审核者无需通读所有 PDF，即可定位和处理所有阻断项。

### Phase 7：扩展程序类型和规模化评测

按顺序扩展：

1. RNAV SID/STAR；
2. 常规 SID/STAR 与 DME Arc；
3. ILS/LOC/VOR/NDB Approach；
4. RNP/RNP AR、RF；
5. Holding、Vector 和复杂 Missed Approach；
6. 更多 424 记录类型。

每扩展一类，必须增加独立 golden case 和规则，不得只增加 Prompt 文本。

## 15. 首批开发切片

第一批代码严格限制为“地基”，不接真实模型 Prompt：

1. 创建 `recognition-v2/contracts`；
2. 定义 `V2RunManifest`、`StageRun`、`PageLayoutResult`、`SourceEvidence`、`FieldCandidate`、`Conflict`、`Unresolved`、`ValidationIssue`；
3. 创建 V2 独立存储；
4. 创建状态机和阶段依赖图；
5. 创建 API 骨架；
6. 增加状态、原子写入、重跑失效、V1 隔离测试；
7. 不修改 `group.procedureUnderstanding`；
8. 不修改 GeoJSON 和 424 行为。

完成这一切片后再实现页面布局分析。这样可以先固定“模型必须服从的协议”，避免边写 Prompt 边改变数据含义。

## 16. 每个开发任务的完成定义

任何 V2 任务必须同时满足：

- 输入/输出有版本化 Schema；
- 有正常、未知、冲突、非法输入测试；
- 有至少一个非当前机场样例；
- 不包含机场/具体程序硬编码；
- 所有自动推导有 rule ID；
- 原始证据不可被 normalizer 覆盖；
- 错误不会覆盖上次有效结果；
- 能单独重跑并正确使下游失效；
- 有分阶段指标，不只观察最终地图；
- 文档同步更新。

## 17. 风险和控制措施

| 风险 | 控制措施 |
|---|---|
| 多次模型调用导致成本/延迟上升 | 区域路由、文本规则优先、阶段缓存、只对复杂 Chart 启用高分辨率任务 |
| Schema 过度复杂 | 原始证据、候选、canonical 分层；第一期使用兼容型 `fieldEvidence` |
| V2 与 V1 结果互相污染 | 独立 run 存储；仅 `publish-canonical` 明确写入现有结果 |
| `task.json` 继续膨胀 | V2 大对象独立文件存储，任务只保存引用和摘要 |
| Prompt 继续堆积国家特例 | 版式档案只描述区域/阅读顺序/符号别名；通用性静态测试 |
| 模型给出虚假高置信度 | confidence 不作为证据门禁；规则、冲突和人工审批独立判断 |
| 下游 normalizer 静默补数据 | 所有补值转为带 rule ID 的 DERIVED candidate |
| 424 “能导出”被误当成“业务正确” | 导出前语义校验；字段级准确率、拓扑准确率和 round-trip 分开评估 |

## 18. 当前基线记录

Phase 0 开始前执行 `npm test`：

- 总测试：138；
- 通过：137；
- 失败：1；
- 已知失败：`procedureGraph.test.ts` 中“DF 未公布距离不应惩罚 AI”的距离比较断言。

该失败在 V2 实施前已经存在。根因是通用数值转换使用 `Number(null)`，把“未公布距离”错误转换为 `0`。Phase 0 已修复程序图构建器和规范化器中的同类问题。

Phase 0 完成后的干净基线：

- 总测试：144；
- 通过：144；
- 失败：0；
- 服务端 TypeScript 检查通过；
- 前端生产构建通过；
- 新增 6 项 V2 契约测试，覆盖 Schema 编译、正常阶段对象，以及无证据观察值、无规则推导值、未复核未知值、空证据和非法版本/区域的拒绝行为。

Phase 1 完成后的干净基线：

- 总测试：156；
- 通过：156；
- 失败：0；
- 新增状态机、显式跳过、下游失效、失败重试、取消、独立存储、并发更新、路径安全、重启恢复、来源哈希和真实 HTTP API 骨架测试；
- 服务端 TypeScript 检查通过；
- 前端生产构建通过。

Phase 2 核心识别链路完成后的干净基线：

- 总测试：163；
- 通过：163；
- 失败：0；
- 新增多角色页面、模型布局合并、任意区域裁剪、身份隔离、模型证据保留、非法模型输出审计、越权区域拒绝和真实 API 重跑审计测试；
- TypeScript 检查和前端生产构建通过；
- V1、GeoJSON、程序图、424 解析/比较/导出回归全部通过。

Phase 0 已交付：

- `recognition-v2/contracts/index.ts`：版本化 TypeScript 契约；
- `recognition-v2/contracts/schemas/`：运行清单、页面布局、专项抽取、融合、校验五类阶段 Schema 及公共定义；
- 每类阶段输出记录其实际 Schema ID；
- Schema 级证据、推导链和未知复核门禁；
- 干净 V1/V2 回归基线。

## 19. 防止项目走偏的决策检查表

每次准备新增功能或 Prompt 规则前，依次回答：

1. 这是页面版式问题、证据提取问题、航空语义问题，还是输出编码问题？
2. 它应该由模型、确定性规则、融合器还是人工处理？
3. 能否在不引用具体机场/程序名的情况下表达？
4. 输出值是否有原始证据或可审计推导链？
5. 证据冲突时系统是否会保留双方而不是覆盖？
6. 证据不足时能否安全输出未知？
7. 是否有独立阶段测试和未见机场测试？
8. 是否会破坏 V1 或现有 GeoJSON/424？
9. 是否需要真正新增 424 能力，还是只是在让结果“看起来更完整”？

任一关键问题无法回答时，不进入实现。

## 20. 下一步

下一步进入 Phase 3，依次完成：

1. 冻结首批 RNAV SID/STAR 表格和坐标字段字典；
2. 将表格物理结构恢复与航空语义映射拆成两个可独立审计的步骤；
3. 实现 `PROCEDURE_TABLE` 和 `WAYPOINT_NAVAID` 专项执行器；
4. 用确定性程序解析 DMS/DM/十进制度数和常见高度、航向、距离格式；
5. 对每个原始单元格和字段候选保留 page/region/bbox 证据；
6. 建立开发、回归和盲测机场分层数据集；
7. 继续保持 `group.procedureUnderstanding`、GeoJSON 和 424 输出不变，直到融合与校验阶段通过发布门禁。
