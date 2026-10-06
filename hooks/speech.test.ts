import { expect, test } from 'claude-code/testing'

import {
  CHUNK_CHARS,
  FIRST_CHUNK_CHARS,
  kokoroCurlArgv,
  kokoroLangCode,
  kokoroRequestBody,
  kokoroSpeed,
  kokoroVoicesFor,
  parseKokoroVoiceFiles,
  planSpeech,
  splitLong,
} from './speech'


test('rate maps to Kokoro speed by its natural 153 wpm, clamped to 0.5-2.0', () => {
  expect(kokoroSpeed(153)).toBe(1)
  expect(kokoroSpeed(190)).toBe(1.24)
  expect(kokoroSpeed(80)).toBe(0.52)
  expect(kokoroSpeed(60)).toBe(0.5)
  expect(kokoroSpeed(500)).toBe(2)
})

test('lang codes: Spanish e, American a, British b', () => {
  expect(kokoroLangCode('es', 'ef_dora')).toBe('e')
  expect(kokoroLangCode('en', 'af_heart')).toBe('a')
  expect(kokoroLangCode('en', 'bm_george')).toBe('b')
})

test('the request body carries model, voice, lang code, wav and speed', () => {
  expect(JSON.parse(kokoroRequestBody('Hola', 'es', 'ef_dora', 190))).toEqual({
    model: 'mlx-community/Kokoro-82M-bf16',
    input: 'Hola',
    voice: 'ef_dora',
    lang_code: 'e',
    response_format: 'wav',
    speed: 1.24,
  })
})

test('curl posts stdin to the local server and writes the file', () => {
  const argv = kokoroCurlArgv('/tmp/x/1.wav')
  expect(argv[0]).toBe('/usr/bin/curl')
  expect(argv).toContain('@-')
  expect(argv).toContain('-f')
  expect(argv.at(-1)).toBe('http://127.0.0.1:8765/v1/audio/speech')
  expect(argv[argv.indexOf('-o') + 1]).toBe('/tmp/x/1.wav')
})

test('voice files parse to sorted names; voices split by language', () => {
  const names = parseKokoroVoiceFiles(['ef_dora.safetensors', 'af_heart.safetensors', 'README.md', 'zm_yunxi.pt'])
  expect(names).toEqual(['af_heart', 'ef_dora', 'zm_yunxi'])
  const all = ['af_heart', 'am_adam', 'bf_emma', 'bm_lewis', 'ef_dora', 'em_alex', 'ff_siwis', 'jf_alpha']
  expect(kokoroVoicesFor('en', all)).toEqual(['af_heart', 'am_adam', 'bf_emma', 'bm_lewis'])
  expect(kokoroVoicesFor('es', all)).toEqual(['ef_dora', 'em_alex'])
})

test('splitLong keeps short text whole and groups sentences under the limit', () => {
  expect(splitLong('One. Two.', 400)).toEqual(['One. Two.'])
  const sentence = 'This sentence has some words in it. '
  const long = sentence.repeat(30).trim()
  const groups = splitLong(long, 100)
  expect(groups.every(g => g.length <= 100)).toBe(true)
  expect(groups.join(' ')).toBe(long)
})

test('splitLong breaks a single overlong sentence on words', () => {
  const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')
  const groups = splitLong(words, 50)
  expect(groups.every(g => g.length <= 50)).toBe(true)
  expect(groups.join(' ')).toBe(words)
})

test('say takes runs of same-language paragraphs whole', () => {
  const text = 'The build is green and you can merge it.\n\nOK.\n\nEl plugin está listo y puedes probarlo.'
  expect(planSpeech(text, 'say')).toEqual([
    { text: 'The build is green and you can merge it.\n\nOK.', lang: 'en' },
    { text: 'El plugin está listo y puedes probarlo.', lang: 'es' },
  ])
})

test('Kokoro chunks: a short first chunk, then up to 400 characters, per language', () => {
  const para = 'This is a sentence about the plugin and what it does for you. '.repeat(20).trim()
  const segments = planSpeech(`${para}\n\n${para}`, 'kokoro')
  expect(segments[0]!.text.length).toBeLessThanOrEqual(FIRST_CHUNK_CHARS)
  expect(segments.every(s => s.text.length <= CHUNK_CHARS && s.lang === 'en')).toBe(true)
  expect(segments.map(s => s.text).join(' ').replace(/\s+/g, ' ')).toBe(`${para} ${para}`)
})

test('Kokoro joins small same-language paragraphs, splits on a language change', () => {
  const text = 'The tests are green and the build is done.\n\nYou can merge it.\n\nEl build pasó y los tests están en verde.'
  expect(planSpeech(text, 'kokoro')).toEqual([
    { text: 'The tests are green and the build is done.\n\nYou can merge it.', lang: 'en' },
    { text: 'El build pasó y los tests están en verde.', lang: 'es' },
  ])
})

test('nothing to say plans nothing', () => {
  expect(planSpeech('  \n\n ', 'kokoro')).toEqual([])
})
