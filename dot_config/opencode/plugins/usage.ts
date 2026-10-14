import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

type Integration = Plugin.Context["integration"]

interface Token {
  access: string
  expires?: number
}

const run = promisify(execFile)

async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf-8"))
  } catch {
    return undefined
  }
}

// OpenCode's own stored OAuth credential; external (plugin-managed) connections return undefined.
async function storedToken(integration: Integration, id: string): Promise<Token | undefined> {
  try {
    const connection = await integration.connection.active(id)
    if (!connection) return undefined
    const credential = await integration.connection.resolve(connection)
    if (credential?.type === "oauth") return { access: credential.access, expires: credential.expires }
    if (credential?.type === "key") return { access: credential.key }
  } catch {}
  return undefined
}

// The same Claude Code login that opencode-claude-auth-v2 uses.
async function claudeCodeToken(): Promise<Token | undefined> {
  let raw: any
  if (process.platform === "darwin") {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"])
      raw = JSON.parse(stdout)
    } catch {}
  }
  raw ??= await readJson(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json"))
  const oauth = raw?.claudeAiOauth
  return oauth?.accessToken ? { access: oauth.accessToken, expires: oauth.expiresAt } : undefined
}

async function codexCliToken(): Promise<Token | undefined> {
  for (const path of [
    join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"),
    join(homedir(), ".config", "codex", "auth.json"),
  ]) {
    const data = await readJson(path)
    const access = data?.tokens?.access_token || data?.access_token || data?.token
    if (access) return { access }
  }
  return undefined
}

const fresh = (token?: Token) => (token && (!token.expires || Date.now() < token.expires) ? token : undefined)

function resetIn(v: string | number | undefined | null): string {
  if (v == null) return ""
  // Unix timestamps arrive in either seconds or milliseconds.
  const ms = typeof v === "number" ? (v > 1e12 ? v : v * 1000) - Date.now() : new Date(v).getTime() - Date.now()
  if (ms <= 0) return "now"
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const BAR_WIDTH = 20
function usageBar(usedPct: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, usedPct)) / 100) * BAR_WIDTH)
  return "\u2588".repeat(filled) + "\u2591".repeat(BAR_WIDTH - filled)
}

interface Row {
  window: string
  usedPct: number
  resets: string
}

function renderSection(title: string, rows: Row[]): string {
  const lines: string[] = [title, ""]
  const nameWidth = Math.max(12, ...rows.map((r) => r.window.length))
  for (const r of rows) {
    const pct = `${Math.round(r.usedPct)}%`.padStart(4)
    const reset = r.resets ? `  resets in ${r.resets}` : ""
    lines.push(`  ${r.window.padEnd(nameWidth)}  ${usageBar(r.usedPct)} ${pct}${reset}`)
  }
  return lines.join("\n")
}

async function claudeSection(integration: Integration): Promise<string> {
  const token =
    fresh(await storedToken(integration, "anthropic")) ??
    fresh(await claudeCodeToken()) ??
    (process.env.ANTHROPIC_API_KEY ? { access: process.env.ANTHROPIC_API_KEY } : undefined)
  if (!token) return "Claude\n\n  No valid credentials. Run `claude` once or /connect."

  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token.access}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    },
  })
  if (res.status === 401 || res.status === 403) return "Claude\n\n  Token rejected. Run `claude` once or /connect."
  if (!res.ok) return `Claude\n\n  HTTP ${res.status}`

  const data = (await res.json()) as any
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
      const model = lim.scope?.model?.display_name
      const resets = resetIn(lim.resets_at)
      // Unscoped limits (e.g. weekly_all) repeat the windows already listed above.
      if (!model && rows.some((r) => r.usedPct === lim.percent && r.resets === resets)) continue
      rows.push({ window: model ? `Weekly ${model}` : lim.kind || "Other", usedPct: lim.percent, resets })
    }
  }

  if (data.extra_usage?.is_enabled && data.extra_usage.used_credits != null) {
    const eu = data.extra_usage
    const pct = eu.monthly_limit ? (eu.used_credits / eu.monthly_limit) * 100 : eu.utilization || 0
    const limit = eu.monthly_limit ? "$" + eu.monthly_limit : "?"
    rows.push({ window: `Extra ($${Number(eu.used_credits).toFixed(0)}/${limit})`, usedPct: pct, resets: "" })
  }

  const plan = data.rate_limit_tier || data.subscription_type || ""
  const title = plan ? `Claude (${plan})` : "Claude"
  return rows.length > 0 ? renderSection(title, rows) : `${title}\n\n  No usage windows returned.`
}

async function codexSection(integration: Integration): Promise<string> {
  const token =
    fresh(await storedToken(integration, "openai")) ??
    (await codexCliToken()) ??
    (process.env.OPENAI_API_KEY ? { access: process.env.OPENAI_API_KEY } : undefined)
  if (!token) return "Codex\n\n  No valid credentials. Run /connect."

  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${token.access}`, Accept: "application/json" },
  })
  if (res.status === 401 || res.status === 403) return "Codex\n\n  Token rejected. Run /connect."
  if (!res.ok) return `Codex\n\n  HTTP ${res.status}`

  const data = (await res.json()) as any
  const rows: Row[] = []
  const add = (name: string, w: any) => {
    const pct = w?.used_percent ?? w?.usedPercent ?? w?.utilization
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
      if (!extra.rate_limit) continue
      add(`${name} (5h)`, extra.rate_limit.primary_window)
      add(`${name} (wk)`, extra.rate_limit.secondary_window)
    }
  }

  const plan = data.plan_type || data.plan || ""
  const title = plan ? `Codex (${plan})` : "Codex"
  return rows.length > 0 ? renderSection(title, rows) : `${title}\n\n  No usage windows returned.`
}

export default Plugin.define({
  id: "jamiewood.usage",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "usage",
        description:
          "Check subscription usage for Claude and OpenAI/Codex. " +
          "Shows usage bars with percent used and reset countdowns. " +
          "Reads OAuth tokens from OpenCode's credential store or the Claude Code login automatically.",
        input: {
          type: "object",
          properties: {
            provider: { type: "string", description: "'all' (default), 'claude', or 'codex'" },
          },
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input) {
          const p = String((input as { provider?: string }).provider || "all").toLowerCase()
          const sections: string[] = []
          const section = async (fn: (i: Integration) => Promise<string>) => {
            try {
              sections.push(await fn(ctx.integration))
            } catch (err) {
              sections.push(String(err))
            }
          }

          if (["all", "claude", "anthropic"].includes(p)) await section(claudeSection)
          if (["all", "codex", "openai", "chatgpt"].includes(p)) await section(codexSection)

          return { content: sections.join("\n\n") || "No providers matched." }
        },
      })
    })
  },
})
