import type { ElementTable, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

const PLUGIN = 'speak-aloud'
const SURFACES = ['terminal', 'desktop'] as const

/** One block of an assistant reply, as the transcript asks the plugins to draw it. */
function block(requestId: string, text: string, extra: { isSummary?: true } = {}) {
  return {
    plugin: PLUGIN,
    component: 'AssistantMessage',
    requestId,
    props: { text, isFirstOfReply: true, ...extra },
  } as const
}

type Spawned = { argv: readonly string[]; input?: string; isDone: boolean; isKilled?: boolean }

/** A slice of `say -v '?'`, names with spaces and parentheses included. */
const VOICES = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Alice               it_IT    # Ciao! Mi chiamo Alice.',
  'Aman (Inglés (India)) en_IN    # Hello! My name is Aman.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  '',
].join('\n')

const HOME = '/Users/test'
const SERVER = `${HOME}/.local/bin/mlx_audio.server`
const SNAPSHOTS = `${HOME}/.cache/huggingface/hub/models--mlx-community--Kokoro-82M-bf16/snapshots`
const TEMP = '/tmp/speak-aloud.abc'

/** How the fake Kokoro behaves: whether it is installed, whether its server answers, how curl ends. */
type Kokoro = {
  isInstalled?: boolean
  /** Whether the health check passes; asked each time. */
  isUp?: () => boolean
  /** curl's exit code for the n-th speech request (0 first). */
  curlCode?: (n: number) => number
  voiceFiles?: string[]
}

type Options = {
  during?: (one: Spawned) => Promise<void>
  stored?: Map<string, unknown>
  kokoro?: Kokoro
  toasts?: string[]
  registered?: string[]
  runs?: (readonly string[])[]
  /** More `say -v '?'` lines. */
  moreVoices?: string
}

/**
 * The engine beneath the plugin: its own drawing of a reply block and of the
 * band, a store in memory, a turn that answers with its text, a fake `say`,
 * curl, afplay and Kokoro server that play nothing. `during` runs while a fake
 * child is "playing", so a test can look at the drawing mid-speech. Without
 * `kokoro`, the stored engine is `say`, so the older tests read as before.
 */
function world(
  on: On,
  spawned: Spawned[],
  during?: (one: Spawned) => Promise<void>,
  stored: Map<string, unknown> = new Map(),
  options: Omit<Options, 'during' | 'stored'> = {},
) {
  const { kokoro, toasts, registered, runs, moreVoices = '' } = options
  if (kokoro === undefined && !stored.has('engine')) stored.set('engine', 'say')
  let curls = 0
  on('store.get', (_$, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_$, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    stored.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...stored.keys()] }))
  mock.env(on, { HOME })
  on('fs.exists', (_$, e) => ({ value: kokoro?.isInstalled === true && e.path === SERVER }))
  on('fs.list', (_$, e) => {
    if (kokoro?.voiceFiles === undefined) throw new Error('ENOENT')
    const names = e.path === SNAPSHOTS ? ['snap1'] : kokoro.voiceFiles
    return { value: names.map(name => ({ name, kind: 'file', size: 1 })) as never }
  })
  on('ui.toast', (_$, e) => {
    toasts?.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="engine">
        <Text>{e.props.text}</Text>
      </Box>
    )
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.register', (_$, e) => {
    registered?.push(e.name)
    return { value: { command: e.name } }
  })
  on('process.run', (_$, e) => {
    runs?.push(e.argv)
    const line = e.argv.join(' ')
    const ok = (stdout = '') => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (line === 'say -v ?') return ok(VOICES + moreVoices)
    if (line.startsWith('/usr/bin/mktemp')) return ok(`${TEMP}\n`)
    if (line.startsWith('/usr/bin/curl -sf')) return kokoro?.isUp?.() === true ? ok() : { value: { ...ok().value, exitCode: 7 } }
    if (line.startsWith('/usr/bin/curl')) return ok()
    return { value: { ...ok().value, exitCode: 1 } }
  })
  on('process.spawn', async function* (_$, e, next) {
    const one: Spawned = { argv: e.argv, input: e.input, isDone: false }
    spawned.push(one)
    if (e.argv[0] === SERVER) {
      yield { stream: 'stderr', text: 'starting' } as const
      // The server runs until its loop is ended.
      await new Promise<void>(resolve =>
        next.signal.addEventListener('abort', () => {
          one.isKilled = true
          resolve()
        }),
      )
      return { value: { code: null, signal: 'SIGTERM' } }
    }
    const code = e.argv[0] === '/usr/bin/curl' ? (kokoro?.curlCode?.(curls++) ?? 0) : 0
    yield { stream: 'stdout', text: ' ' } as const
    if (during) await during(one)
    yield { stream: 'stdout', text: ' ' } as const
    one.isDone = true
    return { value: { code, signal: null } }
  })
}

