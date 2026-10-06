import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  Register,
} from 'claude-code'

import {
  INSTALL_NOTICE,
  UV_HELP,
  shouldShowInstallNotice,
  spacyInstallArgv,
  tail,
  uvCandidates,
  uvInstallArgv,
} from './install'
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
  HEALTH_ARGV,
  HEARTBEAT_MS,
  LISTENER_ARGV,
  STALE_WAV_MINUTES,
  cacheDir,
  daemonArgv,
  entryName,
  hasOtherLiveSessions,
  isHealthyReply,
  isKokoroServerCommand,
  kokoroServerArgv,
  logDir,
  parsePids,
  registryDir,
  wavDir,
} from './server'
import {
  BUILTIN_KOKORO_VOICES,
  KOKORO_PORT,
  type Engine,
  type Segment,
  kokoroCurlArgv,
  kokoroRequestBody,
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
/** Each install step may take up to ten minutes, `$.process.run`'s most. */
const INSTALL_STEP_MS = 600_000
/** When the install notice was last shown, in `$.store`. */
const NOTICE_KEY = 'installNoticeAt'

// Module variables reset on a reload, and an unload kills every child, so a
// stale `speaking` left in $.state reads as idle. The Kokoro server is no
// child: it runs detached, shared by the sessions in the registry.
let current: Utterance | null = null
let hasRegistered = false
let hasWarned = false
let serverStarting: Promise<boolean> | null = null
/** This session's registry entry, once it uses the server. */
let registryEntry: string | null = null
let heartbeat: { cancel: () => void } | null = null
let wavDirReady: string | null = null
/** Keeps this load's WAV names apart from other sessions' in the shared directory. */
const loadToken = Math.random().toString(36).slice(2, 10)
let fileCount = 0
/** The first Spanish `say` voice; undefined until looked up, null when there is none. */
let spanishSayVoice: string | null | undefined
let isInstalling = false

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
      name: 'speak-install',
      description: 'Install Kokoro, the natural local voices (needs uv); --repair reinstalls',
      argumentHint: '[--repair]',
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
    const { exitCode, stdout } = await $.process.run(HEALTH_ARGV, { timeoutMs: 3000 })
    return isHealthyReply(exitCode, stdout)
  } catch {
    return false
  }
}

/** Makes the plugin's cache directories; resolves whether they are there. */
async function ensureCacheDirs($: EngineInterface, dir: string): Promise<boolean> {
  try {
    const made = await $.process.run(['/bin/mkdir', '-p', registryDir(dir), wavDir(dir), logDir(dir)])
    return made.exitCode === 0
  } catch (error) {
    log($, `could not make the cache directories: ${String(error)}`)
    return false
  }
}

/** Starts the Kokoro server unless one answers on the port; resolves whether it is up. */
async function ensureServer($: EngineInterface): Promise<boolean> {
  const isUp = await isServerUp($)
  if (!isUp) {
    serverStarting ??= startServer($).finally(() => {
      serverStarting = null
    })
    if (!(await serverStarting)) return false
  }
  await joinRegistry($)
  return true
}

async function startServer($: EngineInterface): Promise<boolean> {
  const dir = await home($)
  if (dir === undefined || !(await isKokoroInstalled($)) || !(await ensureCacheDirs($, dir))) return false
  try {
    // Detached, in the cache directory: a reload leaves it running, and no `logs/` lands in the project.
    const started = await $.process.run(daemonArgv(kokoroServerArgv(dir)), {
      cwd: cacheDir(dir),
      env: { SPEAK_ALOUD_LOG: `${logDir(dir)}/server.log` },
    })
    if (started.exitCode !== 0) {
      log($, `could not start the Kokoro server: ${tail(started.stderr, 5)}`)
      return false
    }
  } catch (error) {
    log($, `could not start the Kokoro server: ${String(error)}`)
    return false
  }
  for (let i = 0; i < SERVER_POLLS; i++) {
    await $.clock.sleep(SERVER_POLL_MS)
    if (await isServerUp($)) return true
  }
  log($, `the Kokoro server did not answer in time; see ${logDir(dir)}/server.log`)
  return false
}

