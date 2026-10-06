import { expect, test } from 'claude-code/testing'

import {
  HEALTH_ARGV,
  STALE_MS,
  daemonArgv,
  entryName,
  hasOtherLiveSessions,
  isHealthyReply,
  isKokoroServerCommand,
  kokoroServerArgv,
  parsePids,
} from './server'

test('the health check asks for /v1/models and wants an mlx-audio list back', () => {
  expect(HEALTH_ARGV.at(-1)).toBe('http://127.0.0.1:8765/v1/models')
  expect(isHealthyReply(0, '{"object":"list","data":[]}')).toBe(true)
  expect(isHealthyReply(0, '{"message":"Welcome"}')).toBe(false)
  expect(isHealthyReply(0, '<html>other server</html>')).toBe(false)
  expect(isHealthyReply(7, '')).toBe(false)
})

test('the server logs into the plugin cache, never the session directory', () => {
  const argv = kokoroServerArgv('/Users/x')
  expect(argv[0]).toBe('/Users/x/.local/bin/mlx_audio.server')
  expect(argv.slice(1)).toEqual([
    '--host', '127.0.0.1', '--port', '8765', '--log-dir', '/Users/x/Library/Caches/speak-aloud/logs',
  ])
})

test('the daemon line runs the argv under nohup in the background, passed as arguments', () => {
  const argv = daemonArgv(['/a b/server', '--port', '1'])
  expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
  expect(argv[2]).toContain('nohup "$@"')
  expect(argv[2]).toMatch(/&$/)
  expect(argv.slice(4)).toEqual(['/a b/server', '--port', '1'])
})

test('pids and server commands are recognized', () => {
  expect(parsePids('123\n456\n\n')).toEqual([123, 456])
  expect(parsePids('')).toEqual([])
  expect(isKokoroServerCommand('/Users/x/.local/share/uv/tools/mlx-audio/bin/python /Users/x/.local/bin/mlx_audio.server --port 8765')).toBe(true)
  expect(isKokoroServerCommand('python -m http.server 8765')).toBe(false)
})

test('registry entries: a session id makes a safe name', () => {
  expect(entryName('abc-123')).toBe('abc-123')
  expect(entryName('../x/y')).toBe('.._x_y')
  expect(entryName('')).toBe('session')
})

test('only other sessions with a recent heartbeat count as live', () => {
  const now = 1_000_000
  expect(hasOtherLiveSessions([{ name: 'me', text: String(now) }], 'me', now)).toBe(false)
  expect(hasOtherLiveSessions([{ name: 'b', text: String(now - 1000) }], 'me', now)).toBe(true)
  expect(hasOtherLiveSessions([{ name: 'b', text: String(now - STALE_MS) }], 'me', now)).toBe(false)
  expect(hasOtherLiveSessions([{ name: 'b', text: 'junk' }], 'me', now)).toBe(false)
})
