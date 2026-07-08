## Procedure-Specific Instructions

The current task is RNAV STAR recognition.

Focus on:
- procedure names, including each arrival designator
- IF/TF legs and other path terminator candidates
- waypoints, course, distance, turn direction, altitude constraints, and speed limits
- airway/route labels printed before the STAR entry, such as W534, A224, or W401
- RNAV specification, especially RNAV1 when supported by the source
- waypoint coordinates and source page references

Evidence priority:
- Use tabular description pages to determine leg sequence and path terminators.
- Use coordinate pages to determine waypoint coordinates.
- Use chart images to validate track direction, holding, MSA, shared segments, and text labels.
- Preserve chart-visible labels in `chartTexts`, including airway labels, procedure-name labels,
  fix altitude labels, common-segment labels, and final inbound course labels.

RNAV chart labels:
- Do not mix different label types. A fix label, a procedure-name label, a course/distance
  label, and a pre-entry airway label are separate chart objects even when they are drawn
  near each other.
- Airway labels such as `W534`, `A224`, and `W401` describe the route before entering the
  STAR. Preserve them in `chartTexts` as chart-visible text, but do not attach them to
  `tableLegs[].remarks` and do not treat them as STAR leg names.
- Procedure names such as `EMTUV 1E`, `PIMOK 1E`, `OMKOM 1E`, and `ADLOV 1E` are labels
  on the procedure track, not fix names. Do not append them to fix labels.
- Course/distance text such as `072° 13.4` or `070° 6.0` describes the leg track and leg
  length. Put the numeric course and distance in `tableLegs[].courseDeg` and
  `tableLegs[].distanceNm`, and the corresponding `procedures[].legs[].courseDegMag` and
  `distanceNm`. Do not attach course/distance text to the waypoint label.
- Fix labels should contain only the fix identifier, any printed role such as `(IAF)` or
  `(IF)`, and any printed altitude. If the chart prints `EMTUV 6000`, output that as a fix
  altitude label; do not add `(IF)` unless `(IF)` is actually printed.
- Fix-label altitudes must be read from the chart label itself, not inferred from the next
  leg's altitude constraint. If the chart label says `UDOSU (IAF) 3000`, preserve `3000`
  even if a nearby table leg has a different altitude constraint.
- For shared segments, duplicate the leg in every related procedure but preserve the common
  fix/course/distance labels. Example: EMTUV 1E and PIMOK 1E may share `UDOSU -> OSRUP`,
  while ADLOV 1E and OMKOM 1E may share `GOVNU -> OSRUP`.
- Capture final common inbound labels such as `OSRUP (IF) 2000 / 160°`. If the final inbound
  course is printed on the chart, include it in `chartTexts` and mention it in the relevant
  final-leg `remarks`.

Label plan mapping (RNAV STAR):
- Fix labels (`UDOSU (IAF) 3000`) → one `labelPlan` entry per fix: labelKind=FIX_NAME,
  anchorType=FIX, text with `\n` between name/role line and altitude line.
- Course/distance (`072° 13.4`) → labelKind=COURSE_DISTANCE, anchorType=LEG with
  procedureName + legSequence, placementAlongLine=MIDDLE, sideOfLine matching the chart.
- Procedure names (`EMTUV 1E`) → labelKind=PROCEDURE_NAME, anchorType=PROCEDURE_TRACK,
  placementAlongLine=START.
- Airway labels (`W534`, `A224`) → labelKind=NOTE, anchorType=PROCEDURE_TRACK,
  placementAlongLine=START (they describe the route before the entry fix).
- Final inbound labels (`OSRUP (IF) 2000 / 160°`) → split: the fix part anchors to the fix,
  the course part (`160°`) anchors to the final leg as COURSE_DISTANCE.

Holding patterns:
- Racetrack patterns drawn at fixes (typically the entry fixes) are part of the procedure.
  Report each one in `holdings` (fixIdentifier, inboundCourseDegMag, turnDirection).
  Do not leave `holdings` empty when the chart draws a racetrack.
- Count check — do this BEFORE writing `holdings`: scan EVERY entry fix on the chart one by
  one and count the racetrack (oval holding) symbols. The `holdings` array must contain
  exactly that many entries. A chart often draws holds at only some entry fixes (e.g. 2 of 4),
  so check each fix individually; returning an empty `holdings` while any racetrack is drawn
  is a FAILURE.
- If a table row/entry fix is associated with a holding pattern, also mark that leg with
  `holdingAtFix=true` when the schema allows it. The 424 exporter uses this to code the
  `H` flag on the IF leg.

Altitude constraints:
- Preserve dual altitude constraints exactly. For example, a table or coded source such
  as `-06000 13000` means altitudeValue/lower value 6000 with altitudeUpperFt=13000;
  do not drop the second altitude.
- Keep the altitude sign from the source (`+` for at-or-above, `-` for at-or-below).
  Do not rewrite an at-or-below entry fix as an at-or-above constraint.
- If a row only gives `13000` with no sign, keep altitudeValue=13000 and leave the sign
  empty/null.

Recommended navaids / coded references:
- Each tableLegs row has a `recommendedNavaid` field. Fill it on entry IF legs when the
  source explicitly references a VOR/DME for the procedure:
  - a chart note such as "VJB VOR/DME REQUIRED" applies to the whole procedure — put that
    navaid identifier (e.g. `VJB`) into `recommendedNavaid` of every entry IF leg;
  - a table row or 424-like coding that prints a navaid on the leg also counts.
- Do not invent a recommended navaid from unrelated nearby labels. Leave it null on legs
  where nothing is referenced (typically all TF legs).

Guardrails:
- Do not treat DME Arrival Procedures as the main RNAV STAR rule set.
- turnDirection: output it only when the tabular description or an explicit chart annotation
  states the turn; do NOT infer L/R from how the drawn track bends at a waypoint.
  Legs coded from straight table rows keep turnDirection=null.
- For RNAV STAR TF legs, `turnDirection` is normally null. Never put L/R on a final TF leg
  such as OSRUP just because the drawn polyline bends into the waypoint.
- If chart images conflict with tabular descriptions, preserve the conflict in warnings and set reviewRequired=true.
