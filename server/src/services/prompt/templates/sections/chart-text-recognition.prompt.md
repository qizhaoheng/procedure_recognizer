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

For SID charts, also actively look for:
- DER / runway-end references
- runway track labels, e.g. `TRACK 160`, `TRACK 340`, `RWY HDG`
- DME turn or climb triggers, e.g. `0.5 DME VJB`, `2.6 DME VJB`, `5.7 DME VJB`
- ATC/radar instructions, e.g. `turn to assigned heading`, `radar`, `as directed by ATC`
- climb gradients and minimum climb requirements
- speed restrictions in turns
- transition altitude and communication frequencies when printed on the procedure chart
- header transition-altitude boxes exactly, e.g. output `TRANSITION ALTITUDE 11000FT` as an
  `ALTITUDE` chartText in the `HEADER` region; this value may be used as Jeppesen 424 Alt2 on
  the first SID CA leg

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
