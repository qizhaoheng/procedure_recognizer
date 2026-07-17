# Recognition V2 Phase 5.1：真实拓扑 Golden Case

## 目标

Phase 5.1 不继续堆 Prompt，而是先固定“什么叫识别正确”。每一类复杂航迹都必须有真实 AIP 页、人工复核证据、预期拓扑和防猜测断言。Golden case 只用于验收，机场名和程序名不得进入生产规则。

## 已加入的六类基准

| 类型 | 真实样例 | 核心真值 | 主要防错点 |
|---|---|---|---|
| DME Arc | WMKJ RWY 16，ADLOV/EMTUV/PIMOK/OMKOM 1G | VJB 为圆心、11 NM 半径、各入口转向和 RDL340 公共出口 | 不能把普通曲线当 DME Arc；不能丢圆心/半径 |
| RF | VHHH BEKOL 1X | PORPA→HH341、HH341→HH342 两个 RF；中心 HH941/HH942；半径 2.656/3.246 NM；均右转 | 不能只识别成“ARC”而丢 RF 专项几何 |
| Holding | WSSS RNP RWY 02L | AKOMA 左等待，入航 176°、出航 356°、1 分钟、最低 4000 ft | 等待航线不能被误当普通闭环或普通 Track |
| Vector | WSSS ASUNA 2B | NYLON 后为公开的雷达引导边，但下游点未公布 | `toIdentifier` 必须保持 `null`，禁止猜成跑道或进近点 |
| Missed Approach | WSSS RNP RWY 02L | MAPT RW02L→ENSUN→AKOMA，并在 AKOMA 进入等待 | 复飞边不能混入正常进近主链 |
| 多分支汇合 | WMKJ 四条 RWY 16 STAR | 四个入口通过公共 11 DME Arc 汇合到 RDL340 VJB，再去 OSRUP | 必须保留多入口与公共出口，不能压平成单一路线 |

## 已实现的验收基础设施

- 新增版本化 `recognition-v2-topology-golden-case.schema.json`；
- 每个 case 都保存来源机构、文件名、PDF SHA-256、真实页码、AIP 页码和人工复核时间；
- 统一评估器检查节点、边、特殊几何、分支/汇合和必须未知字段；
- 本地存在原 PDF 时自动复核 SHA-256，防止同名 PDF 被悄悄替换；
- 模型拓扑契约允许 Vector 的未知终点使用 `null + openEnded=true`；
- RF 表格单元格支持通用解析 `RF Centre/Center + identifier + r=... NM`，不包含 VHHH/BEKOL 硬编码；
- 拓扑边保留 Path Terminator、中心点、半径、距离、航向和转向等专项字段，不只保留起终点。

## 当前边界

Golden case 建立代表“验收尺子已经固定”，不代表六类在所有 PDF 上都已达到生产准确率。当前线性 RNAV 表格链已通过真实运行；DME Arc、Holding、Vector、Missed Approach 和跨程序汇合仍需逐 case 跑真实 V2 stage、记录失败原因，再补通用规则或模型观察能力。

任何后续修改如果让 Vector 自动出现一个 PDF 未公布的终点，或丢失 RF/DME Arc 的中心与半径，回归测试必须失败。
