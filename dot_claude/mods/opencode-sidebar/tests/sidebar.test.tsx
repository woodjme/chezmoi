import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { mcpServersOf, mergeLimits, parseAccountLimits } from '../hooks/register'

const PANE = {
  plugin: 'opencode-sidebar',
  component: 'Pane',
  requestId: 'opencode-sidebar',
  props: {
    title: 'Sidebar',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const TODOS = [
  { content: 'Write the parser', status: 'completed', activeForm: 'Writing the parser' },
  { content: 'Wire up the CLI', status: 'in_progress', activeForm: 'Wiring up the CLI' },
  { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' },
] as const

test('docked sidebar shows its sections and tracks todos on every surface', async ($, on) => {
  on('tool.call', { tool: 'TodoWrite' }, () => ({
    result: { oldTodos: [], newTodos: [...TODOS] },
  }))
  await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Context/ })).toBeDefined()
    expect(await ui.find({ text: /Modified Files/ })).toBeDefined()
    expect(await ui.find({ text: /Todo 1\/3/ })).toBeDefined()
    expect(await ui.find({ text: /Wire up the CLI/ })).toBeDefined()
    expect(await ui.find({ text: /Claude Code/ })).toBeDefined()

    await ui.press({ key: 'section-todo' })
    expect(await ui.find({ text: /Wire up the CLI/ })).toBeUndefined()
    await ui.press({ key: 'section-todo' })
    expect(await ui.find({ text: /Wire up the CLI/ })).toBeDefined()
    await ui.unmount()
  }
})

test('sections without a count fold and unfold on every press', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /tokens/ })).toBeDefined()
  expect(await ui.find({ text: /▼/ })).toBeDefined()

  await ui.press({ key: 'section-context' })
  expect(await ui.find({ text: /tokens/ })).toBeUndefined()
  await ui.press({ key: 'section-context' })
  expect(await ui.find({ text: /tokens/ })).toBeDefined()
  await ui.unmount()
})

test('MCP servers drop the claude.ai prefix, are marked cloud or local, and flag a missing sign-in', () => {
  expect(
    mcpServersOf([
      'mcp__claude_ai_Zero_Based_Gitlab__get_issue',
      'mcp__claude_ai_Zero_Based_Gitlab__list_projects',
      'mcp__claude_ai_Canva__authenticate',
      'mcp__claude_ai_Canva__complete_authentication',
      'mcp__plugin-authoring__scan_secrets',
      'Read',
    ]),
  ).toEqual([
    { name: 'Canva', isCloud: true, needsAuth: true, tools: 2 },
    { name: 'plugin-authoring', isCloud: false, needsAuth: false, tools: 1 },
    { name: 'Zero Based Gitlab', isCloud: true, needsAuth: false, tools: 2 },
  ])
})

const WEEK_RESET = '2026-10-19T18:59:59.852598+00:00'
const SESSION_RESET = '2026-10-19T01:29:59.852570+00:00'

test('account usage keeps per-model weekly limits such as Fable', () => {
  const body = {
    five_hour: { utilization: 7 },
    limits: [
      { kind: 'session', percent: 7, resets_at: SESSION_RESET, scope: null },
      { kind: 'weekly_all', percent: 28, resets_at: WEEK_RESET, scope: null },
      {
        kind: 'weekly_scoped',
        percent: 16,
        resets_at: WEEK_RESET,
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      },
      { kind: 'broken' },
    ],
  }
  expect(parseAccountLimits(body)).toEqual([
    { kind: 'session', label: '5h', percentUsed: 7, resetsAt: SESSION_RESET },
    { kind: 'weekly_all', label: 'Week', percentUsed: 28, resetsAt: WEEK_RESET },
    { kind: 'weekly_scoped:Fable', label: 'Fable', percentUsed: 16, resetsAt: WEEK_RESET },
  ])
  expect(parseAccountLimits({ error: 'unauthorized' })).toBeNull()
})

test('live readings update the account windows they share, and a rolled-over window wins', () => {
  const account = [
    { kind: 'session', label: '5h', percentUsed: 7, resetsAt: SESSION_RESET },
    { kind: 'weekly_all', label: 'Week', percentUsed: 28, resetsAt: WEEK_RESET },
    { kind: 'weekly_scoped:Fable', label: 'Fable', percentUsed: 16, resetsAt: WEEK_RESET },
  ]
  const nextSession = '2026-10-19T06:29:59.000000+00:00'
  expect(
    mergeLimits(account, [
      { kind: 'session', label: '5h', percentUsed: 2, resetsAt: nextSession },
      { kind: 'weekly_all', label: 'Week', percentUsed: 29, resetsAt: '2026-10-19T18:59:59+00:00' },
      { kind: 'spend_limit', label: 'Spend', percentUsed: 40, resetsAt: null },
    ]),
  ).toEqual([
    { kind: 'session', label: '5h', percentUsed: 2, resetsAt: nextSession },
    { kind: 'weekly_all', label: 'Week', percentUsed: 29, resetsAt: WEEK_RESET },
    { kind: 'weekly_scoped:Fable', label: 'Fable', percentUsed: 16, resetsAt: WEEK_RESET },
    { kind: 'spend_limit', label: 'Spend', percentUsed: 40, resetsAt: null },
  ])
})

