## Procedure-Specific Instructions

The current task is RNAV SID recognition.

Focus on:
- departure designators, runway, climb requirements, initial turns, waypoint sequence, and RNAV specification
- CA/IF/TF/DF/CF candidates, course, distance, altitude constraints, speed limits, and turn direction
- waypoint coordinates and runway threshold context

Prefer tabular descriptions for leg order and chart images for runway alignment, turn direction, labels, and obstacle/airspace notes.

SID-specific reading rules:
- Keep runway variants separate: `ADLOV 1J RWY16`, `ADLOV 1K RWY34`, `ADLOV 2J RWY16`, etc. are separate
  procedures even when they share the same terminal waypoint.
- The first leg of an RNAV SID may still be a runway/course-to-altitude leg. If the table says track 160
  or 340 to 1000/1500 ft before joining RNAV fixes, output a CA-style leg before the first named fix.
- If the plan view prints a runway-alignment label such as `160° 1000`, read it as "track/course 160
  until 1000 ft before turning". Preserve `1000` as the CA altitude constraint and include the same
  text in geometrySemantics as RUNWAY_ALIGNMENT.
- Use DF when the instruction is direct to a waypoint after the initial climb/turn; use TF only for
  fix-to-fix tracks with a named fromFix and toFix.
- Preserve intermediate computer fixes such as KJ703, INVOV, UDOSU, AKSOT, and final transition fixes
  such as ADLOV/AROSO/OMKOM/PIMOK/SABKA.
- Capture altitude constraints exactly: `+03000`, `+06000`, climb-gradient requirements, and transition
  altitude are distinct; do not merge them into one note.
- Capture speed restrictions such as `250 KT`, `MAX IAS 180 KT IN TURN`, and any printed turn speed.
- If a VOR/DME is used only for an initial CA/DME check or coded reference, list it as a navaid/supportObject
  and set recommendedNavaid on the relevant initial leg; do not attach it to unrelated TF legs.
- If chart and table disagree, preserve the tabular leg order, cite both in sourceEvidence, add a warning,
  and set reviewRequired=true.

Label plan mapping (RNAV SID):
- waypoint labels -> labelKind=FIX_NAME, anchorType=FIX
- procedure-name labels -> labelKind=PROCEDURE_NAME, anchorType=PROCEDURE_TRACK
- course/distance labels -> labelKind=COURSE_DISTANCE, anchorType=LEG
- runway-alignment climb labels such as `160° 1000` -> labelKind=COURSE_DISTANCE, anchorType=LEG,
  anchored to the CA leg
- climb-gradient/speed/turn notes -> labelKind=NOTE, anchorType=LEG or PROCEDURE_TRACK
- navaid or DME reference labels -> labelKind=NAVAID_INFO or NOTE, anchored to the navaid or leg
