Decide the ARINC 424 encoding for this procedure.

Airport:
{{airport}}

Procedure Information Record:
{{pir}}

Encoding context (airport region, prior conventions observed in this document set — advisory, not authoritative):
{{encodingContext}}

## Field notes

These describe how the renderer consumes your values, so that what you decide survives into the record:

- `procedureCode` is the identifier that appears in the record; for SID/STAR it is normally the six-character route code derived from the procedure name, for approaches it is the approach code.
- `runway` uses the `RWnn[L|C|R]` form. A leg belongs to either a runway or a named `transitionName`, never both.
- `altitudeValue` is a positive number of feet; express "at or below" through `altitudeSign` set to `-`, never by making the number negative.
- `courseDegMag` is degrees magnetic; the renderer scales it. `distanceNm` is nautical miles.
- `fixSection` distinguishes an en-route waypoint from a terminal one when you need to state it.
- `endOfProcedure` marks the final leg of a route; `holdingAtFix` marks a fix that carries a holding pattern.
