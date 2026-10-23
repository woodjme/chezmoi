import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type {
  ChangedFile,
  Effort,
  EffortLevel,
  McpServer,
  RateWindow,
  Section,
  Snapshot,
  Todo,
  TodoStatus,
} from '../types'

const PANE = 'opencode-sidebar'
const PANE_TITLE = 'Sidebar'
const PANE_COLUMNS = 42
const POLL_MS = 4000
const MAX_FILES = 60
const MAX_UNTRACKED_COUNTED = 15
const AUTO_OPEN_KEY = 'autoOpen'
const LIMITS_KEY = 'limits'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const USAGE_REFRESH_MS = 60_000
const USAGE_AFTER_TURN_MS = 15_000
const LIVE_KINDS: Readonly<Record<string, string>> = { five_hour: 'session', seven_day: 'weekly_all' }
// An engine action with no default key: the chord the person binds to it presses the band's toggle.
const TOGGLE_ACTION = 'app:toggleReplTab'
// Same trick for ctrl+t: this action's own handler only mounts while the diff panel is open.
const EFFORT_ACTION = 'app:toggleDiffNoiseFilter'
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
// Side gutter for the chat, as OpenCode has; the prompt box and the startup logo are not render sites.
const GUTTER = 2
const TRANSCRIPT_ROWS = [
  'UserMessage',
  'AssistantMessage',
  'ToolUse',
  'ToolResult',
  'ToolGroup',
  'ToolProgress',
  'CommandOutput',
  'Spinner',
  'TurnDuration',
  'InfoNotice',
] as const
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const EMPTY: Snapshot = {
  cwd: '',
  home: '',
  isRepo: false,
  branch: null,
  files: [],
  model: '',
  tokens: null,
  window: 0,
  percent: null,
  costUsd: null,
  mcp: [],
  version: '',
  limits: [],
  minute: 0,
}

const snapshot = atom({ plugin: 'opencode-sidebar', key: 'snapshot' } as const, EMPTY)
const todos = atom({ plugin: 'opencode-sidebar', key: 'todos' } as const, [] as Todo[])
const title = atom({ plugin: 'opencode-sidebar', key: 'title' } as const, '')
const collapsed = atom(
  { plugin: 'opencode-sidebar', key: 'collapsed' } as const,
  {} as Partial<Record<Section, boolean>>,
)
const effort = atom({ plugin: 'opencode-sidebar', key: 'effort' } as const, {
  model: '',
  engine: null,
  override: null,
  inheritedEnv: null,
  isStale: false,
} as Effort)

type $ = EngineInterface

