import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  Register,
} from 'claude-code'

import type { Lang } from './language'
import { stripMarkdown } from './markdown'
import {
  DEFAULT_ENGINE,
  DEFAULT_KOKORO_VOICES,
  DEFAULT_RATE,
  LANG_NAMES,
  RATE_RANGE_MESSAGE,
  SETTING_KEYS,
  VOICE_KEYS,
  type Settings,
  describeVoices,
  findVoice,
  firstSpanishVoice,
  isEngine,
  parseRate,
  parseVoiceArgs,
  parseVoices,
  sayArgv,
  toSettings,
} from './settings'
import {
  BUILTIN_KOKORO_VOICES,
  HEALTH_ARGV,
  KOKORO_PORT,
  type Engine,
  type Segment,
  kokoroCurlArgv,
  kokoroRequestBody,
  kokoroServerArgv,
  kokoroServerPath,
  kokoroSnapshotsPath,
  kokoroVoicesFor,
  parseKokoroVoiceFiles,
  planSpeech,
} from './speech'

const latest = atom({ plugin: 'speak-aloud', key: 'latest' } as const, '')
/** Which reply block is being read: its `requestId`, LATEST for /speak, '' for none. */
const speaking = atom({ plugin: 'speak-aloud', key: 'speaking' } as const, '')
const LATEST = '/speak'

type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>
/** One read: every child it has running (curl, afplay, say), and whether it was stopped. */
type Utterance = { children: Set<Child>; isStopped: boolean }

/** How often, and how many times, a starting Kokoro server is asked whether it is up: 30 s in all. */
const SERVER_POLL_MS = 250
const SERVER_POLLS = 120

// Module variables reset on a reload, and an unload kills every child too
// (the server included), so a stale `speaking` left in $.state reads as idle.
let current: Utterance | null = null
let hasRegistered = false
let hasWarned = false
/** The Kokoro server this module started; one already up on the port is reused instead. */
let server: Child | null = null
let serverStarting: Promise<boolean> | null = null
let tempDir: string | null = null
let fileCount = 0
/** The first Spanish `say` voice; undefined until looked up, null when there is none. */
let spanishSayVoice: string | null | undefined

function log($: EngineInterface, text: string) {
  $.ui.log(`speak-aloud: ${text}`, { to: 'debug' })
}

async function registerCommands($: EngineInterface) {
  hasRegistered = true
  try {
    await $.command.register({ name: 'speak', description: "Read Claude's latest response aloud" })
    await $.command.register({ name: 'speak-stop', description: 'Stop reading aloud' })
    await $.command.register({
      name: 'speak-voice',
      description: 'Set the English or Spanish voice for reading aloud; alone, list the voices',
      argumentHint: '[en|es] [name|default]',
    })
    await $.command.register({
      name: 'speak-rate',
      description: 'Set the reading speed in words per minute (80-500)',
      argumentHint: '[wpm|default]',
    })
    await $.command.register({
      name: 'speak-engine',
      description: 'Read aloud with Kokoro (local neural voices) or macOS say; alone, show the engine',
      argumentHint: '[kokoro|say|default]',
    })
  } catch (error) {
    log($, `could not register commands: ${String(error)}`)
  }
}

/**
 * A module loaded or reloaded mid-session has missed the turns that already
 * ended, so `latest` starts from the transcript's last assistant text.
 */
async function seedLatest($: EngineInterface) {
  const known = await read($, latest)
  if (known !== '') return
  const messages = await $.session.messages()
  const last = messages.findLast(m => m.role === 'assistant' && m.text.trim() !== '')
  if (last !== undefined) await update($, latest, () => last.text)
}

async function readSettings($: EngineInterface): Promise<Settings> {
  try {
    const raw: Record<string, unknown> = {}
    for (const key of SETTING_KEYS) raw[key] = await $.store.get(key)
    return toSettings(raw)
  } catch (error) {
    // Speech goes on at the defaults rather than not at all.
    log($, `could not read settings: ${String(error)}`)
    return toSettings({})
  }
}

async function sayListing($: EngineInterface): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(['say', '-v', '?'])
    return exitCode === 0 && parseVoices(stdout).length > 0 ? stdout : undefined
  } catch (error) {
    log($, `could not list voices: ${String(error)}`)
    return undefined
  }
}

async function home($: EngineInterface): Promise<string | undefined> {
  try {
    return (await $.env.get('HOME')) || undefined
  } catch {
    return undefined
  }
}

