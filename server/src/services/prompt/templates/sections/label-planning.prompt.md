# Label Planning — labelPlan

Plan map labels like a professional procedure-chart cartographer. Every chart-visible text that
matters operationally must become exactly ONE `labelPlan` entry that says WHAT the text is,
WHICH object it belongs to, and WHERE it should sit relative to that object. The renderer
computes final coordinates from your plan; you never output lat/lon for labels.

Classification — decide what each text is anchored to:
- Node labels (`anchorType=FIX` or `NAVAID`): fix names, printed roles like `(IAF)`/`(IF)`,
  fix altitude labels, navaid ident/frequency boxes. Set `anchorIdent` to the fix/navaid ident.
  Combine text lines that the chart stacks at one node into ONE entry using `\n`
  (e.g. `<FIX> (IAF)\n3000`). Never create two labelPlan entries for the same node.
- Segment labels (`anchorType=LEG`): course/distance text such as `072° 13.4` belongs to a leg,
  not to a waypoint. Set `procedureName` + `legSequence` (and `anchorIdent` to the leg's ending
  fix when known). These read along the leg, so use `placementAlongLine` and `sideOfLine`.
- Track labels (`anchorType=PROCEDURE_TRACK`): procedure names like `<FIX> 1E` ride along the
  procedure track. Airway labels printed before the entry fix (`W534`, `A224`) are
  `labelKind=NOTE` with `placementAlongLine=START`.
- Arc / radial labels (`anchorType=DME_ARC` / `RADIAL`): texts like `11 DME ARC` or
  `RDL-340 <VOR> / 160°` follow the arc or radial line. For RADIAL set `anchorIdent` to the
  radial label ident (e.g. `RDL340`).

Placement — put the text where a pilot expects it:
- For node labels choose `anchorDirection`: the compass side of the node that is FREE of
  procedure lines. If unsure, use `AUTO` and the renderer picks the clear side.
- For line labels choose `sideOfLine` LEFT/RIGHT relative to the direction of flight, matching
  the side the source chart prints the text on; `AUTO` lets the renderer decide.
- `placementAlongLine`: START near the beginning of the line, MIDDLE at the midpoint (default
  for course/distance), END near the terminating fix.

Priority — controls which label wins when space is tight (0-100):
- navaid info 100, fix names 90, procedure names 88, lead radials 85, DME arc labels 80,
  course/distance 76, plain radials 70, notes 55, MSA 40. Adjust ±5 when the chart clearly
  emphasizes or de-emphasizes a text.

Consistency rules:
- Every `labelPlan.text` must trace back to a `chartTexts` entry (same normalized content);
  do not invent labels and do not re-plan texts that are pure table/notes content.
- Do not mix label types in one entry: a fix label, a course/distance label, and a
  procedure-name label are separate entries even when printed close together.
- One entry per (object, labelKind). Shared segments get ONE course/distance label per drawn
  chart text, attached to the procedure whose leg the chart annotates.
