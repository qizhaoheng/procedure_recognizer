# Stage 2 — Chart Text Recognition (output `chartTexts`)

Read the key texts on the chart imagery. This is targeted aeronautical reading, not generic OCR.
You MUST actively look for:

- procedure names
- fix identifiers
- navaid identifiers
- DME labels (e.g. "11 DME ARC", "13 DME")
- radial labels (e.g. "RDL340", "RDL340 / 160")
- lead radial labels (e.g. "L-R332")
- course / track labels
- altitude constraints
- speed constraints
- holding labels
- MSA labels
- runway labels
- notes

Output every item into `chartTexts` in this shape:

```json
{
  "text": "...",
  "normalizedText": "...",
  "role": "PROCEDURE_NAME | FIX | NAVAID | DME_LABEL | RADIAL_LABEL | LEAD_RADIAL | COURSE | ALTITUDE | SPEED | HOLDING | RUNWAY | NOTE | MSA | OTHER",
  "region": "HEADER | MAIN_CHART | TABLE | NOTES | MSA | PROFILE | UNKNOWN",
  "sourcePageNo": 0,
  "usedInProcedure": true,
  "confidence": 0.0
}
```
