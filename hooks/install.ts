/** Installing Kokoro (mlx-audio and what it needs) with uv, as /speak-install does. */

export const SPACY_MODEL_URL =
  'https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl'

const EXTRAS = [
  'uvicorn',
  'fastapi',
  'python-multipart',
  'webrtcvad-wheels',
  'misaki[en]',
  'num2words',
  'spacy',
  'phonemizer-fork',
  'espeakng-loader',
]

export const UV_HELP =
  'uv is needed to install Kokoro. Install it with `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh | sh`, then run /speak-install again.'

export const INSTALL_NOTICE =
  'Kokoro not installed — run /speak-install for natural voices (using `say` until then).'

/** The install notice comes back at most once a day while Kokoro is missing. */
export const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Where uv may be: its own installer's bin, Homebrew's (Apple silicon, Intel). */
export function uvCandidates(home: string): string[] {
  return [`${home}/.local/bin/uv`, '/opt/homebrew/bin/uv', '/usr/local/bin/uv']
}

/** `uv tool install mlx-audio` with its extras; `--force` to repair. */
export function uvInstallArgv(uv: string, isRepair: boolean): string[] {
  return [uv, 'tool', 'install', ...(isRepair ? ['--force'] : []), 'mlx-audio', ...EXTRAS.flatMap(x => ['--with', x])]
}

/** The spaCy English model, into the mlx-audio tool's own Python. */
export function spacyInstallArgv(uv: string, home: string): string[] {
  return [uv, 'pip', 'install', '--python', `${home}/.local/share/uv/tools/mlx-audio/bin/python`, SPACY_MODEL_URL]
}

/** The last `lines` non-empty lines of a command's output, at most 400 characters. */
export function tail(text: string, lines: number): string {
  const kept = text
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l !== '')
    .slice(-lines)
    .join('\n')
  return kept.length > 400 ? kept.slice(-400) : kept
}

/** Whether to show the install notice, given when it was last shown (a stored value) and now. */
export function shouldShowInstallNotice(lastShown: unknown, now: number): boolean {
  if (typeof lastShown !== 'number' || !Number.isFinite(lastShown)) return true
  return now - lastShown >= NOTICE_INTERVAL_MS
}
