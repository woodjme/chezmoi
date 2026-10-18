export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export type Todo = {
  id: string
  content: string
  status: TodoStatus
  source: 'todo' | 'task'
}

export type ChangedFile = {
  path: string
  added: number
  removed: number
  status: string
}

export type McpServer = {
  name: string
  isCloud: boolean
  needsAuth: boolean
  tools: number
}

export type RateWindow = {
  kind: string
  label: string
  percentUsed: number
  resetsAt: string | null
}

export type Snapshot = {
  cwd: string
  home: string
  isRepo: boolean
  branch: string | null
  files: ChangedFile[]
  model: string
  tokens: number | null
  window: number
  percent: number | null
  costUsd: number | null
  mcp: McpServer[]
  version: string
  limits: RateWindow[]
  minute: number
}

export type Section = 'context' | 'usage' | 'mcp' | 'files' | 'todo'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Effort = {
  model: string
  engine: EffortLevel | 'none' | null
  override: EffortLevel | null
  inheritedEnv: string | null
  isStale: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'opencode-sidebar': {
      snapshot: Snapshot
      todos: Todo[]
      title: string
      collapsed: Partial<Record<Section, boolean>>
      effort: Effort
    }
  }
}
