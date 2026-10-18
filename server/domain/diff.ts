export interface DiffCounts {
  new: number
  persisting: number
  resolved: number
  suppressed: number
}

/** Set semantics over fingerprints: `new` = in current not previous;
 * `persisting` = in both; `resolved` = in previous not current. A fingerprint
 * that would be new but is in `suppressed` (triaged as false-positive /
 * accepted, #18) counts as `suppressed` instead. Counts are of unique
 * fingerprints, so duplicate entries in either iterable collapse. */
export function diffFingerprints(
  previous: Iterable<string>,
  current: Iterable<string>,
  suppressed: ReadonlySet<string> = new Set(),
): DiffCounts {
  const previousSet = new Set(previous)
  const currentSet = new Set(current)

  let newCount = 0
  let persisting = 0
  let suppressedCount = 0
  for (const fingerprint of currentSet) {
    if (previousSet.has(fingerprint)) persisting++
    else if (suppressed.has(fingerprint)) suppressedCount++
    else newCount++
  }

  let resolved = 0
  for (const fingerprint of previousSet) {
    if (!currentSet.has(fingerprint)) resolved++
  }

  return { new: newCount, persisting, resolved, suppressed: suppressedCount }
}
