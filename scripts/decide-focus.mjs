/**
 * RSI 侧：从 INDEX.json 识别最大知识缺口 → 选 focus（缺口类型，不是关键词）。
 *
 * 为什么不让 RSI 自由写搜索词：自由文本会退化成"反复搜同一类词、采集同质内容、
 * 把时间浪费在已知领域"。这里的自主性体现在**缺口识别与优先级排序**，
 * 而不是"自由决定搜什么"——前者可审计、可回滚。
 *
 *   node scripts/decide-focus.mjs --index <INDEX.json> [--gap-stats <json>]
 */
import { readFile } from 'node:fs/promises'

/** 缺口类型 → focus 映射（可审计、可冻结）。 */
export const GAP_TO_FOCUS = Object.freeze([
  { gap: 'invariant-unknown', threshold: 0.20, focus: 'rsi-self-verification',
    why: 'invariant=unknown 占比过高 → 需要更细的分类规则' },
  { gap: 'gate-cheat-failed', threshold: 1, focus: 'anti-cheat-verifier',
    why: '反作弊门失败 → 需要验证器设计模式' },
  { gap: 'extractor-zero', threshold: 1, focus: 'self-improving-search',
    why: '抽取器产出 0 候选 → 需要描述式主张抽取策略' },
  { gap: 'strength-flat-b', threshold: 1, focus: 'sandbox-isolation',
    why: 'evidence_strength 一律 B → 需要分级证据标准' },
])

/**
 * 从 INDEX.json 推算缺口统计。
 * 只读 lastRun 的字段；没有逐条 invariant 明细时，用 unknown 计数占位。
 */
export function statsFromIndex({ index = null, docStats = null } = {}) {
  const counts = { total: 0, unknown: 0, strengthB: 0, strengthA: 0, strengthC: 0 }
  if (docStats) {
    counts.total = docStats.total ?? 0
    counts.unknown = docStats.unknown ?? 0
    counts.strengthB = docStats.strengthB ?? 0
    counts.strengthA = docStats.strengthA ?? 0
    counts.strengthC = docStats.strengthC ?? 0
  }
  // docStats 优先（它是本轮实测统计）；index.lastRun 只作补充
  // （实测踩到：先取 lastRun 导致 docStats 的 fetched/written 全被清零，缺口判不出来）
  const lastRun = index?.lastRun ?? {}
  return {
    ...counts,
    fetched: docStats ? (docStats.fetched ?? 0) : (lastRun.fetched ?? 0),
    written: docStats ? (docStats.written ?? 0) : (lastRun.written ?? 0),
    dataSource: docStats ? (docStats.dataSource ?? 'UNKNOWN') : (lastRun.dataSource ?? 'UNKNOWN'),
    fetchErrors: docStats ? (docStats.fetchErrors ?? 0) : (lastRun.errors ?? []).length,
  }
}

/**
 * 决策：返回 {focus, depth, max_items, reason, gaps}
 * 若所有缺口都低于阈值，回退到 entropy 规则（选最久未用的 focus）。
 */
export function decideFocus({ stats = {}, usedFocus = [], entropy = false } = {}) {
  const total = Math.max(1, stats.total || 0)
  const unknownRatio = (stats.unknown || 0) / total
  const fires = []

  // 只有 total>0（有数据）时才用比例判定；total=0 是"没跑过"，不是"unknown 占比高"
  if (total > 0 && unknownRatio >= 0.20) fires.push(GAP_TO_FOCUS[0])
  // written=0 只在"确实尝试过采集"时才算出错（否则是首次运行，不该算缺口）
  const attempted = (stats.fetched ?? 0) > 0 || (stats.written ?? 0) > 0 || (stats.fetchErrors ?? 0) > 0
  if (attempted && (stats.written ?? 0) === 0) fires.push(GAP_TO_FOCUS[2])   // extractor-zero
  if ((stats.fetchErrors ?? 0) > 0) fires.push(GAP_TO_FOCUS[1])             // 采集有错

  if (fires.length > 0) {
    const pick = fires[0]
    return {
      focus: pick.focus, depth: 'standard', max_items: 30,
      reason: `GAP:${pick.gap} (${pick.why})`, gaps: fires.map((f) => f.gap), entropy: false,
    }
  }
  // 无显著缺口：走探索（选没试过的 focus），这是熵参数的作用
  const UNUSED = GAP_TO_FOCUS.map((g) => g.focus).filter((f) => !usedFocus.includes(f))
  if (entropy && UNUSED.length > 0) {
    return { focus: UNUSED[0], depth: 'shallow', max_items: 10,
      reason: `ENTROPY:explore-unused (${UNUSED[0]})`, gaps: [], entropy: true }
  }
  const last = usedFocus[0] ?? 'rsi-self-verification'
  return { focus: last, depth: 'deep', max_items: 50,
    reason: 'EXPLOIT:no-significant-gap → 深挖当前 focus', gaps: [], entropy: false }
}

const argv = process.argv.slice(2)
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
if (process.argv[1]?.endsWith('decide-focus.mjs')) {
  const indexPath = arg('--index')
  let index = null
  if (indexPath) { try { index = JSON.parse(await readFile(indexPath, 'utf8')) } catch { index = null } }
  const docStatsPath = arg('--gap-stats')
  let docStats = null
  if (docStatsPath) { try { docStats = JSON.parse(await readFile(docStatsPath, 'utf8')) } catch { docStats = null } }
  const used = (arg('--used') ?? '').split(',').filter(Boolean)
  const entropy = argv.includes('--entropy')
  const stats = statsFromIndex({ index, docStats })
  const d = decideFocus({ stats, usedFocus: used, entropy })
  console.log(JSON.stringify({ ...d, stats }, null, 2))
}
