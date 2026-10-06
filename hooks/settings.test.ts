import { expect, test } from 'claude-code/testing'

import { describeVoices, firstSpanishVoice, parseVoiceArgs, parseVoiceEntries, toSettings } from './settings'

const LISTING = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Isabela (Enhanced)  es_AR    # ¡Hola! Me llamo Isabela.',
  'Mónica              es_ES    # ¡Hola! Me llamo Mónica.',
  '',
].join('\n')

test('with nothing stored: kokoro, 190 wpm, af_heart and ef_dora, say voices unset', () => {
  expect(toSettings({})).toEqual({
    engine: 'kokoro',
    rate: 190,
    voices: { say: { en: undefined, es: undefined }, kokoro: { en: 'af_heart', es: 'ef_dora' } },
  })
})

test('stored values come through; wrong shapes count as unset', () => {
  const s = toSettings({ engine: 'say', rate: 250, voice: 'Albert', sayVoiceEs: 'Mónica', kokoroVoiceEs: 'em_alex' })
  expect(s.engine).toBe('say')
  expect(s.rate).toBe(250)
  expect(s.voices.say).toEqual({ en: 'Albert', es: 'Mónica' })
  expect(s.voices.kokoro).toEqual({ en: 'af_heart', es: 'em_alex' })
  expect(toSettings({ engine: 'espeak', rate: 7, voice: '' }).engine).toBe('kokoro')
})

test('say voices parse with their locales; the first es_ voice is the Spanish default', () => {
  expect(parseVoiceEntries(LISTING)).toEqual([
    { name: 'Albert', locale: 'en_US' },
    { name: 'Isabela (Enhanced)', locale: 'es_AR' },
    { name: 'Mónica', locale: 'es_ES' },
  ])
  expect(firstSpanishVoice(LISTING)).toBe('Isabela (Enhanced)')
  expect(firstSpanishVoice('Albert  en_US  # Hi')).toBeUndefined()
})

test('voice arguments: optional language first, English otherwise', () => {
  expect(parseVoiceArgs('es ef_dora')).toEqual({ lang: 'es', name: 'ef_dora' })
  expect(parseVoiceArgs(' EN  Samantha ')).toEqual({ lang: 'en', name: 'Samantha' })
  expect(parseVoiceArgs('es')).toEqual({ lang: 'es', name: '' })
  expect(parseVoiceArgs('Samantha')).toEqual({ lang: 'en', name: 'Samantha' })
  expect(parseVoiceArgs('Eddy (Español (México))')).toEqual({ lang: 'en', name: 'Eddy (Español (México))' })
  expect(parseVoiceArgs('')).toEqual({ lang: 'en', name: '' })
})

test('the voice listing names engine, both voices and how to set them', () => {
  const kokoro = describeVoices('kokoro', { en: 'af_heart', es: 'ef_dora' }, { en: ['af_heart'], es: ['ef_dora'] })
  expect(kokoro).toContain('Engine: kokoro')
  expect(kokoro).toContain('English voice: af_heart')
  expect(kokoro).toContain('Spanish voices: ef_dora')
  expect(kokoro).toContain('/speak-voice [en|es]')
})
