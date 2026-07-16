# Recognition V2 — Page Layout

Identify the business regions on exactly one AIP AD-2 page.

Hard rules:
- This task is layout analysis only. Never output procedure legs, coordinates or ARINC 424 data.
- A page may have multiple simultaneous roles.
- Use normalized bounding boxes `[x0,y0,x1,y1]` in the range 0..1, with the origin at the top-left.
- A box must contain the complete business region, including its title and column headers.
- Do not infer a region merely because another country usually has it.
- Existing text/rule hints are non-authoritative hints. Correct them when the image disagrees.
- Return `UNKNOWN` when the role cannot be determined reliably.
- Return only the JSON object required by the supplied schema.
