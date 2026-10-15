/** Cuts `text` with an ellipsis until `measure` says it fits `maxWidth`.
 * Splits by code point, so an emoji or surrogate pair is never halved. */
export function fitText(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (measure(text) <= maxWidth) return text
  const chars = Array.from(text)
  while (chars.length > 1 && measure(`${chars.join('').trimEnd()}…`) > maxWidth) chars.pop()
  return `${chars.join('').trimEnd()}…`
}