/** Writes this session's heartbeat into the registry. */
async function beat($: EngineInterface, dir: string, name: string) {
  try {
    await $.fs.write(`${registryDir(dir)}/${name}`, String(await $.clock.now()))
  } catch (error) {
    log($, `could not write the session registry: ${String(error)}`)
  }
}

/** Marks this session as one using the server, once per load, and keeps the mark fresh. */
async function joinRegistry($: EngineInterface) {
  if (registryEntry !== null) return
  const dir = await home($)
  if (dir === undefined) return
  let id = 'session'
  try {
    id = await $.session.id()
  } catch {
    // One entry under a fixed name still keeps the server for this session.
  }
  const name = entryName(id)
  registryEntry = name
  if (!(await ensureCacheDirs($, dir))) return
  await beat($, dir, name)
  heartbeat ??= $.clock.every(HEARTBEAT_MS, () => void beat($, dir, name))
}

/**
 * At the session's end: drops its registry entry and, when no other live
 * session uses the server, stops it. `force` (a repair) stops it regardless.
 */
async function leaveRegistry($: EngineInterface, force = false) {
  const name = registryEntry
  registryEntry = null
  heartbeat?.cancel()
  heartbeat = null
  const dir = await home($)
  if (dir === undefined || (name === null && !force)) return
  try {
    if (name !== null) await $.process.run(['/bin/rm', '-f', `${registryDir(dir)}/${name}`])
    if (!force) {
      const entries: { name: string; text: string }[] = []
      for (const entry of await $.fs.list(registryDir(dir))) {
        if (entry.kind !== 'file') continue
        entries.push({ name: entry.name, text: await $.fs.read(`${registryDir(dir)}/${entry.name}`) })
      }
      if (hasOtherLiveSessions(entries, name ?? '', await $.clock.now())) return
    }
    await killServer($)
  } catch (error) {
    log($, `could not stop the Kokoro server: ${String(error)}`)
  }
}

/** Kills whatever mlx-audio server listens on the port (only an mlx-audio server). */
async function killServer($: EngineInterface) {
  const { stdout } = await $.process.run(LISTENER_ARGV)
  for (const pid of parsePids(stdout)) {
    const ps = await $.process.run(['/bin/ps', '-p', String(pid), '-o', 'command='])
    if (isKokoroServerCommand(ps.stdout)) await $.process.run(['/bin/kill', String(pid)])
  }
}

/**
 * Has the server load the model for each language, so the first read is
 * quick; resolves whether every request went through. A first run downloads
 * the model, so the install gives it longer.
 */
async function warmModel($: EngineInterface, settings: Settings, langs: readonly Lang[], timeoutMs = 60_000) {
  let isWarm = true
  for (const lang of langs) {
    try {
      const said = lang === 'es' ? 'Listo.' : 'Ready.'
      const { exitCode, stderr } = await $.process.run(kokoroCurlArgv('/dev/null', Math.floor(timeoutMs / 1000) - 5), {
        stdin: kokoroRequestBody(said, lang, settings.voices.kokoro[lang], settings.rate),
        timeoutMs,
      })
      if (exitCode !== 0) {
        isWarm = false
        log($, `could not warm the Kokoro model (${lang}): ${tail(stderr, 5)}`)
      }
    } catch (error) {
      isWarm = false
      log($, `could not warm the Kokoro model (${lang}): ${String(error)}`)
    }
  }
  return isWarm
}

/**
 * At load: with Kokoro chosen and installed, start its server and load the
 * model; chosen but missing, say how to install it (at most once a day).
 * With say chosen it does nothing.
 */
async function startKokoro($: EngineInterface) {
  const settings = await readSettings($)
  if (settings.engine !== 'kokoro' || isInstalling) return
  if (!(await isKokoroInstalled($))) {
    await noticeInstall($)
    return
  }
  if (await ensureServer($)) await warmModel($, settings, ['en'])
}

/** The install notice, as a toast, unless shown in the last day; it stands in for the fallback toast. */
async function noticeInstall($: EngineInterface) {
  try {
    const now = await $.clock.now()
    if (!shouldShowInstallNotice(await $.store.get(NOTICE_KEY), now)) return
    await $.store.set(NOTICE_KEY, now)
  } catch (error) {
    log($, `could not check the install notice: ${String(error)}`)
    return
  }
  hasWarned = true
  log($, INSTALL_NOTICE)
  $.ui.toast(`speak-aloud: ${INSTALL_NOTICE}`, { timeoutMs: 15_000 })
}

