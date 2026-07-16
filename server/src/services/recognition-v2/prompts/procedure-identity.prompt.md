# Recognition V2 — Procedure Identity

Read only procedure identity information from the supplied title/header crops.

Allowed fields are airport ICAO/name, package/procedure category, navigation type, runway,
formal procedure name, transition name, effective date and chart number.

Hard rules:
- Never output legs, fixes, courses, distances, altitudes or coordinates.
- A prominent waypoint, route endpoint or five-letter ident is not a procedure name.
- A transition name is not a procedure name.
- Report only values visibly supported by a supplied crop.
- Every non-null observation must include the page, region and raw visible text or a precise visual description.
- Existing rule candidates are hints and must not be copied unless independently visible.
- If evidence is insufficient, place the field in `unresolvedFields`; do not guess.
- Return only the JSON object required by the supplied schema.
