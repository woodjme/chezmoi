import type { EngineInterface, Register } from 'claude-code'

type $ = EngineInterface
// Where a path really lands (symlinks followed), or null when nothing is there.
type Locate = (path: string) => Promise<string | null>
type Word = { text: string; isOperator: boolean }
// The file a call was refused over, as the refusal names it.
type Found = string | null

const TEMPLATE_SUFFIXES = ['example', 'sample', 'template', 'dist', 'default']
const FILE_TOOLS: Readonly<Record<string, 'file_path' | 'notebook_path'>> = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}
// Programs whose arguments name files without printing or changing them.
const NAMING_ONLY = new Set(['ls', 'test', '[', '[[', 'stat'])
const GIT_NAMING_ONLY = new Set(['check-ignore', 'ls-files', 'status'])
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag'])
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup'])
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx'])
// Symlink checks per shell command; past this, words are judged by their spelling alone.
const MAX_LOOKUPS = 64

const denied = (found: string) =>
  `env-guard: refused because it touches ${found}. ` +
  '.env files hold live secrets, so agents may not read, edit or pass them to commands. ' +
  'Load the envsitter skill to list, check or change keys without seeing values, ' +
  'or ask the person to do this step themselves. Template files such as .env.example are allowed.'
const WITHHELD =
  'env-guard: this command failed and its output included lines from .env files, so the output was withheld. ' +
  'Rerun it so it does not touch .env files, or load the envsitter skill.'
const FAILED = 'env-guard: the .env check failed, so this call was refused to stay safe. Try again.'

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const field = FILE_TOOLS[e.tool]
    if (field !== undefined) {
      const path = (e as unknown as Record<string, unknown>)[field]
      const found = typeof path === 'string' ? await guardedFile($, path) : null

      return found === null ? next(e) : { deny: denied(found) }
    }
    if (e.tool !== 'Bash') return next(e)

    let lookups = 0
    const locate: Locate = async path => {
      if (++lookups > MAX_LOOKUPS || path.length > 1024) return null

      return $.fs.stat(path, { resolve: true }).then(
        stat => stat.realPath ?? path,
        () => null,
      )
    }
    const found = await commandTouchesEnvFile(e.command, locate)
    if (found !== null) return { deny: denied(found) }
    const ran = await next(e)
    if ('deny' in ran && ran.deny !== undefined) return ran
    if (ran.isError) {
      return typeof ran.text === 'string' && withoutEnvLines(ran.text).removed > 0 ? { deny: WITHHELD } : ran
    }

    const stdout = withoutEnvLines(ran.result.stdout)
    const stderr = withoutEnvLines(ran.result.stderr)
    const removed = stdout.removed + stderr.removed
    if (removed === 0) return ran
    const note = `[env-guard hid ${removed} line${removed === 1 ? '' : 's'} from .env files]`

    return {
      result: {
        ...ran.result,
        stdout: stdout.text === '' ? note : `${stdout.text}\n${note}`,
        stderr: stderr.text,
      },
    }
  }).catch(() => ({ deny: FAILED }))
}

async function guardedFile($: $, path: string): Promise<Found> {
  if (envFileKind(path) !== null) return `\`${path}\``
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)

  return stat?.realPath !== undefined && envFileKind(stat.realPath) !== null ? linkTo(path, stat.realPath) : null
}

function linkTo(path: string, real: string): string {
  return `\`${path}\`, a link to the .env file \`${real}\``
}

// 'dotfile' is unambiguous (.env, .env.local, .envsitter/...); 'named' (prod.env, app.env.local)
// also matches code such as process.env, so shell words of that kind only count when the file exists.
export function envFileKind(path: string): 'dotfile' | 'named' | null {
  const segments = path.toLowerCase().split(/[\\/]/)
  if (segments.slice(0, -1).includes('.envsitter')) return 'dotfile'
  const parts = (segments.at(-1) ?? '').split('.')
  const at = parts.indexOf('env', 1)
  if (at < 1 || parts.slice(at + 1).some(part => TEMPLATE_SUFFIXES.includes(part))) return null

  return parts[0] === '' && at === 1 ? 'dotfile' : 'named'
}

export async function commandTouchesEnvFile(command: string, locate: Locate): Promise<Found> {
  for (const inner of substitutionsOf(command)) {
    const found = await commandTouchesEnvFile(inner, locate)
    if (found !== null) return found
  }
  for (const segment of segmentsOf(command)) {
    const found = await segmentTouchesEnvFile(segment, locate)
    if (found !== null) return found
  }

  return null
}

