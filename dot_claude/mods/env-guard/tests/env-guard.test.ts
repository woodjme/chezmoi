import { expect, test } from 'claude-code/testing'

import { commandTouchesEnvFile, envFileKind, withoutEnvLines } from '../hooks/register'

const files = new Map([
  ['prod.env', '/repo/prod.env'],
  ['config/app.env.local', '/repo/config/app.env.local'],
  ['settings.conf', '/repo/.env'],
  ['README.md', '/repo/README.md'],
])
const locate = async (path: string) => files.get(path) ?? null
const touches = async (command: string) => (await commandTouchesEnvFile(command, locate)) !== null

test('recognises secret env files and lets templates through', () => {
  for (const path of ['.env', '.ENV', '.env.local', '/repo/apps/web/.env.production', 'prod.env', '.envsitter/pepper']) {
    expect(envFileKind(path)).not.toBeNull()
  }
  for (const path of ['.env.example', '.env.local.example', '.env.sample', '.env.template', '.env.dist', '.env.default']) {
    expect(envFileKind(path)).toBeNull()
  }
  for (const path of ['.envrc', 'environment.ts', 'src/env.ts', 'envsitter.md', 'README.md']) {
    expect(envFileKind(path)).toBeNull()
  }
})

test('shell commands that read, write or load a .env file are refused', async () => {
  for (const command of [
    'cat .env',
    'head -n 5 ./apps/api/.env.local',
    'source .env && npm start',
    '. .env',
    'grep -n API_KEY .env',
    'rg TOKEN .env.production',
    'echo "SECRET=1" >> .env',
    'cp .env /tmp/leak',
    'cat .env*',
    'cat *.env',
    'tail {.env,.env.local}',
    'echo "$(cat .env)"',
    'X=`cat .env` node app.js',
    'bash -c "cat .env"',
    'python3 -c "print(open(\'.env\').read())"',
    'docker compose --env-file .env up',
    'node --env-file=.env server.js',
    'cat prod.env',
    'cat settings.conf',
    'git add .env',
    'npx -y envsitter@0.0.4 keys --file .env; cat .env',
  ]) {
    expect({ command, touches: await touches(command) }).toEqual({ command, touches: true })
  }
})

test('the refusal names the file, and the real file behind a link', async () => {
  expect(await commandTouchesEnvFile('cat .env.local', locate)).toBe('`.env.local`')
  expect(await commandTouchesEnvFile('cat settings.conf', locate)).toBe('`settings.conf`, a link to the .env file `/repo/.env`')
})

test('shell commands that only name, exclude or template .env files are allowed', async () => {
  for (const command of [
    'cat .env.example',
    'cp .env.example .env.example.bak',
    'ls -la .env',
    'test -f .env && echo present',
    '[ -f .env.local ]',
    'git check-ignore -v .env',
    'git status --short',
    'echo ".env" >> .gitignore',
    'printf ".env\\n.env.local\\n" >> .gitignore',
    'grep -n "\\.env" .gitignore',
    'rg "process.env.API_URL" src',
    'rg -g "!.env" API_KEY',
    'grep -r --exclude=.env API_KEY .',
    'node -e "console.log(Object.keys(process.env).length)"',
    'npx -y envsitter@0.0.4 keys --file .env --json',
    'npx -y envsitter@0.0.4 set API_KEY --file .env.local --json',
    'cat app.env',
    'cat README.md',
    'git log --oneline -5',
  ]) {
    expect({ command, touches: await touches(command) }).toEqual({ command, touches: false })
  }
})

test('search output loses lines that come from .env files', () => {
  const output = [
    'src/config.ts:3:const key = process.env.API_KEY',
    '.env:API_KEY=sk-live-123',
    './apps/web/.env.local:2:SECRET=abc',
    'apps/web/.env.local-3-OTHER=def',
    '.env.example:API_KEY=',
    'Error: missing .env',
  ].join('\n')
  const cleaned = withoutEnvLines(output)
  expect(cleaned.removed).toBe(3)
  expect(cleaned.text).toBe(
    ['src/config.ts:3:const key = process.env.API_KEY', '.env.example:API_KEY=', 'Error: missing .env'].join('\n'),
  )
})

test('file tools are refused on .env files and allowed on templates', async ($, on) => {
  on('fs.stat', () => ({ deny: 'no file system in tests' }))
  on('tool.call', { tool: 'Read' }, (_$, e) => ({ result: { type: 'text', file: { filePath: e.file_path, content: 'ok', numLines: 1, startLine: 1, totalLines: 1 } } }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} }))

  const denied = await $.tool.call({ tool: 'Read', file_path: '/repo/.env.local' })
  expect('deny' in denied && denied.deny).toMatch(/envsitter/)
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/repo/.env', old_string: 'a', new_string: 'b' })
  expect('deny' in edit && edit.deny).toMatch(/env-guard/)

  const allowed = await $.tool.call({ tool: 'Read', file_path: '/repo/.env.example' })
  expect('deny' in allowed && allowed.deny).toBeFalsy()
})

test('a symlink that lands on a .env file is refused', async ($, on) => {
  on('fs.stat', (_$, e) => ({ value: { kind: 'file', size: 10, mtimeMs: 0, isLink: true, realPath: `/repo/.env` } }))
  on('tool.call', { tool: 'Read' }, () => ({ result: {} }))

  const denied = await $.tool.call({ tool: 'Read', file_path: '/repo/config/settings' })
  expect('deny' in denied && denied.deny).toMatch(/`\/repo\/config\/settings`, a link to the \.env file `\/repo\/\.env`/)
})

test('Bash search output is filtered before the model reads it', async ($, on) => {
  on('fs.stat', () => ({ deny: 'no file system in tests' }))
  on('tool.call', { tool: 'Bash' }, () => ({
    result: {
      stdout: 'src/a.ts:1:process.env.KEY\n.env:KEY=secret',
      stderr: '',
      interrupted: false,
    },
  }))

  const ran = await $.tool.call({ tool: 'Bash', command: 'grep -rn KEY .' })
  if ('deny' in ran && ran.deny !== undefined) throw new Error(ran.deny)
  const result = ran.result as { stdout: string }
  expect(result.stdout).toContain('src/a.ts:1:process.env.KEY')
  expect(result.stdout).not.toContain('secret')
  expect(result.stdout).toContain('[env-guard hid 1 line from .env files]')

  const blocked = await $.tool.call({ tool: 'Bash', command: 'cat .env' })
  expect('deny' in blocked && blocked.deny).toMatch(/env-guard/)
})