/** Says once per load, in the debug log and a toast, that Kokoro gave way to `say`. */
function warnFallback($: EngineInterface, why: string) {
  if (hasWarned) return
  hasWarned = true
  log($, `Kokoro is unavailable (${why}); reading with say instead`)
  $.ui.toast(`speak-aloud: Kokoro is unavailable (${why}); reading with say.`)
}

/**
 * The shared WAV directory, made once per load; WAVs a read long done left
 * behind (a reload mid-read) are cleared then.
 */
async function ensureWavDir($: EngineInterface): Promise<string | undefined> {
  if (wavDirReady !== null) return wavDirReady
  const dir = await home($)
  if (dir === undefined || !(await ensureCacheDirs($, dir))) return undefined
  wavDirReady = wavDir(dir)
  void $.process
    .run(['/usr/bin/find', wavDirReady, '-name', '*.wav', '-mmin', `+${STALE_WAV_MINUTES}`, '-delete'])
    .catch(() => {})
  return wavDirReady
}

function removeFile($: EngineInterface, path: string) {
  void $.process.run(['/bin/rm', '-f', path]).catch(() => {})
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
  const dir = await ensureWavDir($)
  if (dir === undefined) return undefined
  fileCount += 1
  const out = `${dir}/${loadToken}-${fileCount}.wav`
  const voice = settings.voices.kokoro[segment.lang]
  const code = await runChild($, mine, {
    argv: kokoroCurlArgv(out),
    input: kokoroRequestBody(segment.text, segment.lang, voice, settings.rate),
  })
  if (code === 0) return out
  removeFile($, out)
  return undefined
}

/** Ends a read at once: marks it stopped and kills every child it has running. */
function halt(utterance: Utterance | null) {
  if (utterance === null) return
  utterance.isStopped = true
  // Not awaited: ending each loop kills its child, and nothing waits on its last words.
  for (const child of utterance.children) void child.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
}

/** Stops the current read, if any; resolves whether one was running. */
async function stop($: EngineInterface): Promise<boolean> {
  const was = current
  current = null
  halt(was)
  await update($, speaking, () => '')
  return was !== null
}

/** Which engine reads now: Kokoro when chosen and its server is up, else `say`. */
async function engineFor($: EngineInterface, settings: Settings): Promise<Engine> {
  if (settings.engine !== 'kokoro') return 'say'
  if (await ensureServer($)) return 'kokoro'
  if (await isKokoroInstalled($)) warnFallback($, 'its server did not start')
  else await noticeInstall($)
  return 'say'
}

/**
 * Reads `markdown` aloud as the block `key`, stopping any current read;
 * resolves once it has all been read or the read was stopped. Each paragraph
 * is read in its language; with Kokoro, the next chunk is made while one plays.
 */
async function speak($: EngineInterface, markdown: string, key: string): Promise<void> {
  const text = stripMarkdown(markdown)
  // Before any await: a second read started meanwhile must find this one current, to stop it.
  const mine: Utterance = { children: new Set(), isStopped: false }
  halt(current)
  current = mine
  if (text === '') {
    current = null
    await update($, speaking, () => '')
    return
  }
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
  return 'Kokoro: not installed; run /speak-install. Reading falls back to say.'
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
  $.clock.after(0, () => void startKokoro($))
  return `Engine set to kokoro.\n${await kokoroStatus($)}`
}

/** Finds uv where its installer or Homebrew puts it. */
async function findUv($: EngineInterface, dir: string): Promise<string | undefined> {
  for (const path of uvCandidates(dir)) {
    try {
      if (await $.fs.exists(path)) return path
    } catch {
      // Not readable: try the next.
    }
  }
  return undefined
}

function installStatus($: EngineInterface, step: number, what: string) {
  $.ui.status(`speak-aloud: installing Kokoro, step ${step}/4: ${what}…`)
}

