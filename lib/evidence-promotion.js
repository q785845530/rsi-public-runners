/**
 * 证据判定晋升（Evidence-Based Promotion）—— 替代词表命中作为晋升依据。
 *
 * 为什么换掉词表：实测三轮，新素材规则的词表通过率 17% / 17% / 0%，
 * 而旧素材是 89%。越新、越贴近本问题的文献越容易被挡——因为它们用新术语，
 * 而词表沉淀的是旧术语。词表只能当粗筛，不能当晋升依据。
 *
 * 借 GRASP / SAGE / EVISKILL 的三要件：
 *   ① 可重放证据（EVISKILL）：每条规则必须绑定一次真实执行记录，能重放；
 *   ② 回归感知（GRASP）：必须证明不破坏此前正确的行为；
 *   ③ 统计判据（SAGE）：单次跑通不算，须有区间/样本量。
 *
 * 另加一条 SAGE 明确提出的：提议者与验收者必须分离（不得自签）。
 *
 * 本模块纯函数；证据由调用方注入（执行记录），不自己跑测试、不调模型。
 */
import { createHash } from 'node:crypto'
import { V } from './verdict.js'

/** 规则指纹：同一句话在同一口径下应得同一 id。 */
export function ruleFingerprint(rule) {
  return 'r_' + createHash('sha256').update(String(rule).trim().replace(/\s+/g, ' ')).digest('hex').slice(0, 12)
}

/**
 * 粗筛：词表命中只决定"是否进入候选区"，不决定晋升。
 * @returns {{inCandidate:boolean, theme:string|null, score:number}}
 */
export function coarseFilter({ rule, baseline = {} } = {}) {
  const themes = Array.isArray(baseline.themes) ? baseline.themes : []
  const text = String(rule || '').toLowerCase()
  let best = { id: null, score: 0 }
  for (const t of themes) {
    const kw = Array.isArray(t.keywords) ? t.keywords : []
    if (kw.length === 0) continue
    const hit = kw.filter((k) => text.includes(String(k).toLowerCase())).length
    const score = hit / kw.length
    if (score > best.score) best = { id: t.id, score }
  }
  // 粗筛只要求"沾边"：命中任一主题组关键词即进候选区；全不沾边也进（不因措辞挡人）
  const inCandidate = true
  return { inCandidate, theme: best.id, score: best.score, note: '词表仅作粗筛，不作晋升依据' }
}

/**
 * 证据判定：一条规则要晋升，三要件必须齐备。
 * @param {object} p
 * @param {object} p.rule      规则文本
 * @param {object} p.evidence   { replay, regression, statistics }
 *        replay      : { ran:true, runId, at, deterministic:true }  可重放的执行记录
 *        regression  : { checked:true, regressions:0, baselineRef }    回归检查结果
 *        statistics  : { samples:n, ci?:[lo,hi], lift:number }        统计判据
 * @param {object} p.gate       验收闸的独立签发（与提议者分离）
 */
export function judgeEvidencePromotion({ rule = '', evidence = {}, gate = null } = {}) {
  const missing = []
  const repl = evidence.replay || {}
  const regr = evidence.regression || {}
  const stat = evidence.statistics || {}

  if (repl.ran !== true) missing.push('replay')
  if (!repl.runId) missing.push('replay.runId')
  if (repl.deterministic !== true) missing.push('replay.deterministic')

  if (regr.checked !== true) missing.push('regression')
  if (regr.regressions !== 0) missing.push('regression.regressions')
  // 回归证据必须**绑定这条规则**：跑的是别的东西不能算它的回归检查
  if (regr.ruleRef !== undefined && regr.ruleRef !== ruleFingerprint(rule)) {
    missing.push('regression.binds_this_rule')
  }
  if (!regr.ruleRef) missing.push('regression.binds_this_rule')

  if (!Number.isFinite(stat.samples) || stat.samples < 2) missing.push('statistics.samples')
  if (!Number.isFinite(stat.lift) || stat.lift <= 0) missing.push('statistics.lift')
  // 统计证据同样必须绑定这条规则；且区间必须**不含 0**，否则"没测出差别"会被当成"有增益"
  if (stat.ruleRef !== undefined && stat.ruleRef !== ruleFingerprint(rule)) {
    missing.push('statistics.binds_this_rule')
  }
  if (!stat.ruleRef) missing.push('statistics.binds_this_rule')
  if (stat.ci !== undefined) {
    const ci = stat.ci
    if (!Array.isArray(ci) || ci.length !== 2 || !(ci[0] <= stat.lift && stat.lift <= ci[1])) {
      missing.push('statistics.ci')
    }
    // 区间跨 0 ⇒ 增益不显著 ⇒ 不得晋升（单次跑通不算数）
    if (Array.isArray(ci) && ci.length === 2 && ci[0] <= 0 && ci[1] >= 0) {
      missing.push('statistics.ci_includes_zero')
    }
  }

  // 提议者与验收者分离：gate 必须由不同于规则产出方的签发方给出
  const gateOk = gate && gate.issued === true
    && typeof gate.issuer === 'string' && gate.issuer !== ''
    && gate.issuer !== gate.proposer
    && gate.verdict === V.PASS
  if (!gateOk) missing.push('gate.independent')

  if (missing.length > 0) {
    return {
      verdict: V.NOT_EXERCISED, promote: false, missing,
      reason: 'EVIDENCE_INCOMPLETE', fingerprint: ruleFingerprint(rule),
      note: '缺证据要件：证据不齐不得晋升（词表命中也不能顶替）',
    }
  }
  return {
    verdict: V.PASS, promote: true, missing: [],
    reason: null, fingerprint: ruleFingerprint(rule),
    samples: stat.samples, lift: stat.lift, ci: stat.ci ?? null,
    issuer: gate.issuer, note: '三要件齐备且验收闸异源签发：允许晋升',
  }
}

/**
 * 批量判定，返回每条规则的结论与汇总。
 */
export function judgeBatch({ candidates = [], evidenceByRule = {}, gate = null, baseline = {} } = {}) {
  const rows = []
  for (const c of candidates) {
    const fp = ruleFingerprint(c.rule)
    const coarse = coarseFilter({ rule: c.rule, baseline })
    const ev = evidenceByRule[fp] ?? evidenceByRule[c.rule] ?? {}
    const j = judgeEvidencePromotion({ rule: c.rule, evidence: ev, gate })
    rows.push({ id: c.id ?? fp, fingerprint: fp, rule: c.rule, theme: coarse.theme,
      coarseScore: coarse.score, ...j })
  }
  const promotable = rows.filter((r) => r.promote === true)
  return {
    rows,
    promotable: promotable.length,
    blocked: rows.length - promotable.length,
    missingCounts: rows.reduce((acc, r) => {
      for (const m of r.missing) acc[m] = (acc[m] ?? 0) + 1
      return acc
    }, {}),
  }
}