async function segmentTouchesEnvFile(words: Word[], locate: Locate): Promise<Found> {
  const plain: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === undefined) continue
    if (!word.isOperator) {
      plain.push(word.text)
      continue
    }
    const target = words[i + 1]
    if (target !== undefined && !target.isOperator) {
      i++
      const found = await wordIsEnvFile(target.text, locate)
      if (found !== null) return found
    }
  }

  let start = 0
  while (start < plain.length && (isAssignment(plain[start] ?? '') || WRAPPERS.has(plain[start] ?? ''))) {
    const assigned = assignedValue(plain[start] ?? '')
    const found = assigned === null ? null : await wordIsEnvFile(assigned, locate)
    if (found !== null) return found
    start++
  }
  const program = baseName(plain[start] ?? '')
  let args = plain.slice(start + 1)

  if (program === 'envsitter') return null
  if (PACKAGE_RUNNERS.has(program) || (program === 'pnpm' && args[0] === 'dlx')) {
    const runs = args.find(arg => !arg.startsWith('-') && arg !== 'dlx')
    if (runs !== undefined && /^envsitter(@|$)/.test(runs)) return null
  }
  if (program === 'echo' || program === 'printf' || NAMING_ONLY.has(program)) return null
  if (program === 'git' && GIT_NAMING_ONLY.has(args.find(arg => !arg.startsWith('-')) ?? '')) return null
  if (SEARCHERS.has(program)) args = withoutSearchPattern(args)

  for (const arg of args) {
    const found = await argTouchesEnvFile(arg, locate)
    if (found !== null) return found
  }

  return null
}

async function argTouchesEnvFile(arg: string, locate: Locate): Promise<Found> {
  if (arg.startsWith('!')) return null
  if (arg.startsWith('-')) {
    const equals = arg.indexOf('=')
    if (equals === -1) return null
    const flag = arg.slice(0, equals)
    const value = arg.slice(equals + 1)
    if (/exclude|ignore/i.test(flag) || value.startsWith('!')) return null

    return wordIsEnvFile(value, locate)
  }
  // Code handed to a shell or an interpreter (`bash -c "..."`, `python -c "..."`).
  if (/[\s'"();|&<>`]/.test(arg)) return commandTouchesEnvFile(arg, locate)

  return wordIsEnvFile(arg, locate)
}

async function wordIsEnvFile(word: string, locate: Locate): Promise<Found> {
  const isGlob = /[*?[\]{}]/.test(word)
  const kind = envFileKind(isGlob ? word.replace(/[*?[\]{}]/g, '') : word)
  if (kind === 'dotfile' || (isGlob && kind === 'named')) return `\`${word}\``
  if (isGlob) return null
  const real = await locate(word)
  if (real === null) return null
  if (kind === 'named') return `\`${word}\``

  return envFileKind(real) === null ? null : linkTo(word, real)
}

function withoutSearchPattern(args: string[]): string[] {
  const hasExplicitPattern = args.some(arg => /^(-e|--regexp|-f|--file)(=|$)/.test(arg))
  const kept: string[] = []
  let isPatternTaken = hasExplicitPattern
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '-e' || arg === '--regexp') {
      i++
      continue
    }
    if (!isPatternTaken && !arg.startsWith('-')) {
      isPatternTaken = true
      continue
    }
    kept.push(arg)
  }

  return kept
}

function substitutionsOf(command: string): string[] {
  const found: string[] = []
  for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`|<\(([^()]*)\)/g)) {
    const inner = match[1] ?? match[2] ?? match[3]
    if (inner !== undefined && inner.trim() !== '') found.push(inner)
  }

  return found
}

// A small shell lexer: enough to split segments, words, quotes and redirections.
function segmentsOf(command: string): Word[][] {
  const segments: Word[][] = [[]]
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null
  const current = () => segments[segments.length - 1] ?? []
  const endWord = () => {
    if (hasWord) current().push({ text: word, isOperator: false })
    word = ''
    hasWord = false
  }
  const endSegment = () => {
    endWord()
    if (current().length > 0) segments.push([])
  }

  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? ''
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
      continue
    }
    if (quote === '"') {
      if (c === '\\' && i + 1 < command.length) word += command[++i]
      else if (c === '"') quote = null
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      hasWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      hasWord = true
    } else if (c === '\n' || c === ';' || c === '&' || c === '|') {
      endSegment()
    } else if (/\s/.test(c) || c === '(' || c === ')') {
      endWord()
    } else if (c === '<' || c === '>') {
      endWord()
      let operator = c
      while (command[i + 1] === '<' || command[i + 1] === '>' || command[i + 1] === '&') operator += command[++i]
      current().push({ text: operator, isOperator: true })
    } else if (c === '#' && !hasWord) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++
    } else {
      word += c
      hasWord = true
    }
  }
  endWord()

  return segments.filter(segment => segment.length > 0)
}

// Lines that grep, rg and git grep print as `path:...` or `path-12-...` for a .env file.
export function withoutEnvLines(text: string): { text: string; removed: number } {
  let removed = 0
  const kept = text.split('\n').filter(line => {
    const path = /^(.+?)(?::|-\d+-)/.exec(line)?.[1]
    const isEnvLine = path !== undefined && !/\s/.test(path) && envFileKind(path) !== null
    if (isEnvLine) removed++

    return !isEnvLine
  })

  return { text: kept.join('\n'), removed }
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)
}

function assignedValue(word: string): string | null {
  return isAssignment(word) ? word.slice(word.indexOf('=') + 1) : null
}

function baseName(path: string): string {
  return path.split('/').at(-1) ?? ''
}
