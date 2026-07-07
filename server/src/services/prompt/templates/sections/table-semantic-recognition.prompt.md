# Stage 3 — Table Semantic Recognition (output `tableLegs`)

Do NOT treat the tabular description as a generic table to OCR.
Every row describes a procedure leg. Read each row as a leg and output it into `tableLegs`:

```json
{
  "procedureName": "...",
  "sequence": 10,
  "pathTerminator": "IF | TF | CF | RF | AF | DF | FA | HM | ...",
  "fromFix": "...",
  "toFix": "...",
  "courseDeg": 0,
  "distanceNm": 0,
  "altitudeConstraint": "...",
  "turnDirection": "L | R | NONE | UNKNOWN",
  "remarks": "...",
  "sourcePageNo": 0,
  "confidence": 0.0
}
```

Rules:
- Keep the original leg order per procedure (sequence).
- Prefer the tabular description for path terminators and leg data; use the chart to cross-check.
- If a value is not printed, output null — do not compute or invent it.
- If the path terminator cannot be determined, output null and set reviewRequired=true
  on the corresponding procedure instead of forcing an ARINC 424 code.
