## Procedure-Specific Instructions

The current task is RNAV SID recognition.

Focus on:
- departure designators, runway, climb requirements, initial turns, waypoint sequence, and RNAV specification
- CA/IF/TF/DF/CF candidates, course, distance, altitude constraints, speed limits, and turn direction
- waypoint coordinates and runway threshold context

Prefer tabular descriptions for leg order and chart images for runway alignment, turn direction, labels, and obstacle/airspace notes.

SID-specific reading rules:
- Treat the complete multi-page source package as the recognition scope. Package metadata such as a single
  `runway` value is only a grouping hint and MUST NOT restrict extraction to that runway.
- When the package contains several runway branches for one named departure, output every branch as a
  separate `procedures[]` entry with its own `runway` and complete ordered legs. Include the runway in the
  procedure identity when needed to keep `tableLegs.procedureName` unambiguous.
- Extract every named enroute transition shown on later chart/table pages. Keep transition legs separate
  from runway branches, set `procedures[].transitionName` to the printed transition ident and `runway=null`,
  preserve their printed join fix and sequence, and do not stop after the first visually complete branch.
  Give each one a unique procedureName in the form `<departure name> / <transition ident> TRANSITION`, and
  use that exact same name in its `tableLegs.procedureName` values.
- Mandatory completeness check before answering: scan every supplied page header. For every page whose
  title or purpose contains `TRANSITION`, enumerate every named transition on that page and verify that a
  corresponding non-empty `procedures[]` entry exists. If any transition cannot be extracted, add a warning
  naming the page, set `reviewRequired=true`, and never silently omit the page.
- Keep runway variants separate: `<FIX> 1J RWY16`, `<FIX> 1K RWY34`, `<FIX> 2J RWY16`, etc. are separate
  procedures even when they share the same terminal waypoint.
- The first leg of an RNAV SID may still be a runway/course-to-altitude leg. If the table says track 160
  or 340 to 1000/1500 ft before joining RNAV fixes, output a CA-style leg before the first named fix.
- Many AIP RNAV SID tables code the first runway-alignment CA leg even when the fix cell is
  blank. Preserve it as `sequence=10`, `pathTerminator="CA"`, `fixIdentifier=null`, `fromFix=null`,
  `courseDegMag=<runway track>`, and keep the printed 2P/DME distance such as `2.0` in `distanceNm`.
- If the plan view prints a runway-alignment label such as `160 deg 1000`, read it as "track/course 160
  until 1000 ft before turning". Preserve `1000` as the CA altitude constraint and include the same
  text in geometrySemantics as RUNWAY_ALIGNMENT.
- The airport TRANSITION ALTITUDE (header box like `TRANSITION ALTITUDE 11000FT`) is
  airport-level information: report it as a chartText, but do NOT copy it into any leg's
  altitudeConstraint or upperFt. A number printed next to a leg altitude in a coded source
  (e.g. the `11000` in `+01000 11000`) is that same transition altitude — ignore it at leg level.
- `upperFt` is ONLY for genuine dual-altitude window constraints printed for the leg itself
  (e.g. "between 4000 and 9000" / `9000B4000`): put the lower bound in altitudeFt/lowerFt and
  the upper bound in upperFt.
- If the first CA row references a navaid for DME/course checking, put that ident in
  `recommendedNavaid` on that CA leg only. The airport's reference VOR/DME is usually identified
  by the MSA box (e.g. `MSA 25 NM <VOR>`) and the aeronautical data tabulation. Leave later
  ordinary DF/TF legs with `recommendedNavaid=null` unless their row explicitly uses a navaid.
- Use DF when the instruction is direct to a waypoint after the initial climb/turn; use TF only for
  fix-to-fix tracks with a named fromFix and toFix.
- DF legs can also have a printed 2P distance. When the table/424 coding shows a distance value
  next to the DF fix name, copy that value to `distanceNm` on the DF leg.
- Preserve intermediate computer fixes (including database-style idents such as two letters +
  three digits) and final enroute transition fixes.
- Preserve final transition-fix legs exactly. The last named fix of an RNAV SID is the enroute
  transition join point; keep it as a named leg with its printed distance and altitude constraint.
  Do not replace it with a procedure label.
- Capture altitude constraints exactly: `+03000`, `+06000`, climb-gradient requirements, and transition
  altitude are distinct; do not merge them into one note.
- Capture speed restrictions such as `250 KT`, `MAX IAS 180 KT IN TURN`, and any printed turn speed.
- If a VOR/DME is used only for an initial CA/DME check or coded reference, list it as a navaid/supportObject
  and set recommendedNavaid on the relevant initial leg; do not attach it to unrelated TF legs.
- `turnDirection` belongs on CA/DF/RF/turning legs only when the table explicitly codes or prints a turn
  direction. Do not put `L`/`R` on ordinary final TF legs merely because the chart line bends near the
  transition fix; those bends are route geometry, not a 424 turn-direction field.
- If chart and table disagree, preserve the tabular leg order, cite both in sourceEvidence, add a warning,
  and set reviewRequired=true.

A worked few-shot example follows this template in the prompt. Use it to calibrate the expected
leg decomposition; never copy its values — read every course, distance, altitude, and ident from
the current chart and table.

Label plan mapping (RNAV SID):
- waypoint labels -> labelKind=FIX_NAME, anchorType=FIX
- procedure-name labels -> labelKind=PROCEDURE_NAME, anchorType=PROCEDURE_TRACK
- course/distance labels -> labelKind=COURSE_DISTANCE, anchorType=LEG
- runway-alignment climb labels such as `160 deg 1000` -> labelKind=COURSE_DISTANCE, anchorType=LEG,
  anchored to the CA leg
- climb-gradient/speed/turn notes -> labelKind=NOTE, anchorType=LEG or PROCEDURE_TRACK
- navaid or DME reference labels -> labelKind=NAVAID_INFO or NOTE, anchored to the navaid or leg