async function answer($: Engine, text: string, agentId?: string) {
  await $.turn.complete({
    answer: text,
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    ...(agentId === undefined ? {} : { agentId }),
  })
}

function runCommand($: Engine, command: string, args = '') {
  return $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
}

async function buttonKeys(ui: Mounted<'terminal', 'AssistantMessage'>) {
  return (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '')
}

test('each reply block keeps the engine drawing and adds an idle speaker button', async ($, on) => {
  world(on, [])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...block('m1', 'Hello there'), surface })
    expect(await ui.find({ key: 'engine' })).toBeDefined()
    expect((await ui.find({ key: 'speak' }))?.text).toContain('🔊')
    expect(await ui.find({ key: 'stop' })).toBeUndefined()
    await ui.unmount()
  }
})

test('summary blocks and blocks with nothing to say get no button', async ($, on) => {
  world(on, [])
  for (const surface of SURFACES) {
    for (const one of [block('s1', 'Ran 3 tools', { isSummary: true }), block('e1', '  ')]) {
      const ui = await $.ui.mount({ ...one, surface })
      expect(await ui.find({ key: 'engine' })).toBeDefined()
      expect(await ui.find({ type: 'Button' })).toBeUndefined()
      await ui.unmount()
    }
  }
})

test('a surface table without Button leaves the engine drawing alone', async ($, on) => {
  world(on, [])
  // The types promise Button everywhere; this stands for a surface that breaks that.
  on('ui.resolve', async (_$, e, next) => {
    const { Button: _gone, ...rest } = await next(e)
    return rest as unknown as ElementTable
  })
  const ui = await $.ui.mount({ ...block('m1', 'Hello'), surface: 'terminal' })
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
})

test('pressing a block speaks its stripped text; only that block shows stop, then flips back', async ($, on) => {
  const spawned: Spawned[] = []
  const box: { a?: Mounted<'terminal', 'AssistantMessage'>; b?: Mounted<'terminal', 'AssistantMessage'> } = {}
  let midA: string[] = []
  let midB: string[] = []
  world(on, spawned, async () => {
    midA = await buttonKeys(box.a!)
    midB = await buttonKeys(box.b!)
  })
  box.a = await $.ui.mount({ ...block('a', '# Done\n\nSee `x` and\n\n```\ncode\n```'), surface: 'terminal' })
  box.b = await $.ui.mount({ ...block('b', 'Other block'), surface: 'terminal' })
  await box.a.press({ key: 'speak' })

  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.input).toBe('Done\n\nSee x and\n\nCode block omitted.')
  expect(spawned[0]?.isDone).toBe(true)
  expect(midA).toEqual(['stop'])
  expect(midB).toEqual(['speak'])
  expect(await buttonKeys(box.a)).toEqual(['speak'])
})

test('stop on the speaking block kills say', async ($, on) => {
  const spawned: Spawned[] = []
  const box: { a?: Mounted<'terminal', 'AssistantMessage'> } = {}
  world(on, spawned, async () => {
    await box.a!.press({ key: 'stop' })
  })
  box.a = await $.ui.mount({ ...block('a', 'A long answer'), surface: 'terminal' })
  await box.a.press({ key: 'speak' })

  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.isDone).toBe(false)
  expect(await buttonKeys(box.a)).toEqual(['speak'])
})

