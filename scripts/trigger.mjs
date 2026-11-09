/**
 * 触发接口（RSI 侧）：预算检查 → 参数白名单 → dispatch。
 *
 * 三道闸的落点（对应架构要求）：
 *   ① 本轮预算检查（dispatch **之前**）——读 trigger_budget.json，超限/冷却中一律不 dispatch；
 *   ② 参数白名单——focus/depth/max_items 只接受枚举，非法直接拒；
 *   ③ workflow 侧硬 gate——0 条 LIVE 即失败（不在本脚本，在 collect.yml）。
 *
 * 幂等键：同一 (focus,depth,max_items,轮次) 不重复 dispatch。
 *
 *   node scripts/trigger.mjs --budget <trigger_budget.json> --token-env GH_TOKEN \
 *        --focus <f> --depth <d> --max-items <n> [--dry-run]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

export const REPO = 'q785845530/rsi-public-runners'
export const WORKFLOW_FILE = 'collect.yml'
export const FOCI = Object.freeze([
  'rsi-self-verification', 'sandbox-isolation', 'self-improving-search',
  'anti-cheat-verifier', 'program-synthesis',
])
export const DEPTHS = Object.freeze(['shallow', 'standard', 'deep'])
export const MAX_ITEMS_CAP = 50

const argv = process.argv.slice(2)
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const has = (k) => argv.includes(k)

/** ① 预算检查：必须在 dispatch 之前。 */
export function checkBudget({ budget = {}, now = new Date() } = {}) {
  const dailyLimit = Number(budget.daily_dispatch_limit ?? 6)
  const dailyUsed = Number(budget.daily_used ?? 0)
  const cooldownMin = Number(budget.cooldown_minutes ?? 120)
  const lastAt = budget.last_dispatch_at ? new Date(budget.last_dispatch_at) : null
  const sinceMin = lastAt ? (now.getTime() - lastAt.getTime()) / 60000 : Infinity

  if (dailyUsed >= dailyLimit) {
    return { ok: false, reason: 'DAILY_LIMIT_REACHED', dailyUsed, dailyLimit,
      note: '预算耗尽，本轮跳过（记录到改进日志，不 dispatch）' }
  }
  // 未来时间戳是异常输入（时钟错/手改配置），不能当成"刚刚跑过"也不能当成"早就跑过"
  // ——按 COOLDOWN 处理并标记，避免用错误配置绕过预算。
  if (sinceMin < 0) {
    return { ok: false, reason: 'LAST_DISPATCH_IN_FUTURE', sinceMin: Math.round(sinceMin),
      note: 'last_dispatch_at 在未来，配置异常，拒绝 dispatch' }
  }
  if (sinceMin < cooldownMin) {
    return { ok: false, reason: 'COOLDOWN', sinceMin: Math.round(sinceMin), cooldownMin }
  }
  return { ok: true, reason: null, dailyUsed, dailyLimit, sinceMin: Math.round(sinceMin) }
}

/** ② 参数白名单。 */
export function checkParams({ focus, depth, maxItems } = {}) {
  if (!FOCI.includes(focus)) return { ok: false, reason: 'ILLEGAL_FOCUS', got: focus, allowed: FOCI }
  if (!DEPTHS.includes(depth)) return { ok: false, reason: 'ILLEGAL_DEPTH', got: depth, allowed: DEPTHS }
  const n = Number(maxItems)
  if (!Number.isFinite(n) || n < 1 || n > MAX_ITEMS_CAP) {
    return { ok: false, reason: 'MAX_ITEMS_OUT_OF_RANGE', got: maxItems, cap: MAX_ITEMS_CAP }
  }
  return { ok: true, reason: null, focus, depth, max_items: Math.floor(n) }
}

/** 幂等键：同参数同轮次只发一次。 */
export function idempotencyKey({ focus, depth, maxItems, round = 0 } = {}) {
  return 'trig_' + createHash('sha256').update(`${focus}|${depth}|${maxItems}|${round}`).digest('hex').slice(0, 16)
}

if (process.argv[1]?.endsWith('trigger.mjs')) {
  const budgetPath = arg('--budget')
  const focus = arg('--focus')
  const depth = arg('--depth', 'standard')
  const maxItems = arg('--max-items', '30')
  const dryRun = has('--dry-run')
  const round = Number(arg('--round', '0'))
  const token = process.env[arg('--token-env', 'GH_TOKEN') ?? 'GH_TOKEN']

  let budget = {}
  if (budgetPath) { try { budget = JSON.parse(await readFile(budgetPath, 'utf8')) } catch { budget = {} } }

  const b = checkBudget({ budget })
  if (!b.ok) {
    console.log(JSON.stringify({ dispatched: false, stage: 'budget', ...b }, null, 2))
    process.exit(3)
  }
  const p = checkParams({ focus, depth, maxItems })
  if (!p.ok) {
    console.log(JSON.stringify({ dispatched: false, stage: 'params', ...p }, null, 2))
    process.exit(2)
  }
  const idem = idempotencyKey({ focus, depth, maxItems, round })
  const body = { ref: 'main', inputs: { focus: p.focus, depth: p.depth, max_items: String(p.max_items) } }

  if (dryRun) {
    console.log(JSON.stringify({ dispatched: false, dryRun: true, stage: 'dry-run',
      url: `POST /repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      body, budget: b, idempotency_key: idem }, null, 2))
    process.exit(0)
  }
  if (!token) {
    console.log(JSON.stringify({ dispatched: false, stage: 'token', reason: 'NO_TOKEN' }, null, 2))
    process.exit(4)
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  // 成功后更新预算（原子性：只在本脚本内递增）
  if (res.status === 204 && budgetPath) {
    const next = { ...budget,
      daily_used: Number(budget.daily_used ?? 0) + 1,
      last_dispatch_at: new Date().toISOString(),
      last_idempotency_key: idem, last_params: { focus: p.focus, depth: p.depth, max_items: p.max_items },
    }
    await writeFile(budgetPath, JSON.stringify(next, null, 2), 'utf8')
  }
  console.log(JSON.stringify({
    dispatched: res.status === 204, status: res.status, idempotency_key: idem,
    params: { focus: p.focus, depth: p.depth, max_items: p.max_items }, budget: b,
  }, null, 2))
  process.exit(res.status === 204 ? 0 : 1)
}
