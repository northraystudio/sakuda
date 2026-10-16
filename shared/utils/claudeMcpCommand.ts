/** The lines shown once after issuing a key (#20), so they can be pasted as
 * is: remove any existing `sakuda` entry, then add it with the new key —
 * `claude mcp add` refuses a name that is already registered. On a first
 * setup the remove line only reports that nothing was found. `origin` is
 * where the UI was loaded from — the same server that serves `/mcp`. The key
 * is base64url, so it needs no quoting beyond the double quotes around the
 * header. */
export function claudeMcpRegisterCommand(origin: string, key: string): string {
  const url = `${origin.replace(/\/+$/, '')}/mcp`
  return [
    'claude mcp remove sakuda -s local',
    `claude mcp add --transport http sakuda ${url} --header "Authorization: Bearer ${key}"`,
  ].join('\n')
}
