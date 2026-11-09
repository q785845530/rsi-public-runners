/**
 * 证据门控六指标 + 五档决策（补自《可执行方案》P1-1 与调研文档第 6 节）。
 *
 * 六指标：capability / safety / retention / ood / cost_per_gain / verifier_disagreement。
 * 五档：PROMOTE / ARCHIVE / REJECT / QUARANTINE / NEEDS_EVIDENCE。
 *
 * 两条硬约束：缺证据必须 NEEDS_EVIDENCE（等待），不得 PROMOTE；safety 不可补偿。
 */
import { V } from './verdict.js'

export const METRICS = Object.freeze([
  'capability', 'safety', 'retention', 'ood', 'cost_per_gain', 'verifier_disagreement',
])

export const DECISIONS = Object.freeze({
  PROMOTE: 'PROMOTE', ARCHIVE: 'ARCHIVE', REJECT: 'REJECT',
  QUARANTINE: 'QUARANTINE', NEEDS_EVIDENCE: 'NEEDS_EVIDENCE',
})

/** 指标值约定：0..1 的数值，或 null 表示"没测"。 */
function norm(v) {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null
}

/**
 * @param {object} p
 * @param {object} p.metrics 六指标（缺项=null）
 * @param {object} p.thresholds 可选阈值，默认 safety>=1 且其余>=0.5
 * @param {boolean} p.safetyFailed 安全事件（不可补偿）
 * @param {boolean} p.operationalRegression 运行性回归（如旧能力静默消失）
 */
export function judgeEvidence({ metrics = {}, thresholds = {}, safetyFailed = false, operationalRegression = false } = {}) {
  const m = {}
  for (const k of METRICS) m[k] = norm(metrics[k])
  const missing = METRICS.filter((k) => m[k] === null)

  const t = {
    capability: thresholds.capability ?? 0.5,
    safety: thresholds.safety ?? 1,
    retention: thresholds.retention ?? 0.5,
    ood: thresholds.ood ?? 0.5,
    cost_per_gain: thresholds.cost_per_gain ?? 0.5,
    verifier_disagreement: thresholds.verifier_disagreement ?? 0.5,
  }

  // 1) 安全：不可补偿，直接隔离
  if (safetyFailed === true || (m.safety !== null && m.safety < t.safety)) {
    return { verdict: V.FAIL, decision: DECISIONS.QUARANTINE, metrics: m, missing,
      reason: 'SAFETY_VIOLATION', note: '安全项不可被 capability 抵消' }
  }
  // 2) 完整性/运行性回归 → 拒
  if (operationalRegression === true) {
    return { verdict: V.FAIL, decision: DECISIONS.REJECT, metrics: m, missing, reason: 'OPERATIONAL_REGRESSION' }
  }
  // 3) 证据不全 → 等待（绝不 PROMOTE）
  if (missing.length > 0) {
    return { verdict: V.NOT_EXERCISED, decision: DECISIONS.NEEDS_EVIDENCE, metrics: m, missing,
      reason: 'NEEDS_EVIDENCE', note: '缺证据必须等，不得落 PROMOTE' }
  }
  // 4) 能力达标但某项未过阈值 → 归档（安全但证据不足）
  const short = METRICS.filter((k) => m[k] < t[k])
  if (short.length > 0) {
    return { verdict: V.PARTIAL, decision: DECISIONS.ARCHIVE, metrics: m, missing: [], short, reason: 'BELOW_THRESHOLD' }
  }
  return { verdict: V.PASS, decision: DECISIONS.PROMOTE, metrics: m, missing: [], reason: null }
}

/**
 * Live Probe 采纳（补自调研文档第 6 节"采纳不以真跑同一请求为条件"）。
 * 采纳必须同时满足：候选与基线在同一请求上真跑过、且候选通过。
 */
export function judgeAdoption({ probe = null } = {}) {
  const p = probe || {}
  if (p.ranSameRequest !== true) {
    return { verdict: V.NOT_EXERCISED, adopt: false, reason: 'NO_LIVE_PROBE',
      note: '没在同一请求上真跑过，不得采纳' }
  }
  if (p.candidatePassed !== true) return { verdict: V.FAIL, adopt: false, reason: 'CANDIDATE_FAILED' }
  if (p.baselinePassed === true) {
    return { verdict: V.PARTIAL, adopt: false, reason: 'NO_GAIN',
      note: '基线本来就通过：这次采纳证明不了增益' }
  }
  return { verdict: V.PASS, adopt: true, reason: null }
}
