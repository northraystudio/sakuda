import { z } from 'zod'

/** Body of `POST /api/mcp-keys`: a label naming the client that will use the
 * key (e.g. "claude-code"), so one client's key can be revoked alone. */
export const McpKeyInputSchema = z.object({
  label: z.string().trim().min(1).max(100),
})

export type McpKeyInput = z.infer<typeof McpKeyInputSchema>
