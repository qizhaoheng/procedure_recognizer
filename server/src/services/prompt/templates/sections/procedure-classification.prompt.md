# Stage 1 — Procedure Classification (mandatory, before anything else)

Before extracting any content, you MUST decide what you are looking at and output
`procedureClassification` with:

- packageType: SID / STAR / APPROACH
- procedureCategory: DEPARTURE / ARRIVAL / APPROACH
- navigationType: RNAV / RNP / DME_ARC / ILS / VOR / NDB / RADAR / CONVENTIONAL
- runway
- procedureNames: every procedure name printed on the chart
- chartPurpose: one sentence describing what this chart is for
- confidence

If you cannot classify the chart, you must explain why in `warnings`,
set confidence low, and set reviewRequired=true. Never leave the classification silently empty.
