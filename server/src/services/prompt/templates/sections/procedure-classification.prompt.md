# Stage 1 — Procedure Classification (mandatory, before anything else)

Before extracting any content, you MUST decide what you are looking at and output
`procedureClassification` with:

- packageType: SID / STAR / APPROACH
- procedureCategory: DEPARTURE / ARRIVAL / APPROACH
- navigationType: RNAV / RNP / DME_ARC / ILS / VOR / NDB / RADAR / CONVENTIONAL
- runway (the primary/summary runway only; it must not limit extraction when the package contains multiple runway variants)
- procedureNames: every procedure name printed on the chart
- chartPurpose: one sentence describing what this chart is for
- confidence

If you cannot classify the chart, you must explain why in `warnings`,
set confidence low, and set reviewRequired=true. Never leave the classification silently empty.

Classification is a package summary, not an extraction filter. After classification, inspect every supplied
page and retain all runway variants and named transitions in `procedures` and `tableLegs`.