/** Kokoro's voices from the model's own voices directory, or the built-in list. */
async function kokoroVoices($: EngineInterface): Promise<readonly string[]> {
  const dir = await home($)
  if (dir === undefined) return BUILTIN_KOKORO_VOICES
  try {
    const snapshots = kokoroSnapshotsPath(dir)
    for (const snapshot of await $.fs.list(snapshots)) {
      const files = await $.fs.list(`${snapshots}/${snapshot.name}/voices`)
      const names = parseKokoroVoiceFiles(files.map(f => f.name))
      if (names.length > 0) return names
    }
  } catch (error) {
    log($, `could not read the Kokoro voices, using the built-in list: ${String(error)}`)
  }
  return BUILTIN_KOKORO_VOICES
}

async function isKokoroInstalled($: EngineInterface): Promise<boolean> {
  const dir = await home($)
  if (dir === undefined) return false
  try {
    return await $.fs.exists(kokoroServerPath(dir))
  } catch {
    return false
  }
}

async function isServerUp($: EngineInterface): Promise<boolean> {
  try {
    return (await $.process.run(HEALTH_ARGV, { timeoutMs: 3000 })).exitCode === 0
  } catch {
    return false
  }
}

/** Starts the Kokoro server unless one answers on the port; resolves whether it is up. */
async function ensureServer($: EngineInterface): Promise<boolean> {
  if (await isServerUp($)) return true
  serverStarting ??= startServer($).finally(() => {
    serverStarting = null
  })
  return serverStarting
}

async function startServer($: EngineInterface): Promise<boolean> {
  const dir = await home($)
  if (dir === undefined || !(await isKokoroInstalled($))) return false
  if (server === null) {
    const child = $.process.spawn({ argv: kokoroServerArgv(dir) })
    server = child
    // The loop is the server's life: it runs on until session.end or the unload ends it.
    void (async () => {
      try {
        for await (const _chunk of child) {
          // The server's request log is not worth keeping.
        }
      } catch (error) {
        log($, `the Kokoro server stopped: ${String(error)}`)
      } finally {
        if (server === child) server = null
      }
    })()
  }
  for (let i = 0; i < SERVER_POLLS; i++) {
    await $.clock.sleep(SERVER_POLL_MS)
    if (await isServerUp($)) return true
    if (server === null) return false
  }
  return false
}

function stopServer() {
  const was = server
  server = null
  if (was !== null) void was.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
}

/** Starts the server and has it load the model, so the first read is quick. */
async function warmKokoro($: EngineInterface) {
  const settings = await readSettings($)
  if (settings.engine !== 'kokoro' || !(await ensureServer($))) return
  try {
    await $.process.run(kokoroCurlArgv('/dev/null'), {
      stdin: kokoroRequestBody('Ready.', 'en', settings.voices.kokoro.en, settings.rate),
      timeoutMs: 60_000,
    })
  } catch (error) {
    log($, `could not warm the Kokoro model: ${String(error)}`)
  }
}

/** Says once per load, in the debug log and a toast, that Kokoro gave way to `say`. */
function warnFallback($: EngineInterface, why: string) {
  if (hasWarned) return
  hasWarned = true
  log($, `Kokoro is unavailable (${why}); reading with say instead`)
  $.ui.toast(`speak-aloud: Kokoro is unavailable (${why}); reading with say.`)
}

async function ensureTempDir($: EngineInterface): Promise<string | undefined> {
  if (tempDir !== null) return tempDir
  try {
    const { exitCode, stdout } = await $.process.run(['/usr/bin/mktemp', '-d', '-t', 'speak-aloud'])
    const dir = stdout.trim()
    if (exitCode === 0 && dir.startsWith('/')) tempDir = dir
  } catch (error) {
    log($, `could not make a temporary directory: ${String(error)}`)
  }
  return tempDir ?? undefined
}

function removeFile($: EngineInterface, path: string) {
  void $.process.run(['/bin/rm', '-f', path]).catch(() => {})
}

function removeTempDir($: EngineInterface) {
  const dir = tempDir
  tempDir = null
  if (dir !== null && dir.includes('speak-aloud')) void $.process.run(['/bin/rm', '-rf', dir]).catch(() => {})
}

/** The `say` voice for a language: the one set, else for Spanish the first Spanish voice. */
async function sayVoice($: EngineInterface, settings: Settings, lang: Lang): Promise<string | undefined> {
  const set = settings.voices.say[lang]
  if (set !== undefined || lang === 'en') return set
  if (spanishSayVoice === undefined) {
    const listing = await sayListing($)
    spanishSayVoice = (listing === undefined ? undefined : firstSpanishVoice(listing)) ?? null
  }
  return spanishSayVoice ?? undefined
}

/** Runs one child of the read to its end; resolves its exit code, or undefined if it was stopped or failed. */
async function runChild($: EngineInterface, mine: Utterance, request: ProcessSpawnRequest) {
  if (mine.isStopped) return undefined
  const child = $.process.spawn(request)
  mine.children.add(child)
  try {
    for await (const _chunk of child) {
      // Nothing these children write is worth showing: the loop is the child's life.
    }
    return (await child.result).code
  } catch (error) {
    if (!mine.isStopped) log($, `${request.argv[0]} failed: ${String(error)}`)
    return undefined
  } finally {
    mine.children.delete(child)
  }
}

