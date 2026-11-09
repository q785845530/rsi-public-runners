/**
 * 流程规则 → 不变式类别的映射表。
 *
 * 为什么单独成文件：映射是**词法**的（正则命中关键词），它决定"这条流程规则归到
 * 哪条不变式去验"，**不是**晋升判据本身。晋升仍由 process-negative-control.js
 * 的负控决定（那条不变式必须能判红）。
 *
 * 诚实边界：词法映射会漏同义改写——这与词表晋升的盲区同类。
 * 所以映射失败时**不晋升**，只记为 unmapped 并计数，绝不猜。
 */
import { PROCESS_INVARIANTS } from './process-negative-control.js'

/** 映射规则（顺序敏感：先具体后宽泛）。 */
export const RULE_MAPPING = Object.freeze([
  { kind: 'independent-signer', patterns: [/三方分离/, /分离靠权限隔离/, /同一签发方/, /独立签发/, /异源签发/, /签发方.*分离/, /验收方.*执行方/] },
  { kind: 'dual-completion-marker', patterns: [/双重完成标记/, /attempt_start/, /attempt_done/, /尝试记录/, /意图.*落地/, /开始时间.*终态/] },
  { kind: 'statistical-gate', patterns: [/统计判据/, /显著性/, /区间/, /单次跑通/, /样本量/, /统计验收/] },
  { kind: 'rejection-record', patterns: [/拒绝.*记录/, /理由码/, /静默丢弃/] },
  { kind: 'paired-comparison', patterns: [/配对比较/, /带与不带/, /带与不带的/, /同一任务.*比较/] },
  { kind: 'claim-vs-fact', patterns: [/视为主张而非事实/, /只是主张/, /主张而非事实/] },
  { kind: 'evidence-freshness', patterns: [/证据必须.*有效/, /过期证据/, /证据.*判定时刻/] },
  { kind: 'deterministic-decision', patterns: [/判定必须确定性/, /不得.*决定权/, /被验方自评/, /不得.*被验方/] },
  { kind: 'effect-path-record', patterns: [/效果路径/, /旁边另发/, /effect path/i] },
  { kind: 'unified-ledger', patterns: [/同一份账/, /可离线校验/, /持久化到.*账/, /提案.*裁决/] },
  { kind: 'mandatory-slots', patterns: [/强制槽位/, /终止判定必须携带证据/, /没有更多动作/] },
  { kind: 'bidirectional-correctness', patterns: [/双向成立/, /证据齐备/, /证据不齐/] },
  { kind: 'budget-evidence', patterns: [/预算证据/, /耗时.*预算/, /预算.*记录/] },
  { kind: 'proposer-gate-separation', patterns: [/提议者.*验收闸/, /既提议又验收/, /提议与验收/] },
  { kind: 'regression-check-before-promotion', patterns: [/不破坏此前已正确/, /回归未检查/, /证明.*不破坏/] },
  { kind: 'replayable-evidence', patterns: [/可重放的证据/, /可重放证据/, /改了什么.*依据/] },
  { kind: 'periodic-reaudit', patterns: [/定期.*重审/, /只有累积没有复查/, /重审旧技能/, /仍成立.*已失效/, /是否仍成立/, /只追加不判定/] },
  { kind: 'budget-bound-exploration', patterns: [/交互预算/, /超预算/, /预算内进行/] },
  { kind: 'candidate-zone-boundary', patterns: [/只允许留在候选区/, /标记为已采纳/, /无法验证.*候选/] },
  { kind: 'batch-atomic-signing', patterns: [/计划数相等/, /整批签/, /不得边做边签/] },
  { kind: 'information-increment', patterns: [/是否带来新信息/, /轮次增加不等于进展/, /新信息/] },
  { kind: 'content-addressed-identity', patterns: [/内容哈希决定/, /时间.*混入/, /标识.*内容哈希/] },
  { kind: 'export-digest', patterns: [/每个文件的摘要/, /摘要.*搬运/, /导出.*摘要/] },
])

/**
 * 从材料文本里读结构化标注：`invariant: <id>`。
 *
 * 为什么优先读标注而不是走正则：正则映射会追着措辞跑（上轮实测 28/28 是因为材料就那 13 份，
 * 换一批措辞不同的材料大概率仍漏）。材料自带 id 后，映射从"猜"变成"读"。
 */
export function parseInvariantTag({ text = '' } = {}) {
  const m = String(text).match(/^\s*invariant:\s*([a-z0-9-]+)\s*$/mi)
  return m ? m[1] : null
}

/**
 * 把一条规则映射到不变式类别。
 *
 * 优先级：① 材料里的 `invariant:` 标注（结构化，可信）；
 *          ② 正则映射（兜底，词法）。
 * 两者都拿不到 → 返回 null（不猜）。
 */
export function mapRuleToInvariant({ rule = '', tag = null } = {}) {
  if (tag && Object.prototype.hasOwnProperty.call(PROCESS_INVARIANTS, tag)) return tag
  if (tag && !Object.prototype.hasOwnProperty.call(PROCESS_INVARIANTS, tag)) {
    return null // 标注了未知 id：不可用，不退回正则（否则会掩盖标注错误）
  }
  const text = String(rule)
  for (const m of RULE_MAPPING) {
    if (m.patterns.some((re) => re.test(text))) return m.kind
  }
  return null
}

/** 批量映射并统计覆盖率。 */
export function mapRules({ rules = [] } = {}) {
  const list = Array.isArray(rules) ? rules : []
  const rows = []
  for (const r of list) {
    const rule = typeof r === 'string' ? r : r.rule
    const tag = typeof r === 'string' ? null : (r.tag ?? null)
    const kind = mapRuleToInvariant({ rule, tag })
    rows.push({ rule, tag, kind, mapped: kind !== null, via: tag ? 'tag' : (kind ? 'regex' : null) })
  }
  return {
    rows,
    mapped: rows.filter((r) => r.mapped).length,
    unmapped: rows.filter((r) => !r.mapped).length,
    unmappedRules: rows.filter((r) => !r.mapped).map((r) => r.rule),
    viaTag: rows.filter((r) => r.via === 'tag').length,
    viaRegex: rows.filter((r) => r.via === 'regex').length,
    availableKinds: Object.keys(PROCESS_INVARIANTS),
  }
}
