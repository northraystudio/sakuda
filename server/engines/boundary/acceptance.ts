/**
 * Decides whether a server really *accepted* an out-of-contract request, by
 * the data it stored rather than the status it returned. Independent of how
 * the value was chosen (`cases`) so other write probes — multipart / file
 * upload (#38) — reuse it: they supply the request and a `locate` for their
 * own field, and get the same send → 2xx → read back → compare judgement.
 */

export interface ProbeRequest {
  method: string
  url: string
  body?: string
  contentType?: string
}

export interface ProbeResponse {
  status: number
  /** The `Location` header, verbatim (may be relative). */
  location: string | null
  body: string
}

export type Send = (req: ProbeRequest) => Promise<ProbeResponse>

/** How a parsed JSON document relates to the value that was sent:
 * `exact` — the field is there, strictly equal; `changed` — it is there but
 * not identical (coerced, clamped, truncated); `absent` — not in the document. */
export type StoredState = 'exact' | 'changed' | 'absent'
export type Locate = (doc: unknown) => StoredState

export type AcceptanceResult =
  /** Stored exactly as sent, read from the create/update response or the
   * resource its `Location` points at. */
  | { verdict: 'accepted'; readFrom: 'response' | 'location' }
  /** Stored, but not as sent — the server converted or clamped it. Not a defect. */
  | { verdict: 'coerced' }
  /** Non-2xx: the server refused it. */
  | { verdict: 'rejected'; status: number }
  /** 2xx, but there is no readable copy of the stored value to compare. */
  | { verdict: 'unverifiable'; reason: string }

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Not JSON (empty 201, HTML): there is simply nothing to compare.
    return undefined
  }
}

const isSuccess = (status: number): boolean => status >= 200 && status < 300

/** Finds `name` at the top of `doc`, or one level down inside a wrapper
 * object (`{ data: {...} }`, `{ item: {...} }`), and compares it to `sent`. */
export function locateField(doc: unknown, name: string, sent: unknown): StoredState {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 'absent'
  const record = doc as Record<string, unknown>
  const holders: Array<Record<string, unknown>> = [record]
  for (const child of Object.values(record))
    if (typeof child === 'object' && child !== null && !Array.isArray(child))
      holders.push(child as Record<string, unknown>)
  for (const holder of holders) {
    if (!(name in holder)) continue
    return holder[name] === sent ? 'exact' : 'changed'
  }
  return 'absent'
}

export async function judgeAcceptance(
  send: Send,
  request: ProbeRequest,
  locate: Locate,
): Promise<AcceptanceResult> {
  const response = await send(request)
  if (!isSuccess(response.status)) return { verdict: 'rejected', status: response.status }

  const fromResponse = locate(parseJson(response.body))
  if (fromResponse === 'exact') return { verdict: 'accepted', readFrom: 'response' }
  if (fromResponse === 'changed') return { verdict: 'coerced' }

  if (!response.location)
    return { verdict: 'unverifiable', reason: 'no stored copy in the response and no Location' }
  // A Location pointing off-origin is never fetched: the probe sends only to
  // the saved target's own origin.
  const target = new URL(response.location, request.url)
  if (target.origin !== new URL(request.url).origin)
    return { verdict: 'unverifiable', reason: 'Location points to a different origin' }

  const readBack = await send({ method: 'GET', url: target.toString() })
  if (!isSuccess(readBack.status))
    return { verdict: 'unverifiable', reason: `Location read-back returned ${readBack.status}` }
  const fromLocation = locate(parseJson(readBack.body))
  if (fromLocation === 'exact') return { verdict: 'accepted', readFrom: 'location' }
  if (fromLocation === 'changed') return { verdict: 'coerced' }
  return { verdict: 'unverifiable', reason: 'field not present in the Location resource' }
}
