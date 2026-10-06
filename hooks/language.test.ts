import { expect, test } from 'claude-code/testing'

import { classify, detectLanguage, labelParagraphs, scoreLanguage, splitParagraphs } from './language'

test('pure English paragraphs are en', () => {
  expect(classify('The build is green and you can merge it now.')).toBe('en')
  expect(classify('I think this is what you wanted: a test for the parser.')).toBe('en')
})

test('pure Spanish paragraphs are es', () => {
  expect(classify('El plugin está listo y puedes probarlo en la terminal.')).toBe('es')
  expect(classify('Para eso necesitas que el servidor esté corriendo.')).toBe('es')
})

test('Spanish with English tech terms stays es', () => {
  expect(classify('Hice commit del plugin y el build pasó')).toBe('es')
  expect(classify('Corrí los tests del parser y todo pasó en CI.')).toBe('es')
  expect(classify('Agregué un hook para el session start que levanta el server.')).toBe('es')
})

test('strong Spanish signals tip a paragraph with few stopwords', () => {
  expect(classify('¿Listo?')).toBe('es')
  expect(classify('¡Perfecto, señor!')).toBe('es')
})

test('short or ambiguous lines are undecided', () => {
  expect(classify('OK.')).toBeUndefined()
  expect(classify('Done')).toBeUndefined()
  expect(classify('npm run build')).toBeUndefined()
  expect(classify('')).toBeUndefined()
})

test('inline code, identifiers, paths and URLs are ignored', () => {
  // Without the filter `the_value`, `isTheOne` and the URL's words would count as English.
  const { en } = scoreLanguage('`the and is` the_value isTheOne https://the.and.is/to/of src/the/and.ts')
  expect(en).toBe(0)
  expect(classify('Revisa `the config` en https://example.com/the/docs para que funcione.')).toBe('es')
})

test('splits paragraphs on blank lines, dropping empty ones', () => {
  expect(splitParagraphs('One.\n\n\n  Two.\n  \nThree')).toEqual(['One.', 'Two.', 'Three'])
  expect(splitParagraphs('  \n ')).toEqual([])
})

test('the overall language: the sum of the evidence, en when unclear', () => {
  expect(detectLanguage('Listo. El plugin está instalado y funciona.')).toBe('es')
  expect(detectLanguage('All set. The plugin is installed and it works.')).toBe('en')
  expect(detectLanguage('OK.')).toBe('en')
  expect(detectLanguage('')).toBe('en')
})

test('mixed paragraphs each keep their own language', () => {
  const text = [
    'Here is the summary of what I changed in the plugin.',
    'Y aquí está la explicación en español para que la compartas con el equipo.',
    'The tests are green.',
  ].join('\n\n')
  expect(labelParagraphs(text).map(p => p.lang)).toEqual(['en', 'es', 'en'])
})

test('short paragraphs inherit the message language', () => {
  const es = 'Listo.\n\nEl build pasó y los tests están en verde, así que puedes hacer merge.\n\nOK.'
  expect(labelParagraphs(es)).toEqual([
    { text: 'Listo.', lang: 'es' },
    { text: 'El build pasó y los tests están en verde, así que puedes hacer merge.', lang: 'es' },
    { text: 'OK.', lang: 'es' },
  ])
  const en = 'Done.\n\nThe build passed and the tests are green, so you can merge it.\n\nOK.'
  expect(labelParagraphs(en).map(p => p.lang)).toEqual(['en', 'en', 'en'])
})

test('a message of only short lines reads as English', () => {
  expect(labelParagraphs('OK.\n\nDone.').map(p => p.lang)).toEqual(['en', 'en'])
})
