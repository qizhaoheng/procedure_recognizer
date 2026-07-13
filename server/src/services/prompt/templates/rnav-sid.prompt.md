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
- For WMKJ-style RNAV SID tables, the first runway-alignment CA leg is coded even when the fix cell is
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
- If the first CA row references a navaid such as `VJB` for DME/course checking, put
  `recommendedNavaid="VJB"` on that CA leg only.
- For WMKJ RNAV SID charts, the `MSA 25 NM VJB` box and the aeronautical data tabulation identify
  `VJB` as the reference VOR/DME. Use `recommendedNavaid="VJB"` on the first no-fix CA leg, and
  leave later ordinary DF/TF legs with `recommendedNavaid=null` unless their row explicitly uses a
  navaid.
- Use DF when the instruction is direct to a waypoint after the initial climb/turn; use TF only for
  fix-to-fix tracks with a named fromFix and toFix.
- DF legs can also have a printed 2P distance. When the table/424 coding shows values such as
  `INVOV 12.0`, `PIMOK 24.0`, or `KJ706 13.0`, copy that value to `distanceNm` on the DF leg.
- Preserve intermediate computer fixes such as KJ703, INVOV, UDOSU, AKSOT, and final transition fixes
  such as ADLOV/AROSO/OMKOM/PIMOK/SABKA.
- Preserve final transition-fix legs exactly. The last named fix of an RNAV SID, for example
  `ADLOV`, `AROSO`, `PIMOK`, or `SABKA`, is the enroute transition join point; keep it as a named
  leg with its printed distance and altitude constraint. Do not replace it with a procedure label.
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

424 comparison target for RWY16 RNAV SID 1J:
- Sequence 010 is a no-fix CA leg: course 160, distance 2.0 NM, altitude `+01000 11000`,
  recommended navaid `VJB`, and no fix identifier.
- ADLOV/AROSO 1J then use DF to `INVOV` with distance 12.0 NM, followed by TF legs to the common
  intermediate fix and then to the named transition fix.
- PIMOK 1J uses a DF leg directly to `PIMOK` with distance 24.0 NM.
- SABKA 1J uses DF to `KJ706` with distance 13.0 NM, then TF to `SABKA`.
- The final named transition fix in each procedure must not carry `turnDirection` unless the table
  explicitly codes one.

424 comparison target for RWY34 RNAV SID 1K:
- Sequence 010 is a no-fix CA leg: course 340, distance 3.0 NM, altitude `+01500 11000`,
  recommended navaid `VJB`, and no fix identifier.
- AROSO 1K uses a DF leg to `AROSO` with distance 32.0 NM.
- ADLOV 1K uses a DF leg to `ADLOV` with distance 25.0 NM.
- PIMOK 1K uses a DF leg to `PIMOK` with distance 25.0 NM.
- SABKA 1K uses a DF leg to `SABKA` with distance 25.0 NM.
- OMKOM 1K uses DF to `KJ707` with distance 10.0 NM, then TF to `OMKOM` if the table shows the
  extra terminal-fix row.
- Do not infer `turnDirection` on ADLOV/AROSO/PIMOK/SABKA/OMKOM terminal transition-fix legs from
  the visible path bend. Only copy L/R when the table `TURN DIR` column explicitly contains it for
  that same row.

Label plan mapping (RNAV SID):
- waypoint labels -> labelKind=FIX_NAME, anchorType=FIX
- procedure-name labels -> labelKind=PROCEDURE_NAME, anchorType=PROCEDURE_TRACK
- course/distance labels -> labelKind=COURSE_DISTANCE, anchorType=LEG
- runway-alignment climb labels such as `160 deg 1000` -> labelKind=COURSE_DISTANCE, anchorType=LEG,
  anchored to the CA leg
- climb-gradient/speed/turn notes -> labelKind=NOTE, anchorType=LEG or PROCEDURE_TRACK
- navaid or DME reference labels -> labelKind=NAVAID_INFO or NOTE, anchored to the navaid or leg
