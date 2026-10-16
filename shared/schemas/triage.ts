import { z } from 'zod'
import { TRIAGE_STATUSES } from '../types/api'

/** An agent's verdict on one finding (`set_finding_triage`, #18). The reason
 * is required so a suppressed finding never hides without an explanation. */
export const TriageInputSchema = z.object({
  findingId: z.string().min(1),
  status: z.enum(TRIAGE_STATUSES),
  reason: z.string().trim().min(1).max(2_000),
})

export type TriageInput = z.infer<typeof TriageInputSchema>
