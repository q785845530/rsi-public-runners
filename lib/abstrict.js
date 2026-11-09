/**
 * 单变量强制 + 轴级去重（补自《可执行方案》P1-3 与 §10.2 第七条）。
 *
 * 为什么：一次动多个表面，增益就拆不到任何一项头上（我们真踩过：同轮改了四件事）。
 * 轴级去重：只按条目 id 去重会把"反复出现"伪装成"持续新增"。
 */
import { V } from './verdict.js'
import { createHash } from 'node:crypto'

/**
 * 实验定义必须只有一个变量。
 * @param {{changedSurfaces?: string[]}} p
 */
export function judgeOneVariable({ changedSurfaces = [] } = {}) {
  const list = Array.isArray(changedSurfaces) ? changedSurfaces.filter((s) => typeof s === 'string' && s !== '') : []
  if (list.length === 0) {
    return { verdict: V.UNVERIFIABLE, reason: 'NO_SURFACE', note: '必须声明改了哪个表面' }
  }
  if (list.length > 1) {
    return { verdict: V.FAIL, reason: 'MULTIPLE_VARIABLES', surfaces: list,
      note: '一次只允许一个变量；多变量必须显式登记为复合变更并拒绝归因' }
  }
  return { verdict: V.PASS, reason: null, surface: list[0] }
}

/** 复合变更：允许登记，但必须标记"不可归因到单项"。 */
export function judgeCompoundChange({ surfaces = [] } = {}) {
  const list = Array.isArray(surfaces) ? surfaces.filter(Boolean) : []
  if (list.length <= 1) return judgeOneVariable({ changedSurfaces: list })
  return {
    verdict: V.PARTIAL, reason: 'COMPOUND_REGISTERED', surfaces: list, attributable: false,
    note: '复合变更可登记，但不能把合并增益记到某一项头上',
  }
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()

/** 三层去重：id → 内容哈希（白名单+版本）→ 主题轴。 */
export function judgeDedup({ items = [], hashScope = null } = {}) {
  const list = Array.isArray(items) ? items : []
  if (hashScope !== null && (hashScope.kind !== 'whitelist' || typeof hashScope.version !== 'string')) {
    return { verdict: V.FAIL, reason: 'BLACKLIST_SCOPE',
      note: '内容哈希范围必须是白名单+版本，否则新增字段会悄悄扩大范围' }
  }
  const byId = new Set()
  const byHash = new Set()
  const byAxis = new Set()
  const dupById = []
  const dupByHash = []
  const dupByAxis = []
  for (const it of list) {
    const id = String(it?.id ?? '')
    const axis = norm(it?.axis)
    const body = norm(it?.body ?? it?.text ?? '')
    const h = createHash('sha256').update(axis + '\u0000' + body).digest('hex').slice(0, 16)
    if (id !== '' && byId.has(id)) dupById.push(id)
    else if (id !== '') byId.add(id)
    if (byHash.has(h)) dupByHash.push(h)
    else byHash.add(h)
    if (axis !== '' && byAxis.has(axis)) dupByAxis.push(axis)
    else if (axis !== '') byAxis.add(axis)
  }
  return {
    verdict: dupById.length === 0 && dupByHash.length === 0 && dupByAxis.length === 0 ? V.PASS : V.PARTIAL,
    reason: null,
    uniqueById: byId.size, uniqueByHash: byHash.size, uniqueByAxis: byAxis.size,
    dupById, dupByHash, dupByAxis,
    note: '只有轴级去重能发现"同一方向换写法每天重推"',
  }
}
