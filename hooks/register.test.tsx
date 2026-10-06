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

type Spawned = { argv: readonly string[]; input?: string; isDone: boolean }

/** A slice of `say -v '?'`, names with spaces and parentheses included. */
const VOICES = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Alice               it_IT    # Ciao! Mi chiamo Alice.',
  'Aman (Inglés (India)) en_IN    # Hello! My name is Aman.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  '',
].join('\n')

/**
 * The engine beneath the plugin: its own drawing of a reply block and of the
 * band, a store in memory, a turn that answers with its text, and a fake `say`
 * that plays nothing. `during` runs while the fake utterance is "playing", so a
 * test can look at the drawing mid-speech.
 */
function world(on: On, spawned: Spawned[], during?: () => Promise<void>, stored: Map<string, unknown> = new Map()) {
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
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('process.run', (_$, e) => {
    const isVoiceList = e.argv.join(' ') === 'say -v ?'
    return {
      value: {
        exitCode: isVoiceList ? 0 : 1,
        stdout: isVoiceList ? VOICES : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('process.spawn', async function* (_$, e) {
    const one: Spawned = { argv: e.argv, input: e.input, isDone: false }
    spawned.push(one)
    yield { stream: 'stdout', text: ' ' } as const
    if (during) await during()
    yield { stream: 'stdout', text: ' ' } as const
    one.isDone = true
    return { value: { code: 0, signal: null } }
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
  on('command.register', (_$, e) => {
    names.push(e.name)
    return { value: { command: e.name } }
  })
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

test('with nothing set, say reads at the default 190 wpm and no voice', async ($, on) => {
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
  expect(text).toMatch(/current voice: Samantha/i)
})

test('/speak-voice alone says the system default when none is set', async ($, on) => {
  const stored = new Map<string, unknown>()
  world(on, [], undefined, stored)
  expect((await runCommand($, 'speak-voice')).text).toMatch(/current voice: system default/i)
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

test('registers /speak-voice and /speak-rate at session start', async ($, on) => {
  const names: string[] = []
  on('command.register', (_$, e) => {
    names.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(names).toContain('speak-voice')
  expect(names).toContain('speak-rate')
})
