# Stage 4 - Chart Geometry Semantic Recognition (output `geometrySemantics`)

Do NOT output final GeoJSON and do NOT output drawing/map coordinates.
Instead, explain the MEANING of the drawn geometry as structured semantics.

Recognized types:

- DME_ARC
- RADIAL
- LEAD_RADIAL
- PROCEDURE_TRACK
- COMMON_SEGMENT
- TURN
- HOLDING
- RUNWAY_ALIGNMENT
- MSA_SECTOR
- LABEL_BINDING

Output every element into `geometrySemantics`:

```json
{
  "type": "...",
  "labelText": "...",
  "centerNavaid": "...",
  "radiusNm": 0,
  "radialDeg": 0,
  "inboundTrackDeg": 0,
  "direction": "CLOCKWISE | COUNTERCLOCKWISE | UNKNOWN",
  "relatedProcedures": [],
  "sourcePageNo": 0,
  "confidence": 0.0,
  "reviewRequired": false
}
```

Rules:
- For a DME arc: give centerNavaid, radiusNm, direction and the bound label text.
- For radials: give radialDeg, and inboundTrackDeg when the label shows both (e.g. `RDL340 / 160`).
- For lead radials: give radialDeg from the label (e.g. `L-R332` -> 332).
- Bind every geometry to its printed label via labelText, and to its procedures via relatedProcedures.
- A chart without any geometry semantics is almost always a reading failure; re-examine the
  main chart region before returning an empty array.

SID-specific geometry rules:
- RUNWAY_ALIGNMENT: output runway track/course labels such as `TRACK 160`, `TRACK 340`, runway heading,
  DER, and runway end/threshold context. Use inboundTrackDeg for the runway track.
- PROCEDURE_TRACK: output each visible SID path, including short radar departure tracks that end at a
  DME/altitude/assigned-heading condition rather than at a named waypoint.
- TURN: output explicit left/right turns, turns after DER, turns at DME, turns at altitude, and turns to
  assigned heading. If the heading is assigned by ATC and not printed, set inboundTrackDeg=null and
  labelText to the exact note.
- RADIAL: output every operational radial label, including cross-radials used as restrictions or
  intercept targets. Set centerNavaid when printed or inferable from the label (for example VJB).
- LABEL_BINDING: use this when a text label such as `5.7 DME VJB`, `MAX IAS 180 KT IN TURN`, or
  `CLIMB GRADIENT 5.5%` belongs to a specific leg/turn rather than to a standalone fix.
- MSA_SECTOR: report MSA rings/sectors separately from SID legs; do not turn MSA geometry into a
  procedure leg.
