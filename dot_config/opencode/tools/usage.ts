import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

interface AuthEntry { type: string; access: string; refresh: string; expires: number }
interface AuthStore { anthropic?: AuthEntry; openai?: AuthEntry }

function loadAuth(): AuthStore {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf-8"))
  } catch { return {} }
}

function loadCodexAuth(): string | null {
  for (const p of [
    join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"),
    join(homedir(), ".config", "codex", "auth.json"),
  ]) {
    try {
      const d = JSON.parse(readFileSync(p, "utf-8"))
      return d.access_token || d.token || null
    } catch {}
  }
  return null
}

function resetIn(v: string | number | undefined | null): string {
  if (v == null) return ""
  let ms: number
  if (typeof v === "number") {
    // handle both seconds and milliseconds unix timestamps
    const ts = v > 1e12 ? v : v * 1000
    ms = ts - Date.now()
  } else {
    ms = new Date(v).getTime() - Date.now()
  }
  if (ms <= 0) return "now"
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const BAR_WIDTH = 20
function usageBar(usedPct: number): string {
  const clamped = Math.min(100, Math.max(0, usedPct))
  const filled = Math.round((clamped / 100) * BAR_WIDTH)
  const empty = BAR_WIDTH - filled
  return "\u2588".repeat(filled) + "\u2591".repeat(empty)
}

interface Row { window: string; usedPct: number; resets: string }

function renderSection(title: string, rows: Row[]): string {
  const lines: string[] = [title, ""]
  const nameWidth = Math.max(12, ...rows.map(r => r.window.length))
  for (const r of rows) {
    const label = r.window.padEnd(nameWidth)
    const bar = usageBar(r.usedPct)
    const pct = `${Math.round(r.usedPct)}%`.padStart(4)
    const reset = r.resets ? `  resets in ${r.resets}` : ""
    lines.push(`  ${label}  ${bar} ${pct}${reset}`)
  }
  return lines.join("\n")
}

async function claudeSection(): Promise<string> {
  const auth = loadAuth()
  const token = auth.anthropic?.access || process.env.ANTHROPIC_API_KEY
  if (!token) return "Claude\n\n  No credentials. Run /connect."
  if (auth.anthropic && Date.now() > auth.anthropic.expires) return "Claude\n\n  Token expired. Run /connect."

  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      "Authorization": `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Accept": "application/json",
    },
  })
  if (res.status === 401 || res.status === 403) return "Claude\n\n  Token rejected. Run /connect."
  if (!res.ok) return `Claude\n\n  HTTP ${res.status}`

  const data = await res.json() as any
  const rows: Row[] = []

  const add = (name: string, w: any) => {
    if (!w || w.utilization == null) return
    rows.push({ window: name, usedPct: w.utilization, resets: resetIn(w.resets_at) })
  }

  add("Session (5h)", data.five_hour)
  add("Weekly", data.seven_day)
  add("Weekly Opus", data.seven_day_opus)
  add("Weekly Sonnet", data.seven_day_sonnet)

  if (Array.isArray(data.limits)) {
    for (const lim of data.limits) {
      if (!lim.is_active || lim.percent == null) continue
      const name = lim.scope?.model?.display_name
        ? `Weekly ${lim.scope.model.display_name}`
        : lim.kind || "Other"
      rows.push({ window: name, usedPct: lim.percent, resets: resetIn(lim.resets_at) })
    }
  }

  if (data.extra_usage?.is_enabled && data.extra_usage.used_credits != null) {
    const eu = data.extra_usage
    const pct = eu.monthly_limit ? (eu.used_credits / eu.monthly_limit) * 100 : eu.utilization || 0
    rows.push({ window: `Extra ($${Number(eu.used_credits).toFixed(0)}/${eu.monthly_limit ? "$" + eu.monthly_limit : "?"})`, usedPct: pct, resets: "" })
  }

  const plan = data.rate_limit_tier || data.subscription_type || ""
  const title = plan ? `Claude (${plan})` : "Claude"

  return rows.length > 0 ? renderSection(title, rows) : `${title}\n\n  No usage windows returned.`
}

async function codexSection(): Promise<string> {
  const auth = loadAuth()
  let token = auth.openai?.access

  if (token && auth.openai && Date.now() > auth.openai.expires) token = undefined
  if (!token) token = loadCodexAuth() ?? undefined
  if (!token) token = process.env.OPENAI_API_KEY
  if (!token) return "Codex\n\n  No credentials. Run /connect."

  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    },
  })
  if (res.status === 401 || res.status === 403) return "Codex\n\n  Token rejected. Run /connect."
  if (!res.ok) return `Codex\n\n  HTTP ${res.status}`

  const data = await res.json() as any
  const rows: Row[] = []
  const plan = data.plan_type || data.plan || ""

  const add = (name: string, w: any) => {
    if (!w) return
    const pct = w.used_percent ?? w.usedPercent ?? w.utilization
    if (pct == null) return
    rows.push({ window: name, usedPct: pct, resets: resetIn(w.reset_at ?? w.resetAt ?? w.resets_at) })
  }

  if (data.rate_limit) {
    add("Session (5h)", data.rate_limit.primary_window)
    add("Weekly", data.rate_limit.secondary_window)
  }

  if (Array.isArray(data.additional_rate_limits)) {
    for (const extra of data.additional_rate_limits) {
      const name = extra.limit_name || extra.metered_feature || "Extra"
      if (extra.rate_limit) {
        add(`${name} (5h)`, extra.rate_limit.primary_window)
        add(`${name} (wk)`, extra.rate_limit.secondary_window)
      }
    }
  }

  const title = plan ? `Codex (${plan})` : "Codex"
  return rows.length > 0 ? renderSection(title, rows) : `${title}\n\n  No usage windows returned.`
}

export default tool({
  description:
    "Check subscription usage for Claude and OpenAI/Codex. " +
    "Shows usage bars with percent used and reset countdowns. " +
    "Reads OAuth tokens from OpenCode's auth store automatically.",
  args: {
    provider: tool.schema
      .string()
      .optional()
      .describe("'all' (default), 'claude', or 'codex'"),
  },
  async execute(args) {
    const p = (args.provider || "all").toLowerCase()
    const sections: string[] = []

    const run = async (fn: () => Promise<string>) => {
      try { sections.push(await fn()) }
      catch (err) { sections.push(String(err)) }
    }

    if (p === "all" || p === "claude" || p === "anthropic") await run(claudeSection)
    if (p === "all" || p === "codex" || p === "openai" || p === "chatgpt") await run(codexSection)

    return sections.join("\n\n") || "No providers matched."
  },
})
