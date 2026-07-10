# Stage 3 - Table Semantic Recognition (output `tableLegs`)

Do NOT treat the tabular description as a generic table to OCR.
Every row describes a procedure leg. Read each row as a leg and output it into `tableLegs`:

```json
{
  "procedureName": "...",
  "sequence": 10,
  "pathTerminator": "IF | TF | CF | RF | AF | DF | FA | HM | CA | CI | CR | ...",
  "fromFix": "...",
  "toFix": "...",
  "courseDeg": 0,
  "distanceNm": 0,
  "altitudeConstraint": "...",
  "turnDirection": "L | R | NONE | UNKNOWN",
  "recommendedNavaid": "...",
  "remarks": "...",
  "sourcePageNo": 0,
  "confidence": 0.0
}
```

Rules:
- Keep the original leg order per procedure (sequence).
- Prefer the tabular description for path terminators and leg data; use the chart to cross-check.
- If a value is not printed, output null; do not compute or invent it.
- If the path terminator cannot be determined, output null and set reviewRequired=true
  on the corresponding procedure instead of forcing an ARINC 424 code.

SID-specific table rules:
- Treat departure tables as leg coding instructions. Do not collapse a multi-row SID into one summary.
- CA means course/track to altitude; it often has no named toFix. Keep the course and altitude even when
  toFix is null.
- CI means course/track to intercept; preserve the intercept target in remarks when it is a radial,
  navaid, or assigned course rather than a named fix.
- CR means course to radial intercept; preserve the radial and center navaid in remarks and
  recommendedNavaid.
- CF means course to a fix or DME/radial-defined fix; preserve both course and terminating reference.
- DF means direct to a fix; output the target fix and any printed distance.
- TF means track between named fixes; avoid using TF for runway heading to altitude/DME instructions.
- For DME-triggered legs, put the DME value and navaid ident in remarks, e.g. `5.7 DME VJB`.
- Fill recommendedNavaid when the row/chart references a navaid used for course, radial, DME, or
  climb-condition checking.