test('inline placement draws a one-row summary', async $ => {
  const ui = await $.ui.mount({
    ...PANE,
    surface: 'terminal',
    props: { ...PANE.props, placement: 'inline' },
  })
  expect(await ui.find({ text: /context/ })).toBeDefined()
  expect(await ui.find({ text: /Modified Files/ })).toBeUndefined()
  await ui.unmount()
})

test('footer right side keeps the mode labels and adds the model and the sidebar toggle', async ($, on) => {
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>focus</Text>
  })
  const ui = await $.ui.mount({
    plugin: 'opencode-sidebar',
    surface: 'terminal',
    component: 'SessionMode',
    props: { modes: ['focus'] },
  })
  expect(await ui.find({ text: /focus/ })).toBeDefined()
  expect(await ui.find({ key: 'toggle-sidebar' })).toBeDefined()
  expect(await ui.find({ key: 'cycle-effort' })).toBeDefined()
  await ui.unmount()
})

const FOOTER = {
  plugin: 'opencode-sidebar',
  surface: 'terminal',
  component: 'SessionMode',
  props: { modes: [] },
} as const

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// Stands in for the engine: draws an empty mode list, answers each model request and holds the environment.
function engineBeneath(on: On): Map<string, string> {
  const env = new Map<string, string>()
  on('env.get', (_$, e) => ({ value: env.get(e.name) }))
  on('env.set', (_$, e) => {
    if (e.value === undefined) env.delete(e.name)
    else env.set(e.name, e.value)

    return { value: {} }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('turn.step', async function* (_$, e) {
    yield* []

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  return env
}

async function step($: Engine, effort: Effort | undefined, agentId?: string): Promise<void> {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort, messageCount: 1, agentId })
  for await (const _chunk of stream) {
    // drain
  }
}

test('ctrl+t cycles the effort shown in the footer through the engine variable', async ($, on) => {
  const env = engineBeneath(on)
  await step($, 'high')
  const ui = await $.ui.mount(FOOTER)
  expect(await ui.find({ text: /^high$/ })).toBeDefined()

  await ui.press({ key: 'cycle-effort' })
  expect(await ui.find({ text: /^xhigh$/ })).toBeDefined()
  expect(env.get('CLAUDE_CODE_EFFORT_LEVEL')).toBe('xhigh')

  await step($, 'medium', 'subagent-1')
  expect(await ui.find({ text: /^xhigh$/ })).toBeDefined()

  for (const level of ['max', 'low', 'medium']) {
    await ui.press({ key: 'cycle-effort' })
    expect(await ui.find({ text: new RegExp(`^${level}$`) })).toBeDefined()
    expect(env.get('CLAUDE_CODE_EFFORT_LEVEL')).toBe(level)
  }
  await ui.press({ key: 'cycle-effort' })
  expect(await ui.find({ text: /^high$/ })).toBeDefined()
  expect(env.get('CLAUDE_CODE_EFFORT_LEVEL')).toBeUndefined()
  await ui.unmount()
})

test('/effort typed by the person runs without the variable and replaces the cycled level', async ($, on) => {
  const env = engineBeneath(on)
  let envDuringRun: string | undefined = 'unread'
  on('command.run', { command: 'effort' }, () => {
    envDuringRun = env.get('CLAUDE_CODE_EFFORT_LEVEL')

    return {}
  })
  on('settings.read', () => ({ value: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'low' } } } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.turn.start({ turnId: 't', text: 'hi' })
  await step($, 'high')
  const ui = await $.ui.mount(FOOTER)
  await ui.press({ key: 'cycle-effort' })
  expect(await ui.find({ text: /^xhigh$/ })).toBeDefined()

  await $.command.run({
    command: 'effort',
    args: 'low',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  expect(envDuringRun).toBeUndefined()
  expect(await ui.find({ text: /^low$/ })).toBeDefined()
  await ui.unmount()
})

test('a model without effort shows no level and leaves the variable alone', async ($, on) => {
  const env = engineBeneath(on)
  await step($, undefined)
  const ui = await $.ui.mount(FOOTER)
  expect(await ui.find({ text: /^(low|medium|high|xhigh|max)$/ })).toBeUndefined()
  await ui.press({ key: 'cycle-effort' })
  expect(env.get('CLAUDE_CODE_EFFORT_LEVEL')).toBeUndefined()
  await ui.unmount()
})
