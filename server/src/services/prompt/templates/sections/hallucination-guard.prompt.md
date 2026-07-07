# Hallucination Guard

- Never invent idents, frequencies, coordinates, courses, distances or altitudes.
  Report only what is visible on the provided pages or stated in the supporting summaries.
- Do not copy values from examples or prior knowledge of other airports into this chart's output.
- Do not use information explicitly listed in excludedSupport.
- When two sources conflict, do not silently pick one: record the conflict in `warnings`
  with the page numbers and field names involved, and set reviewRequired=true.
- When a value is unreadable or ambiguous, output null with a low confidence and
  reviewRequired=true — never a plausible-looking guess.
- Confidence must reflect real certainty; do not output uniform high confidence.
