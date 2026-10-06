/**
 * The Kokoro server's life across sessions, as pure helpers.
 *
 * The server runs detached (nohup), so a plugin reload never kills it and
 * every session on the machine shares the one on the port. Each session that
 * uses it keeps an entry in a registry directory, its heartbeat the time
 * written in it; the session that ends last stops the server.
 */

import { KOKORO_PORT, KOKORO_URL } from './speech'

/** How often a session refreshes its registry entry, and when an entry counts as dead. */
export const HEARTBEAT_MS = 60_000
export const STALE_MS = 3 * HEARTBEAT_MS
/** WAVs older than this, in the shared WAV directory, are left over from a read long done. */
export const STALE_WAV_MINUTES = 10

/** The plugin's own directory under the user's caches. */
export function cacheDir(home: string): string {
  return `${home}/Library/Caches/speak-aloud`
}

export function registryDir(home: string): string {
  return `${cacheDir(home)}/sessions`
}

export function wavDir(home: string): string {
  return `${cacheDir(home)}/wav`
}

export function logDir(home: string): string {
  return `${cacheDir(home)}/logs`
}

/** A file name safe for a registry entry, from a session id. */
export function entryName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'session'
}

/** curl asking the server for its model list: an mlx-audio server answers `{"object":"list", ...}`. */
export const HEALTH_ARGV: readonly string[] = ['/usr/bin/curl', '-sf', '-m', '1', `${KOKORO_URL}/v1/models`]

/** Whether the health check's output is an mlx-audio server's, not any other process on the port. */
export function isHealthyReply(exitCode: number, stdout: string): boolean {
  if (exitCode !== 0) return false
  try {
    const body = JSON.parse(stdout) as { object?: unknown; data?: unknown }
    return body.object === 'list' && Array.isArray(body.data)
  } catch {
    return false
  }
}

/** The server's command line: logs into the plugin's cache, not the session's directory. */
export function kokoroServerArgv(home: string): string[] {
  return [
    `${home}/.local/bin/mlx_audio.server`,
    '--host',
    '127.0.0.1',
    '--port',
    String(KOKORO_PORT),
    '--log-dir',
    logDir(home),
  ]
}

/**
 * Starts `argv` detached from the session (nohup, in the background, output
 * to `$SPEAK_ALOUD_LOG`); the shell exits at once, so a `$.process.run` of it
 * returns, and an unload has no child left to kill.
 */
export function daemonArgv(argv: readonly string[]): string[] {
  return ['/bin/sh', '-c', 'nohup "$@" >>"$SPEAK_ALOUD_LOG" 2>&1 </dev/null &', 'speak-aloud', ...argv]
}

/** lsof listing the pids listening on the server's port. */
export const LISTENER_ARGV: readonly string[] = ['/usr/sbin/lsof', '-t', '-n', `-iTCP:${KOKORO_PORT}`, '-sTCP:LISTEN']

/** The pids in lsof's `-t` output. */
export function parsePids(stdout: string): number[] {
  return stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^\d+$/.test(l))
    .map(Number)
}

/** Whether a `ps -o command=` line is the mlx-audio server's, so killing it kills nothing else. */
export function isKokoroServerCommand(command: string): boolean {
  return /mlx_audio[./]server/.test(command)
}

/** Whether any session other than `self` has a live registry entry. */
export function hasOtherLiveSessions(
  entries: readonly { name: string; text: string }[],
  self: string,
  now: number,
): boolean {
  return entries.some(({ name, text }) => {
    if (name === self) return false
    const beat = Number(text.trim())
    return Number.isFinite(beat) && now - beat < STALE_MS
  })
}
