## Procedure-Specific Instructions

The current task is RNAV STAR recognition.

Focus on:
- procedure names, including each arrival designator
- IF/TF legs and other path terminator candidates
- waypoints, course, distance, turn direction, altitude constraints, and speed limits
- RNAV specification, especially RNAV1 when supported by the source
- waypoint coordinates and source page references

Evidence priority:
- Use tabular description pages to determine leg sequence and path terminators.
- Use coordinate pages to determine waypoint coordinates.
- Use chart images to validate track direction, holding, MSA, shared segments, and text labels.

Guardrails:
- Do not treat DME Arrival Procedures as the main RNAV STAR rule set.
- If chart images conflict with tabular descriptions, preserve the conflict in warnings and set reviewRequired=true.