test('pressing another block stops the current one and reads that one', async ($, on) => {
  const spawned: Spawned[] = []
  const box: { a?: Mounted<'terminal', 'AssistantMessage'>; b?: Mounted<'terminal', 'AssistantMessage'> } = {}
  const seen: { a: string[]; b: string[] }[] = []
  world(on, spawned, async () => {
    seen.push({ a: await buttonKeys(box.a!), b: await buttonKeys(box.b!) })
    if (spawned.length === 1) await box.b!.press({ key: 'speak' })
  })
  box.a = await $.ui.mount({ ...block('a', 'First block'), surface: 'terminal' })
  box.b = await $.ui.mount({ ...block('b', 'Second block'), surface: 'terminal' })
  await box.a.press({ key: 'speak' })

  expect(spawned.map(one => one.input)).toEqual(['First block', 'Second block'])
  expect(spawned[0]?.isDone).toBe(false)
  expect(spawned[1]?.isDone).toBe(true)
  expect(seen).toEqual([
    { a: ['stop'], b: ['speak'] },
    { a: ['speak'], b: ['stop'] },
  ])
})

test('the band above the prompt is left to the engine', async ($, on) => {
  world(on, [])
  await answer($, 'Hello there')
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    component: 'AbovePrompt',
    surface: 'terminal',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  })
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
})

test('/speak ignores subagent answers and empty answers', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: Spawned[] = []
  world(on, spawned)
  await answer($, 'from a subagent', 'agent-1')
  await answer($, '')
  expect((await runCommand($, 'speak')).text).toMatch(/no response/i)
  await clock.settle()
  expect(spawned).toHaveLength(0)
})

test('/speak reads the latest answer, stripped', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: Spawned[] = []
  world(on, spawned)
  await answer($, 'first')
  await answer($, '**second**')
  await runCommand($, 'speak')
  await clock.settle()
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.input).toBe('second')
})

test('starting a new read stops the current one', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: Spawned[] = []
  let isNested = false
  world(on, spawned, async () => {
    if (isNested) return
    isNested = true
    await runCommand($, 'speak')
    await clock.settle()
  })
  await answer($, 'Again')
  await runCommand($, 'speak')
  await clock.settle()
  expect(spawned).toHaveLength(2)
  expect(spawned[0]?.isDone).toBe(false)
  expect(spawned[1]?.isDone).toBe(true)
})

test('/speak reads the latest response; with none it says so', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: Spawned[] = []
  world(on, spawned)
  const empty = await runCommand($, 'speak')
  await clock.settle()
  expect(empty.text).toMatch(/no response/i)
  expect(spawned).toHaveLength(0)

  await answer($, 'Read me')
  const ran = await runCommand($, 'speak')
  await clock.settle()
  expect(ran.text).toMatch(/reading/i)
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.input).toBe('Read me')
  expect(spawned[0]?.isDone).toBe(true)
})

test('/speak-stop stops speech, and says so when idle', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: Spawned[] = []
  let stopped = ''
  world(on, spawned, async () => {
    stopped = (await runCommand($, 'speak-stop')).text ?? ''
  })
  expect((await runCommand($, 'speak-stop')).text).toMatch(/nothing/i)
  await answer($, 'Stop me')
  await runCommand($, 'speak')
  await clock.settle()
  expect(stopped).toMatch(/stopped/i)
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.isDone).toBe(false)
})

test('/speak-stop also stops a block read from its button', async ($, on) => {
  const spawned: Spawned[] = []
  let stopped = ''
  world(on, spawned, async () => {
    stopped = (await runCommand($, 'speak-stop')).text ?? ''
  })
  const ui = await $.ui.mount({ ...block('a', 'Block'), surface: 'terminal' })
  await ui.press({ key: 'speak' })
  expect(stopped).toMatch(/stopped/i)
  expect(spawned[0]?.isDone).toBe(false)
  expect(await buttonKeys(ui)).toEqual(['speak'])
})