/** Runs the install's steps in order; resolves the failure's message, or undefined when all went through. */
async function installSteps($: EngineInterface, uv: string, dir: string, isRepair: boolean) {
  const commands: [string, string[]][] = [
    ['mlx-audio (uv tool install)', uvInstallArgv(uv, isRepair)],
    ['spaCy English model', spacyInstallArgv(uv, dir)],
  ]
  for (const [i, [what, argv]] of commands.entries()) {
    installStatus($, i + 1, what)
    try {
      const { exitCode, stdout, stderr } = await $.process.run(argv, { timeoutMs: INSTALL_STEP_MS })
      if (exitCode !== 0) {
        log($, `install step ${i + 1} failed (${exitCode}):\n${stderr || stdout}`)
        return `step ${i + 1}/4 (${what}) failed: ${tail(stderr || stdout, 6) || `exit code ${exitCode}`}`
      }
    } catch (error) {
      return `step ${i + 1}/4 (${what}) failed: ${String(error)}`
    }
  }
  installStatus($, 3, 'starting the Kokoro server')
  if (!(await ensureServer($))) return 'step 3/4 (starting the Kokoro server) failed: it did not answer within 30 s.'
  installStatus($, 4, 'downloading the model (~680 MB the first time) and warming English and Spanish')
  const settings = await readSettings($)
  if (!(await warmModel($, settings, ['en', 'es'], INSTALL_STEP_MS))) {
    return 'step 4/4 (downloading and warming the model) failed; see the debug log.'
  }
  return undefined
}

async function runInstall($: EngineInterface, uv: string, dir: string, isRepair: boolean) {
  isInstalling = true
  try {
    // A repair replaces the Python the running server was started from.
    if (isRepair) await leaveRegistry($, true)
    const failure = await installSteps($, uv, dir, isRepair)
    if (failure === undefined) {
      await $.store.set('engine', 'kokoro')
      await $.store.delete(NOTICE_KEY)
      hasWarned = false
      $.ui.toast('speak-aloud: Kokoro is installed — reading with natural voices.', { timeoutMs: 10_000 })
    } else {
      log($, `Kokoro install failed at ${failure}`)
      $.ui.toast(`speak-aloud: Kokoro install failed at ${failure}\nReading with say until it is fixed; /speak-install --repair retries.`, {
        timeoutMs: 30_000,
      })
    }
  } catch (error) {
    log($, `Kokoro install failed: ${String(error)}`)
    $.ui.toast(`speak-aloud: Kokoro install failed: ${String(error)}`, { timeoutMs: 30_000 })
  } finally {
    isInstalling = false
    $.ui.status(undefined)
  }
}

/** `/speak-install [--repair]`: answers at once; the install runs on, its progress in the status line. */
async function installCommand($: EngineInterface, args: string): Promise<string> {
  const wanted = args.trim().toLowerCase()
  if (wanted !== '' && wanted !== '--repair' && wanted !== 'repair') return 'Usage: /speak-install [--repair]'
  const isRepair = wanted !== ''
  if (isInstalling) return 'Kokoro is already being installed; progress is in the status line.'
  const dir = await home($)
  if (dir === undefined) return 'Could not install Kokoro: HOME is not set.'

  if (!isRepair && (await isKokoroInstalled($))) {
    await $.store.set('engine', 'kokoro')
    if (await isServerUp($)) return 'Kokoro is already installed and its server is running. /speak-install --repair reinstalls it.'
    $.clock.after(0, () => void startKokoro($))
    return 'Kokoro is already installed; starting its server. /speak-install --repair reinstalls it.'
  }

  const uv = await findUv($, dir)
  if (uv === undefined) return UV_HELP
  // On a timer, so the install outlives this command's dispatch.
  $.clock.after(0, () => void runInstall($, uv, dir, isRepair))
  return `${isRepair ? 'Reinstalling' : 'Installing'} Kokoro… progress in the status line.`
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
    $.clock.after(0, () => void startKokoro($))
    return started
  })

  on('session.end', async ($, e, next) => {
    await stop($)
    // A /clear or a resume goes on in this process, still reading aloud.
    if (e.reason !== 'clear' && e.reason !== 'resume') await leaveRegistry($)
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
      $.clock.after(0, () => void startKokoro($))
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

  on('command.run', { command: 'speak-install' }, async ($, e) => ({ text: await installCommand($, e.args) }))

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
          <Button
            key="speak"
            label="🔊"
            // On a timer, so the read and its children outlive the press's dispatch.
            onPress={() => {
              $.clock.after(0, () => void speak($, text, key))
            }}
          />
        )}
      </Box>
    )
  })
}
