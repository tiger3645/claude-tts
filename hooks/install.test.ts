import { expect, test } from 'claude-code/testing'

import {
  INSTALL_NOTICE,
  SPACY_MODEL_URL,
  shouldShowInstallNotice,
  spacyInstallArgv,
  tail,
  uvCandidates,
  uvInstallArgv,
} from './install'

test('uv is looked for in the user, Homebrew and /usr/local bins', () => {
  expect(uvCandidates('/Users/x')).toEqual(['/Users/x/.local/bin/uv', '/opt/homebrew/bin/uv', '/usr/local/bin/uv'])
})

test('the uv tool install line carries every extra; repair forces it', () => {
  const argv = uvInstallArgv('/opt/homebrew/bin/uv', false)
  expect(argv).toEqual([
    '/opt/homebrew/bin/uv', 'tool', 'install', 'mlx-audio',
    '--with', 'uvicorn', '--with', 'fastapi', '--with', 'python-multipart', '--with', 'webrtcvad-wheels',
    '--with', 'misaki[en]', '--with', 'num2words', '--with', 'spacy', '--with', 'phonemizer-fork',
    '--with', 'espeakng-loader',
  ])
  expect(uvInstallArgv('uv', true).slice(0, 4)).toEqual(['uv', 'tool', 'install', '--force'])
})

test('the spaCy English model goes into the mlx-audio tool python', () => {
  expect(spacyInstallArgv('uv', '/Users/x')).toEqual([
    'uv', 'pip', 'install', '--python', '/Users/x/.local/share/uv/tools/mlx-audio/bin/python', SPACY_MODEL_URL,
  ])
  expect(SPACY_MODEL_URL).toMatch(/en_core_web_sm-3\.8\.0-py3-none-any\.whl$/)
})

test('the tail of an error keeps its last lines', () => {
  expect(tail('a\nb\n\nc\nd\n', 2)).toBe('c\nd')
  expect(tail('', 3)).toBe('')
  expect(tail('x'.repeat(1000), 3).length).toBeLessThanOrEqual(400)
})

test('the install notice shows when never shown, then at most once a day', () => {
  const day = 24 * 60 * 60 * 1000
  expect(shouldShowInstallNotice(undefined, 5)).toBe(true)
  expect(shouldShowInstallNotice('junk', 5)).toBe(true)
  expect(shouldShowInstallNotice(1000, 1000 + day - 1)).toBe(false)
  expect(shouldShowInstallNotice(1000, 1000 + day)).toBe(true)
  expect(INSTALL_NOTICE).toMatch(/\/speak-install/)
})