test('registers /speak and /speak-stop at session start', async ($, on) => {
  const names: string[] = []
  world(on, [], undefined, undefined, { registered: names })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(names).toContain('speak')
  expect(names).toContain('speak-stop')
})

test('a mod loaded after a turn ended seeds /speak from the transcript', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: Spawned[] = []
  world(on, spawned)
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'hi', toolUses: [] },
      { role: 'assistant', text: '**Earlier** answer', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [] },
      { role: 'user', text: 'next', toolUses: [] },
    ],
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await runCommand($, 'speak')
  await clock.settle()
  expect(spawned[0]?.input).toBe('Earlier answer')
})

/** Answers, runs /speak and lets the fake `say` finish; resolves its argv. */
async function spokenArgv($: Engine, clock: { settle: () => Promise<unknown> }, spawned: Spawned[]) {
  await answer($, 'Say it')
  await runCommand($, 'speak')
  await clock.settle()
  return spawned.at(-1)?.argv
}

test('with say and nothing else set, say reads at the default 190 wpm and no voice', async ($, on) => {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>()
  const spawned: Spawned[] = []
  world(on, spawned, undefined, stored)
  expect(await spokenArgv($, clock, spawned)).toEqual(['say', '-r', '190', '-f', '-'])
})

test('voice and rate kept in the store from an earlier session reach say', async ($, on) => {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>(Object.entries({ voice: 'Alice', rate: 300 }))
  const spawned: Spawned[] = []
  world(on, spawned, undefined, stored)
  expect(await spokenArgv($, clock, spawned)).toEqual(['say', '-v', 'Alice', '-r', '300', '-f', '-'])
})

test('/speak-voice sets a known voice, matched without case, and persists it', async ($, on) => {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>()
  const spawned: Spawned[] = []
  world(on, spawned, undefined, stored)
  const set = await runCommand($, 'speak-voice', '  aman (inglés (india)) ')
  expect(set.text).toContain('Aman (Inglés (India))')
  expect(stored.get('voice')).toBe('Aman (Inglés (India))')
  expect(await spokenArgv($, clock, spawned)).toEqual(['say', '-v', 'Aman (Inglés (India))', '-r', '190', '-f', '-'])
})

test('/speak-voice refuses an unknown voice and keeps the current one', async ($, on) => {
  const stored = new Map<string, unknown>(Object.entries({ voice: 'Albert' }))
  world(on, [], undefined, stored)
  const ran = await runCommand($, 'speak-voice', 'Robocop')
  expect(ran.text).toMatch(/unknown voice/i)
  expect(ran.text).toContain('/speak-voice')
  expect(stored.get('voice')).toBe('Albert')
})

test('/speak-voice alone lists voice names and the current voice', async ($, on) => {
  const stored = new Map<string, unknown>(Object.entries({ voice: 'Samantha' }))
  world(on, [], undefined, stored)
  const text = (await runCommand($, 'speak-voice')).text ?? ''
  expect(text).toContain('Albert, Alice, Aman (Inglés (India)), Samantha')
  expect(text).not.toContain('en_US')
  expect(text).not.toContain('Hello!')
  expect(text).toMatch(/English voice: Samantha/)
})

test('/speak-voice alone says the system default when none is set', async ($, on) => {
  const stored = new Map<string, unknown>()
  world(on, [], undefined, stored)
  expect((await runCommand($, 'speak-voice')).text).toMatch(/English voice: system default/)
})

test('/speak-voice default clears the voice', async ($, on) => {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>(Object.entries({ voice: 'Alice' }))
  const spawned: Spawned[] = []
  world(on, spawned, undefined, stored)
  expect((await runCommand($, 'speak-voice', 'default')).text).toMatch(/system default/i)
  expect(stored.get('voice')).toBeUndefined()
  expect(await spokenArgv($, clock, spawned)).toEqual(['say', '-r', '190', '-f', '-'])
})

