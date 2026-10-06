import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import { stripMarkdown } from './markdown'
import {
  DEFAULT_RATE,
  RATE_RANGE_MESSAGE,
  describeVoices,
  findVoice,
  parseRate,
  parseVoices,
  sayArgv,
  toSettings,
} from './settings'

const latest = atom({ plugin: 'speak-aloud', key: 'latest' } as const, '')
/** Which reply block is being read: its `requestId`, LATEST for /speak, '' for none. */
const speaking = atom({ plugin: 'speak-aloud', key: 'speaking' } as const, '')
const LATEST = '/speak'

type Utterance = { child: HookStream<ProcessSpawnChunk, ProcessSpawnResult> }

// Module variables reset on a reload, and an unload kills the child too, so a
// stale `speaking` left in $.state from before a reload reads as idle.
let current: Utterance | null = null
let hasRegistered = false

async function registerCommands($: EngineInterface) {
  hasRegistered = true
  try {
    await $.command.register({ name: 'speak', description: "Read Claude's latest response aloud" })
    await $.command.register({ name: 'speak-stop', description: 'Stop reading aloud' })
    await $.command.register({
      name: 'speak-voice',
      description: 'Set the voice for reading aloud; alone, list the voices',
      argumentHint: '[name|default]',
    })
    await $.command.register({
      name: 'speak-rate',
      description: 'Set the reading speed in words per minute (80-500)',
      argumentHint: '[wpm|default]',
    })
  } catch (error) {
    $.ui.log(`speak-aloud: could not register commands: ${String(error)}`, { to: 'debug' })
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

async function readSettings($: EngineInterface) {
  try {
    return toSettings(await $.store.get('voice'), await $.store.get('rate'))
  } catch (error) {
    // Speech goes on at the defaults rather than not at all.
    $.ui.log(`speak-aloud: could not read settings: ${String(error)}`, { to: 'debug' })
    return toSettings(undefined, undefined)
  }
}

async function listVoices($: EngineInterface): Promise<string[] | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(['say', '-v', '?'])
    const names = parseVoices(stdout)
    return exitCode === 0 && names.length > 0 ? names : undefined
  } catch (error) {
    $.ui.log(`speak-aloud: could not list voices: ${String(error)}`, { to: 'debug' })
    return undefined
  }
}

/** `/speak-voice [name|default]`: answers the command's text. */
async function voiceCommand($: EngineInterface, args: string): Promise<string> {
  const wanted = args.trim()
  if (wanted.toLowerCase() === 'default') {
    await $.store.delete('voice')
    return 'Voice reset to the system default.'
  }
  const voices = await listVoices($)
  if (voices === undefined) return "Could not list voices: `say -v '?'` gave nothing."
  if (wanted === '') return describeVoices((await readSettings($)).voice, voices)

  const found = findVoice(wanted, voices)
  if ('error' in found) return found.error
  await $.store.set('voice', found.name)
  return `Voice set to ${found.name}.`
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

/** Which block is being read, '' when none; a value left from before a reload reads as none. */
async function readSpeaking($: EngineInterface) {
  const key = await read($, speaking)
  return current === null ? '' : key
}

/** Stops the current utterance, if any; resolves whether one was running. */
async function stop($: EngineInterface): Promise<boolean> {
  const was = current
  current = null
  // Not awaited: ending the loop kills `say`, and nothing waits on its last words.
  if (was !== null) void was.child.return({ code: null, signal: 'SIGTERM' }).catch(() => {})
  await update($, speaking, () => '')
  return was !== null
}

/**
 * Reads `markdown` aloud as the block `key`, stopping any current read;
 * resolves once `say` ended.
 */
async function speak($: EngineInterface, markdown: string, key: string): Promise<void> {
  await stop($)
  const text = stripMarkdown(markdown)
  if (text === '') return

  const argv = sayArgv(await readSettings($))
  const mine: Utterance = { child: $.process.spawn({ argv, input: text }) }
  current = mine
  await update($, speaking, () => key)
  try {
    for await (const _chunk of mine.child) {
      // `say` writes nothing worth showing: the loop is the child's life.
    }
  } catch (error) {
    $.ui.log(`speak-aloud: say failed: ${String(error)}`, { to: 'debug' })
  } finally {
    if (current === mine) {
      current = null
      await update($, speaking, () => '')
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await registerCommands($)
    try {
      await seedLatest($)
    } catch (error) {
      $.ui.log(`speak-aloud: could not read the transcript: ${String(error)}`, { to: 'debug' })
    }
    return started
  })

  on('session.end', async ($, e, next) => {
    await stop($)
    if (e.reason === 'clear') await update($, latest, () => '')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.answer.trim() !== '') {
      await update($, latest, () => e.answer)
    }
    // A mod enabled or reloaded mid-session never sees session.start.
    if (!hasRegistered) await registerCommands($)
    return done
  })

  on('command.run', { command: 'speak' }, async $ => {
    const text = await read($, latest)
    if (text.trim() === '') return { text: 'No response to read yet.' }
    // On a timer, so the child outlives this command's dispatch.
    $.clock.after(0, () => void speak($, text, LATEST))
    return { text: 'Reading the latest response aloud.' }
  })

  on('command.run', { command: 'speak-stop' }, async $ => {
    const wasSpeaking = await stop($)
    return { text: wasSpeaking ? 'Stopped reading.' : 'Nothing is being read.' }
  })

  on('command.run', { command: 'speak-voice' }, async ($, e) => ({ text: await voiceCommand($, e.args) }))

  on('command.run', { command: 'speak-rate' }, async ($, e) => ({ text: await rateCommand($, e.args) }))

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