/** Has the server make one segment's WAV; resolves its path, or undefined when it failed. */
async function generate($: EngineInterface, mine: Utterance, segment: Segment, settings: Settings) {
  const dir = await ensureTempDir($)
  if (dir === undefined) return undefined
  fileCount += 1
  const out = `${dir}/${fileCount}.wav`
  const voice = settings.voices.kokoro[segment.lang]
  const code = await runChild($, mine, {
    argv: kokoroCurlArgv(out),
    input: kokoroRequestBody(segment.text, segment.lang, voice, settings.rate),
  })
  if (code === 0) return out
  removeFile($, out)
  return undefined
}

/** Stops the current read, if any; resolves whether one was running. */
async function stop($: EngineInterface): Promise<boolean> {
  const was = current
  current = null
  if (was !== null) {
    was.isStopped = true
    // Not awaited: ending each loop kills its child, and nothing waits on its last words.
    for (const child of was.children) void child.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
  }
  await update($, speaking, () => '')
  return was !== null
}

/** Which engine reads now: Kokoro when chosen and its server is up, else `say`. */
async function engineFor($: EngineInterface, settings: Settings): Promise<Engine> {
  if (settings.engine !== 'kokoro') return 'say'
  if (await ensureServer($)) return 'kokoro'
  warnFallback($, (await isKokoroInstalled($)) ? 'its server did not start' : 'mlx-audio is not installed')
  return 'say'
}

/**
 * Reads `markdown` aloud as the block `key`, stopping any current read;
 * resolves once it has all been read or the read was stopped. Each paragraph
 * is read in its language; with Kokoro, the next chunk is made while one plays.
 */
async function speak($: EngineInterface, markdown: string, key: string): Promise<void> {
  await stop($)
  const text = stripMarkdown(markdown)
  if (text === '') return

  const mine: Utterance = { children: new Set(), isStopped: false }
  current = mine
  await update($, speaking, () => key)
  const made = new Map<number, Promise<string | undefined>>()
  try {
    const settings = await readSettings($)
    let engine = await engineFor($, settings)
    const segments = planSpeech(text, engine)
    const prepare = (i: number) => {
      const segment = segments[i]
      if (segment !== undefined && !made.has(i)) made.set(i, generate($, mine, segment, settings))
    }
    for (const [i, segment] of segments.entries()) {
      if (mine.isStopped) break
      if (engine === 'kokoro') {
        prepare(i)
        prepare(i + 1)
        const wav = await made.get(i)
        if (mine.isStopped) break
        if (wav !== undefined) {
          await runChild($, mine, { argv: ['/usr/bin/afplay', wav] })
          removeFile($, wav)
          continue
        }
        // The rest of this read goes to `say`, from this segment on.
        engine = 'say'
        warnFallback($, 'its server failed')
      }
      const voice = await sayVoice($, settings, segment.lang)
      await runChild($, mine, { argv: sayArgv({ voice, rate: settings.rate }), input: segment.text })
    }
  } catch (error) {
    log($, `reading failed: ${String(error)}`)
  } finally {
    for (const wav of made.values()) {
      void wav.then(path => path === undefined || removeFile($, path))
    }
    if (current === mine) {
      current = null
      await update($, speaking, () => '')
    }
  }
}

/** Which block is being read, '' when none; a value left from before a reload reads as none. */
async function readSpeaking($: EngineInterface) {
  const key = await read($, speaking)
  return current === null ? '' : key
}

/** `/speak-voice [en|es] [name|default]`: answers the command's text. */
async function voiceCommand($: EngineInterface, args: string): Promise<string> {
  const { lang, name } = parseVoiceArgs(args)
  const settings = await readSettings($)
  const { engine } = settings
  const storeKey = VOICE_KEYS[engine][lang]

  if (name.toLowerCase() === 'default') {
    await $.store.delete(storeKey)
    const fallback =
      engine === 'kokoro'
        ? DEFAULT_KOKORO_VOICES[lang]
        : lang === 'en'
          ? 'the system default'
          : 'the first Spanish voice'
    return `${LANG_NAMES[lang]} voice (${engine}) reset to ${fallback}.`
  }

  let all: readonly string[]
  let choices: Record<Lang, readonly string[]>
  if (engine === 'kokoro') {
    all = await kokoroVoices($)
    choices = { en: kokoroVoicesFor('en', all), es: kokoroVoicesFor('es', all) }
  } else {
    const listing = await sayListing($)
    if (listing === undefined) return "Could not list voices: `say -v '?'` gave nothing."
    all = parseVoices(listing)
    choices = { en: all, es: all }
  }

  if (name === '') {
    const current: Record<Lang, string> =
      engine === 'kokoro'
        ? settings.voices.kokoro
        : {
            en: settings.voices.say.en ?? 'system default',
            es: settings.voices.say.es ?? `${(await sayVoice($, settings, 'es')) ?? 'system default'} (default)`,
          }
    return describeVoices(engine, current, choices)
  }

  const found = findVoice(name, choices[lang])
  if ('error' in found) return found.error
  await $.store.set(storeKey, found.name)
  return `${LANG_NAMES[lang]} voice (${engine}) set to ${found.name}.`
}