test('/speak-rate sets a whole wpm from 80 to 500 and persists it', async ($, on) => {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>()
  const spawned: Spawned[] = []
  world(on, spawned, undefined, stored)
  expect((await runCommand($, 'speak-rate', '250')).text).toContain('250')
  expect(stored.get('rate')).toBe(250)
  expect(await spokenArgv($, clock, spawned)).toEqual(['say', '-r', '250', '-f', '-'])
  expect((await runCommand($, 'speak-rate', '80')).text).toContain('80')
  expect((await runCommand($, 'speak-rate', '500')).text).toContain('500')
  expect(stored.get('rate')).toBe(500)
})

test('/speak-rate refuses values outside 80-500 or not whole numbers', async ($, on) => {
  const stored = new Map<string, unknown>(Object.entries({ rate: 300 }))
  world(on, [], undefined, stored)
  for (const bad of ['79', '501', '12.5', 'fast', '-200']) {
    expect((await runCommand($, 'speak-rate', bad)).text).toMatch(/80.*500/)
  }
  expect(stored.get('rate')).toBe(300)
})

test('/speak-rate alone shows the current rate, marking the default', async ($, on) => {
  const stored = new Map<string, unknown>()
  world(on, [], undefined, stored)
  expect((await runCommand($, 'speak-rate')).text).toMatch(/190 wpm \(default\)/)
  await runCommand($, 'speak-rate', '180')
  const shown = (await runCommand($, 'speak-rate')).text ?? ''
  expect(shown).toContain('180 wpm')
  expect(shown).not.toMatch(/default/)
})

test('/speak-rate default resets to 190', async ($, on) => {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>(Object.entries({ rate: 400 }))
  const spawned: Spawned[] = []
  world(on, spawned, undefined, stored)
  expect((await runCommand($, 'speak-rate', 'default')).text).toMatch(/190/)
  expect(stored.get('rate')).toBeUndefined()
  expect(await spokenArgv($, clock, spawned)).toEqual(['say', '-r', '190', '-f', '-'])
})

test('registers /speak-voice, /speak-rate and /speak-engine at session start', async ($, on) => {
  const names: string[] = []
  world(on, [], undefined, undefined, { registered: names })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(names).toContain('speak-voice')
  expect(names).toContain('speak-rate')
  expect(names).toContain('speak-engine')
})

// ---- Kokoro ----

const UP = { isInstalled: true, isUp: () => true } as const
const MIXED = 'Here is what I changed in the plugin for you.\n\nY aquí está la explicación en español para el equipo.'

function speechBody(one: Spawned | undefined) {
  return JSON.parse(one?.input ?? '{}') as { input: string; voice: string; lang_code: string; speed: number }
}

const named = (spawned: Spawned[], program: string) => spawned.filter(one => one.argv[0] === program)

test('Kokoro reads each paragraph in its language, the next chunk made while one plays', async ($, on) => {
  const spawned: Spawned[] = []
  // Snapshot of what was spawned when the first afplay starts.
  let atFirstPlay: string[] = []
  world(
    on,
    spawned,
    async one => {
      if (one.argv[0] === '/usr/bin/afplay' && atFirstPlay.length === 0) atFirstPlay = spawned.map(s => s.argv[0]!)
    },
    undefined,
    { kokoro: UP },
  )
  const ui = await $.ui.mount({ ...block('a', MIXED), surface: 'terminal' })
  await ui.press({ key: 'speak' })

  const curls = named(spawned, '/usr/bin/curl')
  expect(curls).toHaveLength(2)
  expect(speechBody(curls[0])).toEqual(
    expect.objectContaining({ voice: 'af_heart', lang_code: 'a', speed: 1.24, input: 'Here is what I changed in the plugin for you.' }),
  )
  expect(speechBody(curls[1])).toEqual(expect.objectContaining({ voice: 'ef_dora', lang_code: 'e' }))
  expect(atFirstPlay).toEqual(['/usr/bin/curl', '/usr/bin/curl', '/usr/bin/afplay'])
  const plays = named(spawned, '/usr/bin/afplay')
  expect(plays.map(p => p.argv[1])).toEqual([`${TEMP}/1.wav`, `${TEMP}/2.wav`])
  expect(plays.every(p => p.isDone)).toBe(true)
  expect(named(spawned, 'say')).toHaveLength(0)
  expect(await buttonKeys(ui)).toEqual(['speak'])
})

