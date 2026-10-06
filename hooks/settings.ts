import type { Lang } from './language'
import type { Engine } from './speech'

/** The rate when the person has set none, in words per minute. */
export const DEFAULT_RATE = 190
export const MIN_RATE = 80
export const MAX_RATE = 500

export const DEFAULT_ENGINE: Engine = 'kokoro'
export const DEFAULT_KOKORO_VOICES: Record<Lang, string> = { en: 'af_heart', es: 'ef_dora' }
export const LANG_NAMES: Record<Lang, string> = { en: 'English', es: 'Spanish' }

/** The `$.store` key of each engine's voice per language; `voice` predates languages. */
export const VOICE_KEYS: Record<Engine, Record<Lang, string>> = {
  say: { en: 'voice', es: 'sayVoiceEs' },
  kokoro: { en: 'kokoroVoiceEn', es: 'kokoroVoiceEs' },
}
export const SETTING_KEYS = ['engine', 'rate', ...Object.values(VOICE_KEYS).flatMap(Object.values)] as const

/**
 * What is kept in `$.store`, across sessions. A `say` voice left unset is the
 * system default for English, and the first Spanish voice for Spanish.
 */
export type Settings = {
  engine: Engine
  rate: number
  voices: { say: Record<Lang, string | undefined>; kokoro: Record<Lang, string> }
}

export function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_RATE && value <= MAX_RATE
}

export function isEngine(value: unknown): value is Engine {
  return value === 'kokoro' || value === 'say'
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The settings from the store's raw values by key, one of the wrong shape counting as unset. */
export function toSettings(raw: Readonly<Record<string, unknown>>): Settings {
  const { say, kokoro } = VOICE_KEYS
  return {
    engine: isEngine(raw.engine) ? raw.engine : DEFAULT_ENGINE,
    rate: isRate(raw.rate) ? raw.rate : DEFAULT_RATE,
    voices: {
      say: { en: nonEmpty(raw[say.en]), es: nonEmpty(raw[say.es]) },
      kokoro: {
        en: nonEmpty(raw[kokoro.en]) ?? DEFAULT_KOKORO_VOICES.en,
        es: nonEmpty(raw[kokoro.es]) ?? DEFAULT_KOKORO_VOICES.es,
      },
    },
  }
}

/** The `say` command line, reading its text from stdin. */
export function sayArgv({ voice, rate }: { voice: string | undefined; rate: number }): string[] {
  return ['say', ...(voice === undefined ? [] : ['-v', voice]), '-r', String(rate), '-f', '-']
}

/** The voices in `say -v '?'` output: each line is `<name> <locale> # <sample>`. */
export function parseVoiceEntries(listing: string): { name: string; locale: string }[] {
  const voices: { name: string; locale: string }[] = []
  for (const line of listing.split('\n')) {
    const match = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/.exec(line)
    const [, name, locale] = match ?? []
    if (name !== undefined && locale !== undefined && !voices.some(v => v.name === name)) voices.push({ name, locale })
  }
  return voices
}

/** The voice names in `say -v '?'` output. */
export function parseVoices(listing: string): string[] {
  return parseVoiceEntries(listing).map(v => v.name)
}

/** The first Spanish (`es_*`) voice in `say -v '?'` output, if any. */
export function firstSpanishVoice(listing: string): string | undefined {
  return parseVoiceEntries(listing).find(v => v.locale.startsWith('es_'))?.name
}

/** `/speak-voice`'s arguments: an optional `en`/`es` first, English when absent, then the name. */
export function parseVoiceArgs(args: string): { lang: Lang; name: string } {
  const match = /^(en|es)(?:\s+([\s\S]*))?$/i.exec(args.trim())
  if (match === null) return { lang: 'en', name: args.trim() }
  return { lang: match[1]!.toLowerCase() as Lang, name: (match[2] ?? '').trim() }
}

/** A typed rate, or undefined when it is not a whole number in range. */
export function parseRate(text: string): number | undefined {
  const rate = /^\d+$/.test(text) ? Number(text) : NaN
  return isRate(rate) ? rate : undefined
}

export const RATE_RANGE_MESSAGE = `Rate must be a whole number of words per minute from ${MIN_RATE} to ${MAX_RATE}, or "default" (${DEFAULT_RATE}).`

/** `/speak-voice` alone: the engine, each language's voice, and the voices to pick from. */
export function describeVoices(
  engine: Engine,
  current: Record<Lang, string>,
  choices: Record<Lang, readonly string[]> | undefined,
): string {
  const lines = [
    `Engine: ${engine}`,
    `English voice: ${current.en}`,
    `Spanish voice: ${current.es}`,
  ]
  if (choices !== undefined) {
    if (engine === 'kokoro') {
      lines.push(`English voices: ${choices.en.join(', ')}`, `Spanish voices: ${choices.es.join(', ')}`)
    } else {
      lines.push(`Voices (${choices.en.length}): ${choices.en.join(', ')}`)
    }
  }
  lines.push('Set one with /speak-voice [en|es] <name>, or /speak-voice [en|es] default.')
  return lines.join('\n')
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
