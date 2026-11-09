/**
 * 隐藏集 + 捷径率（补自《可执行方案》P2-3 与 AIDE² 的启发）。
 *
 * 为什么：选择集与评估集不分离，就会把"记住了选择集"当成"能力提升"。
 * 捷径率 = 判据被绕过（而非被满足）的比例；必须与增益同报。
 */
import { V } from './verdict.js'
import { createHash } from 'node:crypto'

/** 按 taskId 哈希分片，同一 task 永远落同一侧（可复算）。 */
export function splitHeldout({ tasks = [], ratio = 0.5, salt = 'heldout-v1' } = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  if (list.length === 0) return { verdict: V.UNVERIFIABLE, reason: 'NO_TASKS', selection: [], heldout: [] }
  const selection = []
  const heldout = []
  for (const t of list) {
    const id = String(t?.id ?? t ?? '')
    const h = createHash('sha256').update(salt + '\u0000' + id).digest()
    const v = h[0] / 255
    ;(v < ratio ? selection : heldout).push(t)
  }
  const digest = createHash('sha256')
    .update(heldout.map((t) => String(t?.id ?? t)).sort().join('|'))
    .digest('hex').slice(0, 16)
  return { verdict: V.PASS, reason: null, selection, heldout, heldoutDigest: digest }
}

/**
 * 捷径率：负控（必须失败）里"被放过"的比例。
 * @param {{negativeCases?: Array<{shouldFail?:boolean, failed?:boolean}>}} p
 */
export function shortcutRate({ negativeCases = [] } = {}) {
  const list = Array.isArray(negativeCases) ? negativeCases : []
  const total = list.length
  if (total === 0) {
    return { verdict: V.UNVERIFIABLE, reason: 'NO_NEGATIVE_CASES', rate: null,
      note: '没有负控就没有捷径率：0/0 不是 0%' }
  }
  const bypassed = list.filter((c) => c && c.shouldFail === true && c.failed !== true).length
  const rate = bypassed / total
  return {
    verdict: bypassed === 0 ? V.PASS : V.PARTIAL,
    rate, bypassed, total, reason: bypassed === 0 ? null : 'SHORTCUT_DETECTED',
    note: '捷径率必须与增益同报，否则增益可能只是绕过了判据',
  }
}
