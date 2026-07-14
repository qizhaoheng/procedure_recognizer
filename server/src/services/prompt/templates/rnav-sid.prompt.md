## Procedure-Specific Instructions

The current task is RNAV SID recognition.

Work through these steps IN ORDER before writing any legs:

1. Confirm the airport ICAO and the OFFICIAL procedure name for every procedure in the package.
2. Classify each supplied page's role (overview diagram / narrative / leg table / waypoint coordinates / notes).
3. Identify every runway transition.
4. Identify the common route, if the source publishes one.
5. Identify every named enroute transition.
6. For each leg, decide the Path Terminator first, then read waypoint, course, altitude, turn,
   fly-over, and distance.
7. Attach source evidence to every field you extract.
8. Distinguish clearly-read values, inferred values, and undeterminable values: inferred values get
   lower confidence and a note; undeterminable fields MUST be null. Never guess.

### Procedure identity rules (critical)

- The procedure name comes ONLY from, in priority order: (1) the formal title block, (2) the leg
  table title, (3) the narrative description title, (4) the page header procedure identifier.
- NEVER take the procedure name from the largest waypoint label on the chart, the most prominent
  fix, a track's terminal fix name, a transition name, or any fix printed inside the plan view.
  A big five-letter waypoint in the middle of the chart is a waypoint, not the procedure.
- A transition name is NOT a waypoint. "<NAME> TRANSITION" names a route branch; it does not imply
  a waypoint called <NAME> exists. Do not create fixes from transition names.
- Report both the printed name (e.g. "<FIX> FOUR DEPARTURE") and keep it verbatim; the system
  derives the coded identifier (e.g. <FIX>4) separately.

### Structured output (procedureStructure + procedures)

Do NOT flatten everything into tableLegs. Model the procedure as a graph:

- Output every runway transition, the common route (when published), and every enroute transition
  as its own `procedures[]` entry with its own complete ordered legs:
  - runway branch: set `runway`, `transitionName=null`.
  - enroute transition: set `transitionName` to the printed transition ident, `runway=null`.
  - common route (shared segment after the merge point, when the source publishes it separately):
    set both `runway=null` and `transitionName=null`.
- Fill `procedureStructure` declaring the role of every entry:
  - `runwayTransitions[]` / `commonRoutes[]` / `enrouteTransitions[]`, each with
    `id` (RWxx for runway branches, transition ident for enroute), `procedureRef` (the exact
    `procedures[].procedureName` it points to), `entryFix`, and `exitFix`.
  - Branches that merge at a shared waypoint must show that waypoint as the runway branch's
    `exitFix` and the enroute transition's `entryFix`.
- Keep `tableLegs` populated as a legacy mirror of the leg tables, but `procedureStructure` +
  `procedures` are the primary output.
- Mandatory completeness check before answering: scan every supplied page header. For every page
  whose title or purpose contains `TRANSITION`, enumerate every named transition on that page and
  verify a corresponding non-empty `procedures[]` entry AND a `procedureStructure` branch exist.
  If any transition cannot be extracted, add a warning naming the page and set `reviewRequired=true`.

### Path Terminator semantics (do not fabricate geometry)

- VA = climb on heading until reaching an altitude. It usually has NO fixed endpoint coordinate.
  Output course + altitude constraint; leave fix fields null. Do not invent an endpoint.
- DF = direct to a fix; its START depends on where the previous leg ends. Never fabricate a
  precise start point for a DF leg.
- TF is the only leg type whose geometry is fully determined by a named fromFix and toFix.
- Use DF when the instruction is direct to a waypoint after the initial climb/turn; use TF only
  for fix-to-fix tracks with a named fromFix and toFix.
- The first leg of an RNAV SID is often a runway-aligned VA/CA (e.g. "climb on track 158 until
  500 ft"); preserve it with its course and altitude, fix fields null.

### Source-of-truth precedence

- The leg TABLE is the primary source for leg structure and order.
- The narrative text validates sequence, altitudes, and turn semantics.
- The chart graphics validate topology (which branches exist, where they merge) but NEVER override
  explicit table data.
- The coordinate table is the source for waypoint coordinates.
- If chart and table disagree, keep the tabular leg order, cite both in sourceEvidence, add a
  warning, and set reviewRequired=true.

### Field rules

- Distance: only record `distanceNm` when the AIP table or chart PRINTS a distance for that leg.
  VA/CA legs normally have no published distance — leave null; a null here is correct, not an
  omission. Do not copy vendor-database values.
- Capture altitude constraints exactly: `+03000` (at or above), `-04000` (at or below), window
  constraints go to lowerFt/upperFt. The airport TRANSITION ALTITUDE printed in a header box is
  airport-level information — report it as a chartText, never as a leg constraint.
- `turnDirection` belongs on legs only when the table explicitly codes or prints a turn direction.
  Chart line bends near a fix are route geometry, not a turn-direction field.
- `flyOver` only when the source explicitly marks the waypoint as fly-over (solid/circled symbol
  or table flag); otherwise null.
- Capture speed restrictions such as `250 KT` or `MAX IAS 180 KT IN TURN` on the leg they apply to.
- If a VOR/DME is used only for an initial climb/DME check, set recommendedNavaid on that initial
  leg only; leave ordinary DF/TF legs with recommendedNavaid=null.
- Preserve intermediate computer fixes (database-style idents such as two letters + three digits)
  and final enroute-transition fixes exactly as printed.

A worked few-shot example follows this template in the prompt. Use it to calibrate the expected
leg decomposition; never copy its values — read every course, distance, altitude, and ident from
the current chart and table.

Label plan mapping (RNAV SID):
- waypoint labels -> labelKind=FIX_NAME, anchorType=FIX
- procedure-name labels -> labelKind=PROCEDURE_NAME, anchorType=PROCEDURE_TRACK
- course/distance labels -> labelKind=COURSE_DISTANCE, anchorType=LEG
- runway-alignment climb labels such as `160 deg 1000` -> labelKind=COURSE_DISTANCE, anchorType=LEG,
  anchored to the VA/CA leg
- climb-gradient/speed/turn notes -> labelKind=NOTE, anchorType=LEG or PROCEDURE_TRACK
- navaid or DME reference labels -> labelKind=NAVAID_INFO or NOTE, anchored to the navaid or leg
