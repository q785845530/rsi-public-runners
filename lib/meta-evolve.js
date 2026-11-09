/**
 * 元层进演化池（补自《可执行方案》P2-2 与 Skill∞）。
 *
 * 为什么：元诊断程序是固定的，不可被改写 → 永远到不了 E3。
 * 但改写元层最容易"越改越飘"，所以必须双证据：元层前后对比 + 任务层不回归。
 */
import { V } from './verdict.js'

/**
 * @param {object} p
 * @param {boolean} p.metaChanged       元层（改进程序本身）是否被改写
 * @param {boolean} p.metaBeforeAfter   是否给出元层前后对比证据
 * @param {boolean} p.taskNoRegression  任务层是否无回归
 * @param {boolean} p.evidenceGatePass  是否通过六指标证据门
 */
export function judgeMetaEvolution({ metaChanged = false, metaBeforeAfter = false, taskNoRegression = false, evidenceGatePass = false } = {}) {
  if (metaChanged !== true) {
    return { verdict: V.PASS, reason: null, level: 'E2', note: '没有改元层：最高仍是 E2' }
  }
  const missing = []
  if (metaBeforeAfter !== true) missing.push('metaBeforeAfter')
  if (taskNoRegression !== true) missing.push('taskNoRegression')
  if (evidenceGatePass !== true) missing.push('evidenceGatePass')
  if (missing.length > 0) {
    return {
      verdict: V.UNVERIFIABLE, reason: 'META_EVIDENCE_INCOMPLETE', missing,
      decision: 'ARCHIVE', level: 'E2',
      note: '元层改动缺证据 → 只能归档，不得晋升（也到不了 E3）',
    }
  }
  return {
    verdict: V.PASS, reason: null, decision: 'PROMOTE', level: 'E3',
    note: '元层改写 + 双证据齐备 → 可称 E3（仍不等于 E4）',
  }
}
