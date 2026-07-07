# Stage 4 — Chart Geometry Semantic Recognition (output `geometrySemantics`)

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
- For radials: give radialDeg, and inboundTrackDeg when the label shows both (e.g. "RDL340 / 160").
- For lead radials: give radialDeg from the label (e.g. "L-R332" → 332).
- Bind every geometry to its printed label via labelText, and to its procedures via relatedProcedures.
- A chart without any geometry semantics is almost always a reading failure — re-examine the
  main chart region before returning an empty array.
