import { labelParagraphs, type Lang } from './language'

/** What speaks a language: the local Kokoro model, or macOS `say`. */
export type Engine = 'kokoro' | 'say'

/** One piece of an utterance, in one language. */
export type Segment = { text: string; lang: Lang }

export const KOKORO_MODEL = 'mlx-community/Kokoro-82M-bf16'
export const KOKORO_PORT = 8765
export const KOKORO_URL = `http://127.0.0.1:${KOKORO_PORT}`
/** Kokoro's own pace at speed 1.0, measured: 122 words in 47.7 s. */
export const KOKORO_NATURAL_WPM = 153

/** The first Kokoro chunk is kept short, so the first audio comes soon. */
export const FIRST_CHUNK_CHARS = 200
export const CHUNK_CHARS = 400

/** Kokoro's `speed` for a rate in words per minute, 0.5 to 2.0, two decimals. */
export function kokoroSpeed(wpm: number): number {
  const speed = Math.min(2, Math.max(0.5, wpm / KOKORO_NATURAL_WPM))
  return Math.round(speed * 100) / 100
}

/** Kokoro's `lang_code` for a voice: British voices (bf_, bm_) speak `b`. */
export function kokoroLangCode(lang: Lang, voice: string): string {
  if (lang === 'es') return 'e'
  return /^b[fm]_/.test(voice) ? 'b' : 'a'
}

/** The JSON body of a `/v1/audio/speech` request. */
export function kokoroRequestBody(text: string, lang: Lang, voice: string, wpm: number): string {
  return JSON.stringify({
    model: KOKORO_MODEL,
    input: text,
    voice,
    lang_code: kokoroLangCode(lang, voice),
    response_format: 'wav',
    speed: kokoroSpeed(wpm),
  })
}

/** curl posting the body on stdin to the server, the WAV written to `out`, giving up after `maxSeconds`. */
export function kokoroCurlArgv(out: string, maxSeconds = 120): string[] {
  return [
    '/usr/bin/curl',
    '-sS',
    '-f',
    '-m',
    String(maxSeconds),
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    '--data-binary',
    '@-',
    '-o',
    out,
    `${KOKORO_URL}/v1/audio/speech`,
  ]
}

/** Where uv puts the mlx-audio tools, under the home directory. */
export function kokoroServerPath(home: string): string {
  return `${home}/.local/bin/mlx_audio.server`
}

/** The Kokoro voices directory's parent, in the Hugging Face cache. */
export function kokoroSnapshotsPath(home: string): string {
  return `${home}/.cache/huggingface/hub/models--mlx-community--Kokoro-82M-bf16/snapshots`
}

/** Kokoro's voices as the model ships them, for when the cache cannot be read. */
export const BUILTIN_KOKORO_VOICES: readonly string[] = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river',
  'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck',
  'am_santa', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
  'ef_dora', 'em_alex', 'em_santa',
]

const KOKORO_PREFIXES: Record<Lang, RegExp> = { en: /^(af|am|bf|bm)_/, es: /^(ef|em)_/ }

/** The voice names among a voices directory's file names, sorted. */
export function parseKokoroVoiceFiles(files: readonly string[]): string[] {
  return files
    .map(f => /^([a-z]{2}_[a-z0-9]+)\.(safetensors|pt)$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .filter((n, i, all) => all.indexOf(n) === i)
    .sort()
}

/** The Kokoro voices that speak `lang`. */
export function kokoroVoicesFor(lang: Lang, voices: readonly string[]): string[] {
  return voices.filter(v => KOKORO_PREFIXES[lang].test(v))
}

/** Splits a paragraph into sentence groups of at most `max` characters (a longer sentence on word breaks). */
export function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const sentences = text.split(/(?<=[.!?…:;])\s+/)
  const pieces: string[] = []
  for (const sentence of sentences) {
    if (sentence.length <= max) {
      pieces.push(sentence)
      continue
    }
    let line = ''
    for (const word of sentence.split(/\s+/)) {
      if (line !== '' && line.length + 1 + word.length > max) {
        pieces.push(line)
        line = ''
      }
      line = line === '' ? word : `${line} ${word}`
    }
    if (line !== '') pieces.push(line)
  }
  const groups: string[] = []
  for (const piece of pieces) {
    const last = groups.at(-1)
    if (last !== undefined && last.length + 1 + piece.length <= max) groups[groups.length - 1] = `${last} ${piece}`
    else groups.push(piece)
  }
  return groups
}

/** The opening paragraph's pieces: a short first one, then the usual size. */
function splitFirst(text: string): string[] {
  const [head, ...rest] = splitLong(text, FIRST_CHUNK_CHARS)
  if (head === undefined) return []
  return rest.length === 0 ? [head] : [head, ...splitLong(rest.join(' '), CHUNK_CHARS)]
}

/**
 * The utterance as segments: each paragraph in its language. `say` takes a
 * run of same-language paragraphs whole; Kokoro takes
 * chunks of a few sentences, the first one short, so audio starts soon and the
 * next chunk is made while one plays.
 */
export function planSpeech(text: string, engine: Engine): Segment[] {
  const segments: Segment[] = []
  for (const { text: paragraph, lang } of labelParagraphs(text)) {
    const last = segments.at(-1)
    if (engine === 'say') {
      if (last !== undefined && last.lang === lang) last.text = `${last.text}\n\n${paragraph}`
      else segments.push({ text: paragraph, lang })
      continue
    }
    for (const piece of segments.length === 0 ? splitFirst(paragraph) : splitLong(paragraph, CHUNK_CHARS)) {
      const now = segments.at(-1)
      const max = segments.length <= 1 ? FIRST_CHUNK_CHARS : CHUNK_CHARS
      if (now !== undefined && now.lang === lang && now.text.length + 2 + piece.length <= max) {
        now.text = `${now.text}\n\n${piece}`
      } else segments.push({ text: piece, lang })
    }
  }
  return segments
}