let lastSnapshotJson = ''
let isRefreshing = false
let isRefreshQueued = false
let accountUsage: RateWindow[] | null = null
let accountUsageFetchedAt = 0
let isAccountUsageStale = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'sidebar',
      description: 'Toggle the OpenCode-style sidebar (context, files, todos, directory)',
    })
    await restoreTitle($)
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    if ((await $.store.get(AUTO_OPEN_KEY)) !== false) {
      void $.ui.open({ id: PANE, title: PANE_TITLE, columns: PANE_COLUMNS })
    }

    return started
  })

  on('command.run', { command: 'sidebar' }, async $ => {
    const isOpen = await toggleSidebar($)

    return { text: isOpen ? 'Sidebar opened.' : 'Sidebar closed.' }
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const modes = await next(e)
    if (e.surface !== 'terminal') return modes
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const level = effortOf(await read($, effort))

    return (
      <Box flexDirection="row" columnGap={2}>
        {e.props.modes.length > 0 && <Box flexShrink={1}>{modes}</Box>}
        <Box flexShrink={0} flexDirection="row" columnGap={2}>
          <Text>
            <Text color="claude">● </Text>
            <Text>{prettyModel(snap.model) || 'Claude'}</Text>
            {level !== null && <Text dimColor> · </Text>}
            {level !== null && <Text>{level}</Text>}
          </Text>
          <Button key="cycle-effort" plain action={EFFORT_ACTION} onPress={() => cycleEffort($)}>
            <Text dimColor>ctrl+t effort</Text>
          </Button>
          <Button key="toggle-sidebar" plain action={TOGGLE_ACTION} onPress={() => toggleSidebar($)}>
            <Text dimColor>ctrl+x s sidebar</Text>
          </Button>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: TRANSCRIPT_ROWS }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal') return row
    const { Box } = $.ui.resolve(e)

    return (
      <Box paddingX={GUTTER} flexDirection="column">
        {row}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await syncEffortModel($, await $.session.model())

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && (await read($, effort)).override === null) {
      const engine = typeof e.effort === 'string' ? toEffortLevel(e.effort) : e.effort === undefined ? 'none' : null
      await changeEffort($, current => ({ ...current, engine, isStale: false }))
    }

    return yield* next(e)
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  // The engine refuses /effort while the variable is set, so a typed /effort hands control back first.
  // Its panel prints no text, and may still be waiting on a confirmation, so the saved level is
  // re-read on each refresh until the next request reports the level in force.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    await setOverride($, null)
    const ran = await next(e)
    await changeEffort($, current => ({ ...current, isStale: true }))
    await refreshStaleEffort($)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set(AUTO_OPEN_KEY, false)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    void refresh($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isAccountUsageStale = true
      void refresh($)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await $.state.set({ plugin: 'opencode-sidebar', key: 'title' }, '')
      await $.state.set({ plugin: 'opencode-sidebar', key: 'todos' }, [])
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta && e.command === undefined) {
      const current = await read($, title)
      if (current === '') await update($, title, () => toTitle(e.text))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || 'deny' in ran || ran.isError) return ran

    if (e.tool === 'TodoWrite') {
      const list = e.todos.map((todo, index): Todo => ({
        id: `todo-${index}`,
        content: todo.content,
        status: todo.status,
        source: 'todo',
      }))
      await update($, todos, current => [...current.filter(t => t.source !== 'todo'), ...list])
    } else if (e.tool === 'TaskCreate') {
      const id = taskIdOf(ran.result)
      if (id !== null) {
        const created: Todo = { id, content: e.subject, status: 'pending', source: 'task' }
        await update($, todos, current => [...current.filter(t => t.id !== id), created])
      }
    } else if (e.tool === 'TaskUpdate') {
      const { taskId, status, subject } = e
      await update($, todos, current =>
        status === 'deleted'
          ? current.filter(t => t.id !== taskId)
          : current.map(t =>
              t.source === 'task' && t.id === taskId
                ? { ...t, status: status ?? t.status, content: subject ?? t.content }
                : t,
            ),
      )
    } else if (isMutating(String(e.tool))) {
      void refresh($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const list = await read($, todos)
    const heading = await read($, title)
    const folded = await read($, collapsed)
    const level = effortOf(await read($, effort))
    const columns = e.props.bodyColumns
    const done = list.filter(t => t.status === 'completed').length

    if (e.props.placement === 'inline') {
      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} paddingX={1}>
          <Text weight="bold">{heading || 'New session'}</Text>
          <Text color={contextColor(snap.percent)}>{formatPercent(snap.percent)} context</Text>
          <Text dimColor>{formatCost(snap.costUsd)}</Text>
          <Text dimColor>{snap.files.length} changed</Text>
          {list.length > 0 && <Text dimColor>todo {done}/{list.length}</Text>}
          <Text dimColor>{locationOf(snap)}</Text>
        </Box>
      )
    }

    const isFolded = (section: Section, size: number | null) => folded[section] ?? (size !== null && size > 5)
    const header = (section: Section, label: string, size: number | null) => {
      const isClosed = isFolded(section, size)

      return (
        <Button
          key={`section-${section}`}
          plain
          onPress={() => update($, collapsed, c => ({ ...c, [section]: !isClosed }))}
        >
          <Text dimColor>{isClosed ? '▶' : '▼'} </Text>
          <Text weight="bold">{label}</Text>
          {size !== null && size > 0 && <Text dimColor> {size}</Text>}
        </Button>
      )
    }

    const contextBody = (
      <Box flexDirection="column">
        <Text>
          {formatTokens(snap.tokens)} <Text dimColor>tokens</Text>
        </Text>
        <Text>
          <Text color={contextColor(snap.percent)}>{bar(snap.percent, Math.min(20, columns - 12))}</Text>{' '}
          {formatPercent(snap.percent)} <Text dimColor>used</Text>
        </Text>
        <Text>
          {formatCost(snap.costUsd)} <Text dimColor>spent</Text>
        </Text>
        {snap.model !== '' && (
          <Text dimColor wrap="truncate-end">
            {prettyModel(snap.model)}
            {level !== null && ` · ${level} effort`}
          </Text>
        )}
      </Box>
    )

    const labelWidth = Math.max(5, ...snap.limits.map(limit => limit.label.length))
    const usageBody = (
      <Box flexDirection="column">
        {snap.limits.length === 0 && <Text dimColor>No reading yet</Text>}
        {snap.limits.map(limit => (
          <Box key={`usage-${limit.kind}`} flexDirection="row" justifyContent="space-between">
            <Text>
              <Text dimColor>{limit.label.padEnd(labelWidth)} </Text>
              <Text color={limitTone(limit.percentUsed)}>{gauge(limit.percentUsed)}</Text>
              <Text dimColor>{'▯'.repeat(5 - gaugeFill(limit.percentUsed))} </Text>
              <Text color={limitTone(limit.percentUsed)}>{Math.round(limit.percentUsed)}%</Text>
            </Text>
            {limit.resetsAt !== null && (
              <Box flexShrink={0} marginLeft={1}>
                <Text dimColor>resets {untilReset(limit.resetsAt, snap.minute)}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )

    const mcpBody = (
      <Box flexDirection="column">
        {snap.mcp.length === 0 && <Text dimColor>No MCP servers connected</Text>}
        {snap.mcp.map(server => (
          <Box key={`mcp-${server.isCloud ? 'cloud' : 'local'}-${server.name}`} flexDirection="row" justifyContent="space-between">
            <Box flexShrink={1}>
              <Text wrap="truncate-end" dimColor={server.needsAuth}>
                {server.isCloud ? <Text color="suggestion">☁ </Text> : <Text color="success">• </Text>}
                {server.name}
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              {server.needsAuth ? (
                <Text color="warning">needs auth</Text>
              ) : (
                <Text dimColor>
                  {server.tools} {server.tools === 1 ? 'tool' : 'tools'}
                </Text>
              )}
            </Box>
          </Box>
        ))}
      </Box>
    )

    const filesBody = (
      <Box flexDirection="column">
        {!snap.isRepo && <Text dimColor>Not a git repository</Text>}
        {snap.isRepo && snap.files.length === 0 && <Text dimColor>No changes</Text>}
        {snap.files.map(file => (
          <Box key={`file-${file.path}`} flexDirection="row" justifyContent="space-between">
            <Box flexShrink={1}>
              <Text wrap="truncate-start" color={fileColor(file.status)}>
                {file.path}
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Text>
                {file.added > 0 && <Text color="success">+{file.added}</Text>}
                {file.added > 0 && file.removed > 0 && ' '}
                {file.removed > 0 && <Text color="error">-{file.removed}</Text>}
                {file.added === 0 && file.removed === 0 && <Text dimColor>{statusLabel(file.status)}</Text>}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    )

    const todoBody = (
      <Box flexDirection="column">
        {list.map(todo => (
          <Box key={`todo-${todo.id}`} flexDirection="row">
            <Box flexShrink={0}>
              <Text color={todoColor(todo.status)}>{todoMark(todo.status)} </Text>
            </Box>
            <Text
              dimColor={todo.status === 'completed'}
              strikethrough={todo.status === 'completed'}
              color={todo.status === 'in_progress' ? 'warning' : undefined}
            >
              {todo.content}
            </Text>
          </Box>
        ))}
      </Box>
    )

    const section = (key: Section, label: string, size: number | null, body: RenderElement) => (
      <Box key={`block-${key}`} flexDirection="column">
        {header(key, label, size)}
        {!isFolded(key, size) && body}
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1} minHeight={Math.max(1, e.props.scroll.bodyRows)}>
        <Box flexDirection="column" rowGap={1} flexGrow={1}>
          <Text weight="bold">{heading || 'New session'}</Text>
          {section('context', 'Context', null, contextBody)}
          {section('usage', 'Usage', null, usageBody)}
          {section('mcp', 'MCP', snap.mcp.length, mcpBody)}
          {section('files', 'Modified Files', snap.files.length, filesBody)}
          {list.length > 0 && section('todo', `Todo ${done}/${list.length}`, list.length, todoBody)}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="truncate-start">
            <Text dimColor>{shortPath(snap.cwd, snap.home)}</Text>
            {snap.branch !== null && <Text color="suggestion">:{snap.branch}</Text>}
          </Text>
          <Text>
            <Text color="claude">● </Text>
            <Text weight="bold">Claude Code</Text>
            {snap.version !== '' && <Text dimColor> {snap.version}</Text>}
          </Text>
        </Box>
      </Box>
    )
  })
}

async function toggleSidebar($: $): Promise<boolean> {
  const isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
  if (isShown) {
    await $.ui.close({ id: PANE })
    await $.store.set(AUTO_OPEN_KEY, false)

    return false
  }
  await $.store.set(AUTO_OPEN_KEY, true)
  void refresh($)
  await $.ui.open({ id: PANE, title: PANE_TITLE, columns: PANE_COLUMNS })

  return true
}

async function cycleEffort($: $): Promise<void> {
  const current = await read($, effort)
  if (current.engine === 'none') {
    await $.ui.toast(`${prettyModel(current.model) || 'This model'} has no effort setting`)

    return
  }
  const shown = effortOf(current) ?? 'high'
  const next = EFFORT_LEVELS[(EFFORT_LEVELS.indexOf(shown) + 1) % EFFORT_LEVELS.length] ?? 'low'
  await setOverride($, next === current.engine ? null : next)
}

// The engine reads this variable on every request, so its header, spinner and subagents all follow it,
// and unlike /effort nothing is saved for new sessions.
async function setOverride($: $, level: EffortLevel | null): Promise<void> {
  const current = await read($, effort)
  if (current.override === level) return
  const inheritedEnv =
    current.override === null ? ((await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')) ?? null) : current.inheritedEnv
  await $.env.set('CLAUDE_CODE_EFFORT_LEVEL', level ?? inheritedEnv ?? undefined)
  await changeEffort($, state => ({ ...state, override: level, inheritedEnv }))
}

function effortOf(state: Effort): EffortLevel | null {
  if (state.override !== null) return state.override
  if (state.engine === 'none') return null

  return state.engine
}

async function changeEffort($: $, change: (state: Effort) => Effort): Promise<Effort> {
  const before = await read($, effort)
  const after = change(before)
  if (JSON.stringify(after) === JSON.stringify(before)) return before

  return update($, effort, change)
}

async function syncEffortModel($: $, model: string): Promise<void> {
  if (model === '' || (await read($, effort)).model === model) return
  await setOverride($, null)
  const saved = await savedEffort($, model)
  await changeEffort($, state => ({ ...state, model, engine: saved }))
}

async function refreshStaleEffort($: $): Promise<void> {
  const current = await read($, effort)
  if (!current.isStale || current.override !== null) return
  const saved = await savedEffort($, current.model)
  await changeEffort($, state => ({ ...state, engine: saved }))
}

async function savedEffort($: $, model: string): Promise<EffortLevel | null> {
  const settings = await $.settings.read()
  const perModel = settings.modelSettings as Record<string, { effortLevel?: unknown } | undefined> | undefined
  const saved = perModel?.[model.replace(/\[1m\]$/i, '')]?.effortLevel ?? settings.effortLevel

  return typeof saved === 'string' ? toEffortLevel(saved) : null
}

function toEffortLevel(value: string): EffortLevel | null {
  const level = value.toLowerCase()

  return (EFFORT_LEVELS as readonly string[]).includes(level) ? (level as EffortLevel) : null
}

async function refresh($: $): Promise<void> {
  if (isRefreshing) {
    isRefreshQueued = true

    return
  }
  isRefreshing = true
  try {
    const next = await collect($)
    const json = JSON.stringify(next)
    if (json !== lastSnapshotJson) {
      lastSnapshotJson = json
      await $.state.set({ plugin: 'opencode-sidebar', key: 'snapshot' }, next)
    }
    await syncEffortModel($, next.model)
    await refreshStaleEffort($)
  } catch (error) {
    $.ui.log(`opencode-sidebar: refresh failed: ${String(error)}`, { to: 'debug' })
  } finally {
    isRefreshing = false
    if (isRefreshQueued) {
      isRefreshQueued = false
      void refresh($)
    }
  }
}

async function collect($: $): Promise<Snapshot> {
  const cwd = await $.session.cwd()
  const [home, usage, model, tools, version, repo, now] = await Promise.all([
    $.env.get('HOME'),
    $.session.usage(),
    $.session.model(),
    $.tool.list(),
    $.session.version(),
    readGit($, cwd),
    $.clock.now(),
  ])
  const limits = await limitsOf($, usage.rateLimits, now)

  return {
    cwd,
    home: home ?? '',
    isRepo: repo.isRepo,
    branch: repo.branch,
    files: repo.files,
    model,
    tokens: usage.context.tokens ?? null,
    window: usage.context.window,
    percent: usage.context.percent ?? null,
    costUsd: usage.cost?.usd ?? null,
    mcp: mcpServersOf(tools.map(tool => tool.name)),
    version: version.base ?? version.version,
    limits,
    minute: Math.floor(now / MINUTE),
  }
}

type GitState = { isRepo: boolean; branch: string | null; files: ChangedFile[] }

async function readGit($: $, cwd: string): Promise<GitState> {
  const root = await git($, cwd, ['rev-parse', '--show-toplevel'])
  if (!root.ok) return { isRepo: false, branch: null, files: [] }
  const top = root.out.trim()

  const [symbolic, status, staged] = await Promise.all([
    git($, top, ['symbolic-ref', '--short', '-q', 'HEAD']),
    git($, top, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']),
    git($, top, ['diff', '--numstat', '--no-renames', 'HEAD']),
  ])
  const branch = symbolic.ok
    ? symbolic.out.trim()
    : (await git($, top, ['rev-parse', '--short', 'HEAD'])).out.trim() || null

  const counts = new Map<string, { added: number; removed: number }>()
  const numstat = staged.ok ? staged : await git($, top, ['diff', '--numstat', '--no-renames'])
  for (const line of numstat.out.split('\n')) {
    const [added, removed, ...rest] = line.split('\t')
    if (rest.length === 0) continue
    counts.set(rest.join('\t'), { added: toCount(added), removed: toCount(removed) })
  }

  const files: ChangedFile[] = []
  let untrackedCounted = 0
  for (const entry of status.out.split('\0')) {
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    const flag = code === '??' ? '?' : (code.trim()[0] ?? 'M')
    let count = counts.get(path) ?? { added: 0, removed: 0 }
    if (flag === '?' && untrackedCounted < MAX_UNTRACKED_COUNTED) {
      untrackedCounted++
      const fresh = await git($, top, ['diff', '--no-index', '--numstat', '--', '/dev/null', path])
      const [added] = fresh.out.split('\t')
      count = { added: toCount(added), removed: 0 }
    }
    files.push({ path, status: flag, ...count })
    if (files.length >= MAX_FILES) break
  }
  files.sort((a, b) => a.path.localeCompare(b.path))

  return { isRepo: true, branch, files }
}

async function git($: $, cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const run = await $.process.run(['git', '-c', 'core.quotePath=false', ...args], {
      cwd,
      timeoutMs: 5000,
    })

    return { ok: run.exitCode === 0, out: run.stdout }
  } catch {
    return { ok: false, out: '' }
  }
}

async function restoreTitle($: $): Promise<void> {
  if ((await read($, title)) !== '') return
  const messages = await $.session.messages()
  if ('deny' in messages) return
  const first = messages.find(m => m.role === 'user' && m.text.trim() !== '' && !m.text.startsWith('<'))
  if (first !== undefined) await update($, title, () => toTitle(first.text))
}

type LiveWindow = { kind: string; percentUsed: number; resetsAt?: string }

// The headers on each model response only carry the session and weekly windows, so the per-model
// weekly limits (Fable's) come from the account's usage endpoint, the one /usage reads.
async function limitsOf($: $, live: readonly LiveWindow[], now: number): Promise<RateWindow[]> {
  const account = await accountLimits($, now)
  const fresh = live.map(fromLive)
  let windows: RateWindow[]
  if (account !== null || fresh.length > 0) {
    windows = mergeLimits(account ?? [], fresh)
    if (JSON.stringify(windows) !== JSON.stringify(await $.store.get(LIMITS_KEY))) {
      await $.store.set(LIMITS_KEY, windows)
    }
  } else {
    const kept = await $.store.get(LIMITS_KEY)
    windows = Array.isArray(kept) ? (kept as Partial<RateWindow>[]).flatMap(toWindow) : []
  }

  return windows.map(w =>
    w.resetsAt !== null && Date.parse(w.resetsAt) <= now ? { ...w, percentUsed: 0, resetsAt: null } : w,
  )
}

async function accountLimits($: $, now: number): Promise<RateWindow[] | null> {
  const wait = isAccountUsageStale ? USAGE_AFTER_TURN_MS : USAGE_REFRESH_MS
  if (now - accountUsageFetchedAt < wait) return accountUsage
  accountUsageFetchedAt = now
  isAccountUsageStale = false
  try {
    const auth = await $.session.authorize()
    if (auth === null) {
      accountUsage = null
    } else {
      const response = await $.http.fetch(USAGE_URL, {
        auth: auth.handle,
        headers: { 'anthropic-beta': 'oauth-2025-04-20' },
      })
      if (response.ok) accountUsage = parseAccountLimits(JSON.parse(response.text))
    }
  } catch (error) {
    $.ui.log(`opencode-sidebar: usage fetch failed: ${String(error)}`, { to: 'debug' })
  }

  return accountUsage
}

export function parseAccountLimits(body: unknown): RateWindow[] | null {
  const limits = (body as { limits?: unknown } | null)?.limits
  if (!Array.isArray(limits)) return null

  return limits.flatMap((item: unknown): RateWindow[] => {
    const limit = item as { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: unknown }
    if (typeof limit.kind !== 'string' || typeof limit.percent !== 'number') return []
    const scope = scopeName(limit.scope)
    const kind = scope === null ? limit.kind : `${limit.kind}:${scope}`

    return [
      {
        kind,
        label: scope ?? limitLabel(limit.kind),
        percentUsed: limit.percent,
        resetsAt: typeof limit.resets_at === 'string' ? limit.resets_at : null,
      },
    ]
  })
}

function scopeName(scope: unknown): string | null {
  const named = scope as { model?: { display_name?: unknown }; surface?: { display_name?: unknown } } | null
  const name = named?.model?.display_name ?? named?.surface?.display_name

  return typeof name === 'string' && name !== '' ? name : null
}

// Usage only climbs within a window, so of two readings of the same window the higher is the newer;
// a later reset means the window rolled over and that reading wins.
export function mergeLimits(account: readonly RateWindow[], live: readonly RateWindow[]): RateWindow[] {
  const merged = account.map(window => {
    const other = live.find(w => w.kind === window.kind)
    if (other === undefined) return window
    const resets = (w: RateWindow) => (w.resetsAt === null ? 0 : Date.parse(w.resetsAt))
    if (Math.abs(resets(other) - resets(window)) > MINUTE) return resets(other) > resets(window) ? other : window

    return other.percentUsed > window.percentUsed ? { ...window, percentUsed: other.percentUsed } : window
  })

  return [...merged, ...live.filter(w => !account.some(a => a.kind === w.kind))]
}

function fromLive(window: LiveWindow): RateWindow {
  const kind = LIVE_KINDS[window.kind] ?? window.kind

  return { kind, label: limitLabel(kind), percentUsed: window.percentUsed, resetsAt: window.resetsAt ?? null }
}

function toWindow(kept: Partial<RateWindow>): RateWindow[] {
  if (typeof kept.kind !== 'string' || typeof kept.percentUsed !== 'number') return []
  const kind = LIVE_KINDS[kept.kind] ?? kept.kind

  return [{ kind, label: kept.label ?? limitLabel(kind), percentUsed: kept.percentUsed, resetsAt: kept.resetsAt ?? null }]
}

function limitLabel(kind: string): string {
  if (kind === 'session') return '5h'
  if (kind === 'weekly_all') return 'Week'
  if (kind === 'spend_limit') return 'Spend'

  return kind.replace(/_/g, ' ')
}

function limitTone(percent: number): string {
  if (percent >= 90) return 'error'
  if (percent >= 75) return 'warning'

  return 'text'
}

function gaugeFill(percent: number): number {
  return Math.max(0, Math.min(5, Math.round(percent / 20)))
}

function gauge(percent: number): string {
  return '▮'.repeat(gaugeFill(percent))
}

function untilReset(resetsAt: string, minute: number): string {
  const left = Date.parse(resetsAt) - minute * MINUTE
  if (!Number.isFinite(left) || left <= 0) return 'now'
  const days = Math.floor(left / DAY)
  const hours = Math.floor((left % DAY) / HOUR)
  const minutes = Math.max(1, Math.floor((left % HOUR) / MINUTE))
  if (days > 0) return `${days}d ${hours}h`

  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function prettyModel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(model)
  if (match === null) return model
  const [, family = '', major, minor, wide] = match
  const name = family.charAt(0).toUpperCase() + family.slice(1)

  return `${name} ${major}${minor !== undefined ? `.${minor}` : ''}${wide !== undefined ? ' (1M)' : ''}`
}

const CLOUD_PREFIX = 'claude_ai_'

// A server that is not signed in offers only these tools.
const AUTH_TOOLS = ['authenticate', 'complete_authentication']

export function mcpServersOf(names: string[]): McpServer[] {
  const servers = new Map<string, string[]>()
  for (const name of names) {
    const [prefix, server, tool] = name.split('__')
    if (prefix !== 'mcp' || !server || tool === undefined) continue
    servers.set(server, [...(servers.get(server) ?? []), tool])
  }

  return [...servers]
    .map(([raw, tools]) => {
      const isCloud = raw.startsWith(CLOUD_PREFIX)

      return {
        name: (isCloud ? raw.slice(CLOUD_PREFIX.length) : raw).replace(/_/g, ' '),
        isCloud,
        needsAuth: tools.every(tool => AUTH_TOOLS.includes(tool)),
        tools: tools.length,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function taskIdOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || !('task' in result)) return null
  const task = (result as { task?: { id?: unknown } }).task

  return typeof task?.id === 'string' ? task.id : null
}

function isMutating(tool: string): boolean {
  return ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'].includes(tool)
}

function toTitle(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''

  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

function toCount(value: string | undefined): number {
  const n = Number(value)

  return Number.isFinite(n) ? n : 0
}

function formatTokens(tokens: number | null): string {
  if (tokens === null) return '0'

  return String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatPercent(percent: number | null): string {
  return `${percent ?? 0}%`
}

function formatCost(usd: number | null): string {
  return `$${(usd ?? 0).toFixed(2)}`
}

function bar(percent: number | null, width: number): string {
  const size = Math.max(5, width)
  const filled = Math.round(((percent ?? 0) / 100) * size)

  return '▰'.repeat(filled) + '▱'.repeat(size - filled)
}

function contextColor(percent: number | null): string {
  if ((percent ?? 0) >= 90) return 'error'
  if ((percent ?? 0) >= 70) return 'warning'

  return 'success'
}

function fileColor(status: string): string | undefined {
  if (status === '?' || status === 'A') return 'success'
  if (status === 'D') return 'error'

  return undefined
}

function statusLabel(status: string): string {
  if (status === '?') return 'new'
  if (status === 'D') return 'deleted'

  return status
}

function todoMark(status: TodoStatus): string {
  if (status === 'completed') return '[✓]'
  if (status === 'in_progress') return '[•]'

  return '[ ]'
}

function todoColor(status: TodoStatus): string | undefined {
  if (status === 'completed') return 'success'
  if (status === 'in_progress') return 'warning'

  return undefined
}

function shortPath(path: string, home: string): string {
  if (home !== '' && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`

  return path
}

function locationOf(snap: Snapshot): string {
  const where = shortPath(snap.cwd, snap.home)

  return snap.branch === null ? where : `${where}:${snap.branch}`
}
