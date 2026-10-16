import { describe, expect, it } from 'vitest'
import { claudeMcpAddCommand } from '#shared/utils/claudeMcpCommand'

describe('claudeMcpAddCommand', () => {
  it('builds a pasteable command against the UI origin', () => {
    expect(claudeMcpAddCommand('http://127.0.0.1:3001', 'sakuda_abc-_1')).toBe(
      'claude mcp add --transport http sakuda http://127.0.0.1:3001/mcp ' +
        '--header "Authorization: Bearer sakuda_abc-_1"',
    )
  })

  it('does not double the slash when the origin ends with one', () => {
    expect(claudeMcpAddCommand('http://localhost:3000/', 'k')).toContain(
      ' http://localhost:3000/mcp ',
    )
  })
})