/** `/speak-rate [wpm|default]`: answers the command's text. */
async function rateCommand($: EngineInterface, args: string): Promise<string> {
  const wanted = args.trim()
  if (wanted === '') {
    const { rate } = await readSettings($)
    return `Speaking rate: ${rate} wpm${rate === DEFAULT_RATE ? ' (default)' : ''}.`
  }
  if (wanted.toLowerCase() === 'default') {
    await $.store.delete('rate')
    return `Speaking rate reset to the default, ${DEFAULT_RATE} wpm.`
  }
  const rate = parseRate(wanted)
  if (rate === undefined) return RATE_RANGE_MESSAGE
  await $.store.set('rate', rate)
  return `Speaking rate set to ${rate} wpm.`
}

async function kokoroStatus($: EngineInterface): Promise<string> {
  if (await isServerUp($)) return `Kokoro: installed, server running on 127.0.0.1:${KOKORO_PORT}.`
  if (await isKokoroInstalled($)) return 'Kokoro: installed; its server starts on the first read.'
  return 'Kokoro: not installed (see the README); reading falls back to say.'
}

/** `/speak-engine [kokoro|say|default]`: answers the command's text. */
async function engineCommand($: EngineInterface, args: string): Promise<string> {
  const wanted = args.trim().toLowerCase()
  if (wanted === '') {
    const { engine } = await readSettings($)
    return `Engine: ${engine}${engine === DEFAULT_ENGINE ? ' (default)' : ''}.\n${await kokoroStatus($)}`
  }
  const engine = wanted === 'default' ? DEFAULT_ENGINE : wanted
  if (!isEngine(engine)) return 'Engine must be kokoro or say, or "default" (kokoro).'
  if (wanted === 'default') await $.store.delete('engine')
  else await $.store.set('engine', engine)
  if (engine === 'say') return 'Engine set to say.'
  $.clock.after(0, () => void warmKokoro($))
  return `Engine set to kokoro.\n${await kokoroStatus($)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await registerCommands($)
    try {
      await seedLatest($)
    } catch (error) {
      log($, `could not read the transcript: ${String(error)}`)
    }
    // On a timer, so the server outlives this dispatch.
    $.clock.after(0, () => void warmKokoro($))
    return started
  })

  on('session.end', async ($, e, next) => {
    await stop($)
    stopServer()
    removeTempDir($)
    if (e.reason === 'clear') await update($, latest, () => '')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.answer.trim() !== '') {
      await update($, latest, () => e.answer)
    }
    // A mod enabled or reloaded mid-session never sees session.start.
    if (!hasRegistered) {
      await registerCommands($)
      $.clock.after(0, () => void warmKokoro($))
    }
    return done
  })

  on('command.run', { command: 'speak' }, async $ => {
    const text = await read($, latest)
    if (text.trim() === '') return { text: 'No response to read yet.' }
    // On a timer, so the children outlive this command's dispatch.
    $.clock.after(0, () => void speak($, text, LATEST))
    return { text: 'Reading the latest response aloud.' }
  })

  on('command.run', { command: 'speak-stop' }, async $ => {
    const wasSpeaking = await stop($)
    return { text: wasSpeaking ? 'Stopped reading.' : 'Nothing is being read.' }
  })

  on('command.run', { command: 'speak-voice' }, async ($, e) => ({ text: await voiceCommand($, e.args) }))

  on('command.run', { command: 'speak-rate' }, async ($, e) => ({ text: await rateCommand($, e.args) }))

  on('command.run', { command: 'speak-engine' }, async ($, e) => ({ text: await engineCommand($, e.args) }))

  // A speaker button beside each reply block, the block itself the engine's own drawing.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    const text = e.props.text
    if (e.props.isSummary === true || stripMarkdown(text) === '') return drawn

    const { Box, Button } = $.ui.resolve(e)
    if (Button === undefined) return drawn
    const key = e.requestId
    const isOn = (await readSpeaking($)) === key
    return (
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {drawn}
        </Box>
        {isOn ? (
          <Button key="stop" label="■" onPress={() => stop($)} />
        ) : (
          <Button key="speak" label="🔊" onPress={() => speak($, text, key)} />
        )}
      </Box>
    )
  })
}
