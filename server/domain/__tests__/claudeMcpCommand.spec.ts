import { describe, expect, it } from 'vitest'
import { claudeMcpRegisterCommand } from '#shared/utils/claudeMcpCommand'

describe('claudeMcpRegisterCommand', () => {
  it('removes any existing sakuda entry, then adds it against the UI origin', () => {
    expect(claudeMcpRegisterCommand('http://127.0.0.1:3001', 'sakuda_abc-_1')).toBe(
      'claude mcp remove sakuda -s local\n' +
        'claude mcp add --transport http sakuda http://127.0.0.1:3001/mcp ' +
        '--header "Authorization: Bearer sakuda_abc-_1"',
    )
  })

  it('does not double the slash when the origin ends with one', () => {
    expect(claudeMcpRegisterCommand('http://localhost:3000/', 'k')).toContain(
      ' http://localhost:3000/mcp ',
    )
  })
})
