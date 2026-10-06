/** `say`'s rate when the person has set none, in words per minute. */
export const DEFAULT_RATE = 190
export const MIN_RATE = 80
export const MAX_RATE = 500

/** The voice and rate kept in `$.store`, across sessions. */
export type Settings = { voice: string | undefined; rate: number }

export function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_RATE && value <= MAX_RATE
}

/** The settings from the store's raw values, one of the wrong shape counting as unset. */
export function toSettings(voice: unknown, rate: unknown): Settings {
  return {
    voice: typeof voice === 'string' && voice !== '' ? voice : undefined,
    rate: isRate(rate) ? rate : DEFAULT_RATE,
  }
}

/** The `say` command line for these settings, reading its text from stdin. */
export function sayArgv({ voice, rate }: Settings): string[] {
  return ['say', ...(voice === undefined ? [] : ['-v', voice]), '-r', String(rate), '-f', '-']
}

/** The voice names in `say -v '?'` output: each line is `<name> <locale> # <sample>`. */
export function parseVoices(listing: string): string[] {
  const names: string[] = []
  for (const line of listing.split('\n')) {
    const match = /^(.+?)\s+[a-z]{2,3}_[A-Za-z0-9]+\s+#/.exec(line)
    if (match?.[1] !== undefined && !names.includes(match[1])) names.push(match[1])
  }
  return names
}

/** A typed rate, or undefined when it is not a whole number in range. */
export function parseRate(text: string): number | undefined {
  const rate = /^\d+$/.test(text) ? Number(text) : NaN
  return isRate(rate) ? rate : undefined
}

export const RATE_RANGE_MESSAGE = `Rate must be a whole number of words per minute from ${MIN_RATE} to ${MAX_RATE}, or "default" (${DEFAULT_RATE}).`

export function describeVoices(current: string | undefined, voices: readonly string[]): string {
  return [
    `Current voice: ${current ?? 'system default'}`,
    `Voices (${voices.length}): ${voices.join(', ')}`,
    'Set one with /speak-voice <name>, or /speak-voice default.',
  ].join('\n')
}

/** The voice `wanted` names, matched without case, or a message saying it is unknown. */
export function findVoice(wanted: string, voices: readonly string[]): { name: string } | { error: string } {
  const lower = wanted.toLowerCase()
  const found = voices.find(name => name.toLowerCase() === lower)
  if (found !== undefined) return { name: found }
  const close = voices.filter(name => name.toLowerCase().includes(lower)).slice(0, 5)
  const hint = close.length > 0 ? ` Did you mean: ${close.join(', ')}?` : ''
  return { error: `Unknown voice "${wanted}".${hint} Run /speak-voice to list the voices.` }
}
