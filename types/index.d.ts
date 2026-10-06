/** What `say` is reading: the main loop's latest non-empty answer, as markdown. */
export type SpeakAloudText = string

declare module 'claude-code' {
  interface PluginState {
    'speak-aloud': { latest: SpeakAloudText; speaking: string }
  }
}
