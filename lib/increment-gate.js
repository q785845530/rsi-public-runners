/**
 * 信息增量闸（Information Increment Gate）。
 *
 * 为什么必须有：定时循环每 6 小时跑一次，但**没有新材料时补丁内容一字不变**——
 * 实测两轮 `writes` 哈希相同（`2b245b1fcc51`）。如果不判增量，循环会：
 *   ① 每轮产出一份"新" patch（id 掺时间，看起来在进展）；
 *   ② 每轮重跑一次 137 项影子测试；
 *   ③ 报告写着"完成一轮演化"，但信息量为零。
 *
 * 本闸的判定是：**没有新增材料 或 补丁内容未变 → SKIP（不出补丁、不跑影子）**，
 * 并且报告必须写"本轮无新增"，不许写"完成"。
 *
 * 纯函数：不读盘（调用方传入哈希）。
 */
import { createHash } from 'node:crypto'
import { V } from './verdict.js'

/** 内容哈希：对 writes 的 (path, sha256, bytes) 三元组排序后取哈希。 */
export function writesHash(writes = []) {
  const norm = (Array.isArray(writes) ? writes : [])
    .map((w) => [String(w?.path ?? ''), String(w?.sha256 ?? ''), Number(w?.bytes ?? 0)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16)
}

/** 材料指纹：文件名 + 内容哈希；用来判断"有没有新素材"。 */
export function materialsFingerprint(materials = []) {
  const norm = (Array.isArray(materials) ? materials : [])
    .map((m) => [
      String(m?.source ?? ''),
      createHash('sha256').update(String(m?.text ?? '')).digest('hex').slice(0, 12),
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16)
}

/**
 * @param {object} p
 * @param {string} p.currentWritesHash    本轮补丁 writes 的哈希
 * @param {string|null} p.previousWritesHash 上一轮补丁 writes 的哈希（首轮为 null）
 * @param {string} p.currentMaterialsFp   本轮材料指纹
 * @param {string|null} p.previousMaterialsFp 上一轮材料指纹
 */
export function judgeIncrement({
  currentWritesHash = '', previousWritesHash = null,
  currentMaterialsFp = '', previousMaterialsFp = null,
} = {}) {
  if (typeof currentWritesHash !== 'string' || currentWritesHash === '') {
    return { verdict: V.UNVERIFIABLE, decision: 'NEEDS_EVIDENCE', reason: 'NO_WRITES_HASH' }
  }
  const materialUnchanged = previousMaterialsFp !== null && currentMaterialsFp === previousMaterialsFp
  const contentUnchanged = previousWritesHash !== null && currentWritesHash === previousWritesHash

  if (previousWritesHash === null) {
    return {
      verdict: V.PASS, decision: 'PROCEED', reason: null,
      materialUnchanged, contentUnchanged: false, firstRound: true,
    }
  }
  if (contentUnchanged) {
    return {
      verdict: V.NOT_EXERCISED, decision: 'SKIP', reason: 'NO_NEW_CONTENT',
      materialUnchanged, contentUnchanged: true, currentWritesHash,
      note: materialUnchanged
        ? '材料未变且补丁内容未变：不出补丁、不跑影子；报告写"无新增"'
        : '材料变了但补丁内容未变：同样跳过（说明新材料没有产生新规则）',
    }
  }
  return {
    verdict: V.PASS, decision: 'PROCEED', reason: null,
    materialUnchanged, contentUnchanged: false,
  }
}

/** 把判定渲染成一句人话（报告与日志共用）。 */
export function renderIncrement(r) {
  if (!r) return '未判定'
  if (r.decision === 'SKIP') return `SKIP（${r.reason}）：本轮无新增，未产出补丁、未跑影子`
  if (r.firstRound === true) return 'PROCEED（首轮：没有历史可比）'
  return 'PROCEED（有增量）'
}