test('Kokoro voices and rate kept in the store reach the request', async ($, on) => {
  const spawned: Spawned[] = []
  const stored = new Map<string, unknown>(Object.entries({ kokoroVoiceEn: 'bm_george', kokoroVoiceEs: 'em_alex', rate: 306 }))
  world(on, spawned, undefined, stored, { kokoro: UP })
  const ui = await $.ui.mount({ ...block('a', MIXED), surface: 'terminal' })
  await ui.press({ key: 'speak' })
  const [en, es] = named(spawned, '/usr/bin/curl').map(speechBody)
  expect(en).toEqual(expect.objectContaining({ voice: 'bm_george', lang_code: 'b', speed: 2 }))
  expect(es).toEqual(expect.objectContaining({ voice: 'em_alex', lang_code: 'e', speed: 2 }))
})

test('stop during Kokoro playback kills afplay and the chunk being made, and reads no more', async ($, on) => {
  const spawned: Spawned[] = []
  const box: { a?: Mounted<'terminal', 'AssistantMessage'> } = {}
  world(
    on,
    spawned,
    async one => {
      if (one.argv[0] === '/usr/bin/afplay') await box.a!.press({ key: 'stop' })
    },
    undefined,
    { kokoro: UP },
  )
  box.a = await $.ui.mount({ ...block('a', MIXED), surface: 'terminal' })
  await box.a.press({ key: 'speak' })
  const plays = named(spawned, '/usr/bin/afplay')
  expect(plays).toHaveLength(1)
  expect(plays[0]?.isDone).toBe(false)
  expect(named(spawned, 'say')).toHaveLength(0)
  expect(await buttonKeys(box.a)).toEqual(['speak'])
})

test('Kokoro not installed: say reads instead, Spanish in the first Spanish voice, one toast', async ($, on) => {
  const spawned: Spawned[] = []
  const toasts: string[] = []
  world(on, spawned, undefined, undefined, {
    kokoro: { isInstalled: false },
    toasts,
    moreVoices: 'Mónica              es_ES    # ¡Hola! Me llamo Mónica.\n',
  })
  const ui = await $.ui.mount({ ...block('a', MIXED), surface: 'terminal' })
  await ui.press({ key: 'speak' })
  await ui.press({ key: 'speak' })

  const says = named(spawned, 'say')
  expect(says.map(s => s.argv)).toEqual([
    ['say', '-r', '190', '-f', '-'],
    ['say', '-v', 'Mónica', '-r', '190', '-f', '-'],
    ['say', '-r', '190', '-f', '-'],
    ['say', '-v', 'Mónica', '-r', '190', '-f', '-'],
  ])
  expect(named(spawned, '/usr/bin/curl')).toHaveLength(0)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/not installed/)
})

test('a failed Kokoro request hands the rest of the read to say', async ($, on) => {
  const spawned: Spawned[] = []
  const toasts: string[] = []
  world(on, spawned, undefined, undefined, { kokoro: { ...UP, curlCode: n => (n === 1 ? 22 : 0) }, toasts })
  const ui = await $.ui.mount({ ...block('a', MIXED), surface: 'terminal' })
  await ui.press({ key: 'speak' })
  expect(named(spawned, '/usr/bin/afplay')).toHaveLength(1)
  const says = named(spawned, 'say')
  expect(says.map(s => s.input)).toEqual(['Y aquí está la explicación en español para el equipo.'])
  expect(toasts).toHaveLength(1)
})

