# Support Filtering (output `supportObjects`)

Supporting pages are context, NOT content of the current procedure.

An object coming from supporting pages may have usedInProcedure=true ONLY when at least one holds:
1. The chart imagery explicitly shows that ident.
2. The tabular description explicitly references that ident.
3. The current procedure type structurally depends on that object
   (e.g. the VOR/DME a DME ARC is flown around).
4. The current geometry semantics need it as a center or reference.

Examples:
- In a DME ARC STAR, the VOR/DME that is the center of the DME arc has usedInProcedure=true.
- If an NDB exists only in the AD 2.19 supporting page and does not appear on the current
  chart or table, that NDB has usedInProcedure=false and supportOnly=true.
- An ILS/LOC ident belongs to an ILS/LOC approach. When the current procedure is not
  an ILS/LOC approach, it must NOT be treated as a primary procedure object.

List EVERY candidate ident you considered from supporting pages in `supportObjects`:

```json
{
  "ident": "...",
  "type": "NAVAID | RUNWAY | AIRPORT | COMMUNICATION | OTHER",
  "usedInProcedure": true,
  "supportOnly": false,
  "reason": "...",
  "confidence": 0.0
}
```

An ident with usedInProcedure=false must NOT appear in `navaids`, `fixes` or any procedure leg.
