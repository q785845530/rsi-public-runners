/**
 * E1–E4 主张阶梯（补自《可执行方案》P0-2，此前完全缺失）。
 *
 * 为什么必须有：我们说过"让 Agent 越用越强"，但按阶梯一量，长期停在 E1–E2。
 * 没有分级词表，这句话迟早被说成 E4。级别必须**由证据推导**，不能手填。
 */
import { V } from './verdict.js'

export const LEVELS = Object.freeze({ E1: 'E1', E2: 'E2', E3: 'E3', E4: 'E4' })

const REQUIRE = {
  E1: ['reflectionRecord'],
  E2: ['reflectionRecord', 'persistentChange', 'pairedComparison'],
  E3: ['reflectionRecord', 'persistentChange', 'pairedComparison', 'metaLayerChanged', 'metaEvidence'],
  E4: ['reflectionRecord', 'persistentChange', 'pairedComparison', 'metaLayerChanged', 'metaEvidence',
    'hiddenSet', 'retention', 'safety'],
}

/**
 * 由证据推导级别：从 E4 往下试，第一个满足全部必需证据的就是上限。
 * @returns {{verdict:string, level:string|null, claimed:string|null, downgraded:boolean, missing:string[]}}
 */
export function deriveLevel({ evidence = {}, claimed = null } = {}) {
  const missing = []
  let derived = null
  for (const level of ['E4', 'E3', 'E2', 'E1']) {
    const need = REQUIRE[level]
    const lack = need.filter((k) => evidence[k] !== true)
    if (lack.length === 0) { derived = level; break }
    if (level === 'E1') missing.push(...lack)
  }
  const claimValid = claimed === null || claimed === derived
  if (claimed !== null && !claimValid) {
    return {
      verdict: V.FAIL, level: derived, claimed, downgraded: true,
      reason: 'CLAIM_DOWNGRADED', missing,
      note: `手填 ${claimed} 但证据只支撑 ${derived ?? '无'}：级别必须由证据推导`,
    }
  }
  if (derived === null) {
    return { verdict: V.UNVERIFIABLE, level: null, claimed, downgraded: false, reason: 'NO_EVIDENCE', missing }
  }
  return { verdict: V.PASS, level: derived, claimed, downgraded: false, reason: null, missing: [] }
}

/** 对外表述必须带级别；不带就拒。 */
export function labelWithLevel({ text = '', level = null } = {}) {
  const s = String(text || '')
  if (!/RSI|自我改进|越用越强/.test(s)) return { verdict: V.PASS, required: false, text: s }
  if (!Object.values(LEVELS).includes(level)) {
    return { verdict: V.FAIL, required: true, reason: 'MISSING_LEVEL', text: s,
      note: '出现 RSI/自我改进 字样必须带 E1–E4 级别' }
  }
  return { verdict: V.PASS, required: true, level, text: `${s}（${level}）` }
}
