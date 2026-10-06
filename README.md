# speak-aloud

A Claude Code mod that reads Claude's responses aloud.

Every reply in the transcript gets a 🔊 button. Press it to hear that reply; it turns into ■ while reading, and pressing it again stops. Markdown is cleaned up before speaking: formatting marks and link URLs are dropped, and code blocks are skipped (a reply that is only code gets no button).

Speech uses [Kokoro](https://huggingface.co/mlx-community/Kokoro-82M-bf16), a small neural TTS model that runs locally on Apple silicon through `mlx-audio`. If Kokoro isn't installed or its server fails, the mod falls back to macOS `say` automatically (one toast says so).

Each paragraph is read in its own language — **English or Spanish** — with a voice per language.

**Requires macOS.** Kokoro needs Apple silicon; `say` works everywhere on macOS.

## Install

1. In a Claude Code session in a terminal:

   ```
   /plugin install speak-aloud --marketplace tiger3645/claude-tts
   ```

   Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). It works right away with macOS `say`.

2. For the natural Kokoro voices, run:

   ```
   /speak-install
   ```

   It needs [uv](https://docs.astral.sh/uv/) (`brew install uv`, or `curl -LsSf https://astral.sh/uv/install.sh | sh`). The install runs in the background with its progress in the status line: it installs `mlx-audio` and its extras, the spaCy English model, starts the server and downloads the model (~680 MB the first time), warming English and Spanish. When it's done, reads switch to Kokoro — no restart. `/speak-install --repair` reinstalls everything.

   Until Kokoro is installed, the mod reads with `say` and reminds you about `/speak-install` at most once a day.

### How Kokoro runs

The mod starts `mlx_audio.server` on `127.0.0.1:8765` when a session starts (or reuses one already answering there) and loads the model, so reads start in well under a second. The server runs detached and is shared by every session on the machine: a `/reload-plugins` keeps it, and it is stopped when the last session using it ends. Its logs, the session registry and temporary WAVs live in `~/Library/Caches/speak-aloud/`.

Text is split into paragraphs and chunks of a few sentences; the next chunk is generated while the current one plays (`curl` to the server, `afplay` to play).

### Manual install / troubleshooting

`/speak-install` runs these two commands; run them yourself if it fails:

```
uv tool install mlx-audio --with uvicorn --with fastapi --with python-multipart --with webrtcvad-wheels --with "misaki[en]" --with num2words --with spacy --with phonemizer-fork --with espeakng-loader
uv pip install --python ~/.local/share/uv/tools/mlx-audio/bin/python https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
```

Re-run the second command after any `uv tool install --force` or upgrade of `mlx-audio`.

The mod looks for `~/.local/bin/mlx_audio.server`. If reads fall back to `say`, check `/speak-engine` and the server log in `~/Library/Caches/speak-aloud/logs/server.log`.

## Commands

| Command | What it does |
| --- | --- |
| `/speak` | Read Claude's latest response aloud |
| `/speak-stop` | Stop reading |
| `/speak-install` | Install Kokoro (needs uv); `--repair` reinstalls |
| `/speak-engine` | Show the engine and whether Kokoro is installed / running |
| `/speak-engine kokoro\|say` | Choose the engine (default `kokoro`); `default` resets it |
| `/speak-voice` | Show the English and Spanish voices for the current engine, and the voices to choose from |
| `/speak-voice [en\|es] <name>` | Set the voice for a language (no language = English), e.g. `/speak-voice es em_alex` or `/speak-voice Samantha` |
| `/speak-voice [en\|es] default` | Reset a language's voice |
| `/speak-rate` | Show the current speed |
| `/speak-rate <wpm>` | Set the speed in words per minute (80–500); `default` resets to 190 |

Voices are kept per engine. Defaults:

| | English | Spanish |
| --- | --- | --- |
| Kokoro | `af_heart` | `ef_dora` |
| say | system voice | first Spanish (`es_*`) voice installed |

Kokoro voices: English `af_*`, `am_*` (American) and `bf_*`, `bm_*` (British); Spanish `ef_dora`, `em_alex`, `em_santa`. For `say`, any voice from `say -v '?'` (download more in System Settings → Accessibility → Spoken Content).

The speed applies to both engines: for Kokoro, words per minute map to its `speed` as wpm ÷ 153 (Kokoro's natural pace), clamped to 0.5–2.0.

Engine, voices and speed are saved across sessions.

## Language detection

Each paragraph is classified as English or Spanish by counting common words of each language (`the`, `and`, `is`… vs `el`, `que`, `de`, `para`…), with `ñ`, `¿`, `¡` and accented vowels counting toward Spanish. Inline code, identifiers (`snake_case`, `camelCase`, `file.ts`), paths and URLs are ignored, so "Hice commit del plugin y el build pasó" reads as Spanish. A paragraph too short to tell ("OK.") takes the language of the whole message; a message that can't be told reads as English.

## Notes

- When a reply is split by tool calls, each text part gets its own button.
- `/speak` reads the whole latest reply but doesn't highlight a button while it reads; `/speak-stop` stops it.

## Development

```
claude plugin validate .
claude plugin test .
```

To load a working copy without installing: `claude --plugin-dir /path/to/claude-tts`.
