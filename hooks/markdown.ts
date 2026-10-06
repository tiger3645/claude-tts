/**
 * Turns a markdown answer into plain text worth hearing: code blocks are
 * skipped silently, URLs are dropped (link text kept), and the
 * markers of headings, lists, quotes, emphasis and tables go.
 */
export function stripMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  let fence: string | null = null

  for (const line of lines) {
    const opener = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence !== null) {
      if (opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length) fence = null
      continue
    }
    if (opener !== undefined) {
      fence = opener
      // Skipped silently; the blank line keeps the text around it apart.
      kept.push('')
      continue
    }
    const plain = stripLine(line)
    if (plain !== null) kept.push(plain)
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** One line outside a code fence; null for a line that says nothing. */
function stripLine(raw: string): string | null {
  let line = raw

  // A horizontal rule is a paragraph break; a table's separator row nothing.
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return ''
  if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) return null

  // Table rows: cells read as a list.
  if (/^\s*\|.*\|\s*$/.test(line)) {
    line = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map(cell => cell.trim())
      .join(', ')
  }

  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '') // heading
    .replace(/^(\s*>\s?)+/, '') // quote
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '') // list item, task box
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image: alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // link: its text
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1') // reference link
    .replace(/<(https?:\/\/[^>]+)>/g, 'link') // autolink
    .replace(/<\/?[A-Za-z][^>]*>/g, '') // html tags
    .replace(/https?:\/\/[^\s)]+?(?=[.,;:!?]?(\s|$))/g, 'link') // bare URL
    .replace(/`+([^`]*)`+/g, '$1') // inline code
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2') // bold
    .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?!\w)/g, '$1$2') // *em*
    .replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1$2') // _em_
    .replace(/~~(.+?)~~/g, '$1') // strikethrough
    .trimEnd()
}
