# speak-aloud

A Claude Code mod that reads Claude's responses aloud.

Every reply in the transcript gets a 🔊 button. Press it to hear that reply; it turns into ■ while reading, and pressing it again stops. Markdown is cleaned up before speaking: formatting marks and link URLs are dropped, and code blocks are read as "Code block omitted."

**Requires macOS** — speech uses the built-in `say` command.

## Install

In a Claude Code session in a terminal:

```
/plugin install speak-aloud --marketplace tiger3645/claude-tts
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

## Commands

| Command | What it does |
| --- | --- |
| `/speak` | Read Claude's latest response aloud |
| `/speak-stop` | Stop reading |
| `/speak-voice` | List available voices and show the current one |
| `/speak-voice <name>` | Set the voice (e.g. `/speak-voice Samantha`); `default` resets to the system voice |
| `/speak-rate` | Show the current speed |
| `/speak-rate <wpm>` | Set the speed in words per minute (80–500); `default` resets to 190 |

Voice and speed are saved across sessions.

## Notes

- When a reply is split by tool calls, each text part gets its own button.
- `/speak` reads the whole latest reply but doesn't highlight a button while it reads; `/speak-stop` stops it.

## Development

```
claude plugin validate .
claude plugin test .
```

To load a working copy without installing: `claude --plugin-dir /path/to/claude-tts`.