test('with Kokoro installed but down, the mod starts its server, waits for it, and stops it at session end', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: Spawned[] = []
  let isUp = false
  world(on, spawned, undefined, undefined, { kokoro: { isInstalled: true, isUp: () => isUp } })
  on('session.end', () => ({ sessionId: 's1' }))
  await answer($, 'Read this to me, it is short.')
  await runCommand($, 'speak')
  await clock.settle()
  const servers = named(spawned, SERVER)
  expect(servers.map(s => s.argv)).toEqual([[SERVER, '--host', '127.0.0.1', '--port', '8765']])
  expect(named(spawned, '/usr/bin/curl')).toHaveLength(0)

  isUp = true
  await clock.advance(300)
  await clock.settle()
  expect(named(spawned, '/usr/bin/afplay')).toHaveLength(1)
  expect(named(spawned, SERVER)).toHaveLength(1)

  await $.session.end({ reason: 'other' } as never)
  await clock.settle()
  expect(servers[0]?.isKilled).toBe(true)
})

test('/speak-engine shows, sets and resets the engine', async ($, on) => {
  const stored = new Map<string, unknown>()
  world(on, [], undefined, stored, { kokoro: { isInstalled: false } })
  const shown = (await runCommand($, 'speak-engine')).text ?? ''
  expect(shown).toMatch(/Engine: kokoro \(default\)/)
  expect(shown).toMatch(/not installed/)
  expect((await runCommand($, 'speak-engine', 'say')).text).toMatch(/set to say/)
  expect(stored.get('engine')).toBe('say')
  expect((await runCommand($, 'speak-engine', 'espeak')).text).toMatch(/kokoro or say/)
  expect(stored.get('engine')).toBe('say')
  expect((await runCommand($, 'speak-engine', 'default')).text).toMatch(/kokoro/)
  expect(stored.has('engine')).toBe(false)
})

test('/speak-voice under Kokoro sets per-language voices from the model voices, refusing the wrong language', async ($, on) => {
  const stored = new Map<string, unknown>()
  world(on, [], undefined, stored, {
    kokoro: { ...UP, voiceFiles: ['af_heart.safetensors', 'am_adam.safetensors', 'ef_dora.safetensors', 'em_alex.safetensors'] },
  })
  expect((await runCommand($, 'speak-voice', 'es EM_ALEX')).text).toMatch(/Spanish voice \(kokoro\) set to em_alex/)
  expect(stored.get('kokoroVoiceEs')).toBe('em_alex')
  expect((await runCommand($, 'speak-voice', 'am_adam')).text).toMatch(/English voice \(kokoro\) set to am_adam/)
  expect(stored.get('kokoroVoiceEn')).toBe('am_adam')
  expect((await runCommand($, 'speak-voice', 'es af_heart')).text).toMatch(/unknown voice/i)
  expect((await runCommand($, 'speak-voice', 'es Samantha')).text).toMatch(/unknown voice/i)
  const listed = (await runCommand($, 'speak-voice')).text ?? ''
  expect(listed).toContain('Engine: kokoro')
  expect(listed).toContain('English voice: am_adam')
  expect(listed).toContain('Spanish voice: em_alex')
  expect(listed).toContain('Spanish voices: ef_dora, em_alex')
  expect((await runCommand($, 'speak-voice', 'es default')).text).toMatch(/ef_dora/)
  expect(stored.has('kokoroVoiceEs')).toBe(false)
})

test('/speak-voice under Kokoro falls back to the built-in list when the cache cannot be read', async ($, on) => {
  world(on, [], undefined, new Map(), { kokoro: UP })
  expect((await runCommand($, 'speak-voice', 'es em_santa')).text).toMatch(/set to em_santa/)
})

test('/speak-voice es under say sets the Spanish say voice', async ($, on) => {
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>()
  const spawned: Spawned[] = []
  world(on, spawned, undefined, stored)
  expect((await runCommand($, 'speak-voice', 'es alice')).text).toMatch(/Spanish voice \(say\) set to Alice/)
  expect(stored.get('sayVoiceEs')).toBe('Alice')
  await answer($, 'El plugin está listo y puedes probarlo en la terminal.')
  await runCommand($, 'speak')
  await clock.settle()
  expect(spawned.at(-1)?.argv).toEqual(['say', '-v', 'Alice', '-r', '190', '-f', '-'])
})
