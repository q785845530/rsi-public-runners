/**
 * 配对试验（Paired Trial）—— 补 SkillsBench / ACES 指出的最大缺口。
 *
 * 为什么必须配对：只看"装上技能后能过几道"，分不清是技能起效还是任务本来就简单。
 * 必须**同一批任务跑两遍**（不带技能 / 带技能），同求解器、同评分规则，然后同时看两个方向：
 *   ① lift（增益）：不带时失败、带时通过的任务数；
 *   ② regressions（回归）：不带时通过、带时失败的任务数 —— 这一项最容易被漏。
 *
 * 判据：只有 lift>0 **且** regressions==0 **且** 任务集有区分度 才允许晋升；
 * 有任何回归 → REJECT；任务在两个条件下表现完全相同 → NEEDS_EVIDENCE（没有区分度）。
 *
 * 本模块纯函数：求解器由调用方注入（确定性求解器或模型皆可），模块自身不调模型、不联网。
 */
import { V } from './verdict.js'

/**
 * @param {object} p
 * @param {Array<{id:string, expect:string, input?:any}>} p.tasks  任务集（含期望答案）
 * @param {Array<object>} p.skills   被测技能（可多，用于叠加测试）
 * @param {(task:object, ctx:{skills:Array<object>}) => string} p.solve  求解器
 * @param {number} p.minTasks  最少任务数（默认 6）
 */
export function runPairedTrial({ tasks = [], skills = [], solve, minTasks = 6 } = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  if (typeof solve !== 'function') {
    return { verdict: V.UNVERIFIABLE, reason: 'NO_SOLVER', ok: false }
  }
  if (list.length < minTasks) {
    return { verdict: V.NOT_EXERCISED, reason: 'TASK_SET_TOO_SMALL', ok: false, tasks: list.length, minTasks }
  }

  const rows = []
  let passWithout = 0
  let passWith = 0
  const gained = []
  const regressed = []

  for (const t of list) {
    let a, b
    try { a = solve(t, { skills: [] }) } catch { a = '__ERROR__' }
    try { b = solve(t, { skills }) } catch { b = '__ERROR__' }
    const okA = a === t.expect
    const okB = b === t.expect
    if (okA) passWithout += 1
    if (okB) passWith += 1
    if (!okA && okB) gained.push(t.id)
    if (okA && !okB) regressed.push(t.id)
    rows.push({ id: t.id, without: okA, with: okB, expect: t.expect, got: { without: a, with: b } })
  }

  const n = list.length
  const rateWithout = passWithout / n
  const rateWith = passWith / n
  const lift = rateWith - rateWithout

  // 区分度：两种条件下通过情况完全一致 → 这批任务测不出技能作用
  const discriminating = rows.some((r) => r.without !== r.with)

  if (!discriminating) {
    return {
      verdict: V.NEEDS_EVIDENCE ?? V.UNVERIFIABLE, ok: false, reason: 'NO_DISCRIMINATING_TASK',
      lift, regressions: regressed.length, rows, note: '任务在两个条件下表现完全相同：测不出技能作用',
    }
  }
  if (regressed.length > 0) {
    return {
      verdict: V.FAIL, ok: false, decision: 'REJECT', reason: 'REGRESSION',
      lift, regressions: regressed.length, regressed, rows,
      note: '装上技能后原本通过的任务变红：技能有害或过窄',
    }
  }
  if (lift <= 0) {
    return {
      verdict: V.NOT_EXERCISED, ok: false, decision: 'REJECT', reason: 'NO_LIFT',
      lift, regressions: 0, rows, note: '没有增益：技能不携带可用信息',
    }
  }
  return {
    verdict: V.PASS, ok: true, decision: 'ELIGIBLE',
    lift, rateWithout, rateWith, gained: gained.length, regressions: 0, rows,
    note: `配对试验通过：+${Math.round(lift * 100)}pp（${passWithout}/${n} → ${passWith}/${n}），零回归`,
  }
}

/** 把多技能叠加做多档对比（对齐 SkillsBench"聚焦技能优于大包"的结论）。 */
export function trialStack({ tasks = [], skills = [], solve, stacks = [1, 3, 8], minTasks = 6 } = {}) {
  const out = []
  for (const k of stacks) {
    const subset = skills.slice(0, Math.min(k, skills.length))
    const r = runPairedTrial({ tasks, skills: subset, solve, minTasks })
    out.push({ k, n: subset.length, verdict: r.verdict, lift: r.lift ?? null, regressions: r.regressions ?? null })
  }
  const best = out.filter((x) => x.verdict === V.PASS).sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0))[0] ?? null
  return {
    stacks: out,
    bestK: best?.k ?? null,
    note: best ? `最佳叠加档位 k=${best.k}（lift ${best.lift}）` : '没有任何档位通过：不加技能',
  }
}
