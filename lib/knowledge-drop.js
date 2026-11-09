/**
 * 知识投递闸门（knowledge_drop intake）—— 采集层与自改进层之间的唯一接口。
 *
 * 为什么需要：采集层（GitHub Actions）只"采"，沙盒只"读"。若把采集文档直接塞进
 * 提案流程，恶意/低质资料就能影响"提案什么"甚至"是否通过"。所以这里做三件事：
 *   ① 结构校验：固定字段齐全才收（缺字段 → QUARANTINE，不是"尽力解析"）；
 *   ② 投毒筛查：命中注入/越权模式的文档 → QUARANTINE（隔离，不进提案）；
 *   ③ 只读语义：通过的文档只影响"提案什么"，**不参与"是否通过"**——后者由
 *      密封验证闸独立判断，看不到知识来源的"权威性标签"。
 *
 * 本模块纯函数：不读盘、不联网、不调模型。读盘由调用方（脚本）完成。
 */
import { createHash } from 'node:crypto'
import { V } from './verdict.js'
import { PROCESS_INVARIANTS } from './process-negative-control.js'

/** 知识文档的固定字段（缺一不可）。 */
export const REQUIRED_FIELDS = Object.freeze([
  'title', 'source', 'url', 'retrieved_at', 'core_claim', 'mechanism',
  'evidence_strength', 'potential_implication_for_rsi',
])

/** 证据强度闭集。 */
export const EVIDENCE_STRENGTH = Object.freeze(['A', 'B', 'C'])

/** 投毒/越权模式：命中即隔离（不进提案）。 */
export const POISON_PATTERNS = Object.freeze([
  { id: 'inject-ignore', re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?)/i },
  { id: 'inject-role', re: /you\s+are\s+(now\s+)?(a\s+)?(different|new)\s+(agent|assistant)/i },
  { id: 'inject-system', re: /(^|\n)\s*system\s*:\s*/i },
  { id: 'privilege-escalation', re: /(提升|授予|grant).{0,12}(权限|privilege)|sudo\s|chmod\s+777/i },
  { id: 'prompt-leak', re: /(泄露|输出|print).{0,10}(系统提示|system\s*prompt)/i },
  { id: 'bypass-verifier', re: /(跳过|绕过|bypass|skip).{0,12}(验证器|verifier|验收|gate)/i },
  // 公共库里不出现任何具体产品名/内部路径：改为通用"写到受保护位置"模式
  { id: 'write-outside', re: /(写到|写入|write).{0,12}(受保护|只读|protected|read-only)/i },
])

/** 解析固定字段（`key: value` 行首）。 */
export function parseFields({ text = '' } = {}) {
  const out = {}
  const lines = String(text).split('\n')
  let current = null
  for (const line of lines) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/)
    if (m) { current = m[1]; out[current] = m[2]; continue }
    if (current && line.trim() !== '' && !line.startsWith('#')) {
      out[current] = (out[current] ? out[current] + '\n' : '') + line
    }
  }
  return out
}

/** 文档指纹：来源 + 规范化正文。 */
export function docFingerprint({ source = '', coreClaim = '' } = {}) {
  return 'kd_' + createHash('sha256')
    .update(String(source).trim() + '\u0000' + String(coreClaim).trim().replace(/\s+/g, ' '))
    .digest('hex').slice(0, 16)
}

/**
 * 单文档闸门判定。
 * @returns {{verdict, accepted, reason, attacks:string[], missing:string[], fingerprint}}
 */
export function judgeKnowledgeDoc({ text = '', knownIds = null } = {}) {
  const body = String(text)
  const fields = parseFields({ text: body })
  const missing = REQUIRED_FIELDS.filter((k) => !fields[k] || String(fields[k]).trim() === '')
  const attacks = POISON_PATTERNS.filter((p) => p.re.test(body)).map((p) => p.id)

  const ids = knownIds ?? Object.keys(PROCESS_INVARIANTS)
  const tag = (body.match(/^invariant:\s*([a-z0-9-]+)\s*$/mi) || [])[1] ?? null

  const fingerprint = docFingerprint({ source: fields.source ?? '', coreClaim: fields.core_claim ?? '' })

  // ① 投毒优先：命中即隔离，且**不因为字段齐全就放过**
  if (attacks.length > 0) {
    return { verdict: V.FAIL, accepted: false, quarantine: true, reason: 'POISONED_INPUT',
      attacks, missing, fingerprint, tag,
      note: '命中投毒模式 → 隔离；知识只影响提案内容，绝不参与是否通过' }
  }
  // ② 结构：缺字段即隔离（不"尽力解析"）
  if (missing.length > 0) {
    return { verdict: V.FAIL, accepted: false, quarantine: true, reason: 'SCHEMA_INCOMPLETE',
      attacks: [], missing, fingerprint, tag,
      note: '固定字段不全 → 隔离；不做模糊解析，避免自由文本理解' }
  }
  // ③ 证据强度必须是闭集
  if (!EVIDENCE_STRENGTH.includes(String(fields.evidence_strength).trim())) {
    return { verdict: V.FAIL, accepted: false, quarantine: true, reason: 'BAD_EVIDENCE_STRENGTH',
      attacks: [], missing: [], fingerprint, tag, got: fields.evidence_strength }
  }
  // ④ invariant 必须存在且已知（未知 id 不退回词法，否则掩盖错误）
  if (!tag) {
    return { verdict: V.FAIL, accepted: false, quarantine: true, reason: 'NO_INVARIANT_TAG',
      attacks: [], missing: [], fingerprint, tag: null,
      note: '缺 invariant 标注 → 隔离（不猜归属）' }
  }
  if (!ids.includes(tag)) {
    return { verdict: V.FAIL, accepted: false, quarantine: true, reason: 'UNKNOWN_INVARIANT',
      attacks: [], missing: [], fingerprint, tag, knownIds: ids.slice(0, 5) }
  }
  return {
    verdict: V.PASS, accepted: true, quarantine: false, reason: null,
    attacks: [], missing: [], fingerprint, tag,
    fields,
    note: '通过：仅作为提案来源，验收仍由密封闸独立判断',
  }
}

/**
 * 批量投递：去重（指纹）+ 逐条判定 + 汇总。
 * @param {Array<{name:string,text:string}>} docs
 */
export function intakeKnowledgeDrop({ docs = [], knownIds = null } = {}) {
  const list = Array.isArray(docs) ? docs : []
  const seen = new Map()
  const accepted = []
  const quarantined = []
  const duplicates = []
  for (const d of list) {
    const r = judgeKnowledgeDoc({ text: d.text ?? '', knownIds })
    // 先判隔离再判重复：否则"投毒但指纹与合规文档相同"会被当成重复跳过，
    // 隔离事件被静默吃掉（实测踩到：posion 文档被计入 duplicates）。
    if (!r.accepted) {
      quarantined.push({ name: d.name, ...r })
      continue
    }
    if (seen.has(r.fingerprint)) {
      duplicates.push({ name: d.name, fingerprint: r.fingerprint, firstSeen: seen.get(r.fingerprint) })
      continue
    }
    seen.set(r.fingerprint, d.name)
    accepted.push({ name: d.name, ...r })
  }
  return {
    verdict: quarantined.length === 0 ? V.PASS : V.PARTIAL,
    total: list.length,
    accepted: accepted.length,
    quarantined: quarantined.length,
    duplicates: duplicates.length,
    acceptedDocs: accepted,
    quarantinedDocs: quarantined,
    duplicateDocs: duplicates,
    note: '验收闸看不到本函数的输出：知识只决定"提案什么"，不决定"是否通过"',
  }
}
