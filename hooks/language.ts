/** The languages speech tells apart. */
export type Lang = 'en' | 'es'

const SPANISH = new Set(
  'el la los las que de y en un una para por con es está no se lo como más pero sus al del esto puedes quieres'.split(' '),
)
const ENGLISH = new Set('the and is are to of in that it you for with this on be not can what i'.split(' '))

/** A paragraph needs this much evidence before it decides for itself. */
const MIN_EVIDENCE = 2

/**
 * Text with what is not prose taken out: inline code, URLs, paths, and
 * identifiers (snake_case, camelCase, dotted names, anything with a digit).
 */
function proseWords(text: string): string[] {
  const prose = text
    .replace(/`[^`]*`/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
  const words: string[] = []
  for (const token of prose.split(/\s+/)) {
    const bare = token.replace(/^[^\p{L}\d_]+|[^\p{L}\d_]+$/gu, '')
    if (bare === '') continue
    if (/[_/\\\d]/.test(bare) || /\p{L}\.\p{L}/u.test(bare) || /\p{Ll}\p{Lu}/u.test(bare)) continue
    words.push(...(bare.toLowerCase().match(/[\p{L}]+/gu) ?? []))
  }
  return words
}

/** The evidence for each language: stopwords, plus Spanish's own letters and marks. */
export function scoreLanguage(text: string): { en: number; es: number } {
  let en = 0
  let es = 0
  const words = proseWords(text)
  for (const word of words) {
    if (ENGLISH.has(word)) en += 1
    if (SPANISH.has(word)) es += 1
    if (/ñ/.test(word)) es += 2
    else if (/[áéíóú]/.test(word)) es += 1
  }
  // ¿ and ¡ count only where prose survived the filter.
  if (words.length > 0) es += 2 * ((text.match(/[¿¡]/g) ?? []).length)
  return { en, es }
}

function decide({ en, es }: { en: number; es: number }): Lang | undefined {
  if (en + es < MIN_EVIDENCE || en === es) return undefined
  return es > en ? 'es' : 'en'
}

/** The paragraph's language, or undefined when it is too short or too even to say. */
export function classify(text: string): Lang | undefined {
  return decide(scoreLanguage(text))
}

/** The message's language over all its text; English when unclear. */
export function detectLanguage(text: string): Lang {
  return classify(text) ?? 'en'
}

/** The paragraphs of plain text: blocks between blank lines, trimmed, empty ones dropped. */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map(p => p.trim())
    .filter(p => p !== '')
}

/** Each paragraph with its language; one that cannot say takes the message's. */
export function labelParagraphs(text: string): { text: string; lang: Lang }[] {
  const overall = detectLanguage(text)
  return splitParagraphs(text).map(p => ({ text: p, lang: classify(p) ?? overall }))
}
