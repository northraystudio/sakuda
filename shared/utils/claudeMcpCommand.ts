/** The `claude mcp add` line shown once after issuing a key (#20), so it can
 * be pasted as is. `origin` is where the UI was loaded from — the same
 * server that serves `/mcp`. The key is base64url, so it needs no quoting
 * beyond the double quotes around the header. */
export function claudeMcpAddCommand(origin: string, key: string): string {
  const url = `${origin.replace(/\/+$/, '')}/mcp`
  return `claude mcp add --transport http sakuda ${url} --header "Authorization: Bearer ${key}"`
}
