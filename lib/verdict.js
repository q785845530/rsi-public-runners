/**
 * 判定闭集与签发层（Judgment Closure & Signing Layers）。
 *
 * 为什么要有这一层：插件原来的判定散在 verifier/deliver/evaluation 三处，各自成立，
 * 合起来漏掉同一类状态 —— **「看起来通过了」与「其实没跑 / 没签 / 验不了」结构同形**。
 * 2026-11-06 的心跳事故就是这一格：批处理参数错位，退出码 0、循环跑完、六条动作一条没发生，
 * 而回执写的是「已完成」。不是判据写松，是「没做」在枚举里没有位置。
 *
 * 红线（与 §31.12 一致）：
 *   1. 纯函数、无 IO、无时钟 —— 时间由调用方传入，任何结论可复算；
 *   2. 枚举封闭 —— 不许调用方塞自定义字符串；
 *   3. 每个降级必须带闭集 reason；
 *   4. 不许任何路径把 UNKNOWN / NOT_EXERCISED 自动变成 PASS。
 */

/** 判定闭集。值稳定：prompt、测试与其他模块都引用它。 */
export const V = Object.freeze({
  PASS: 'PASS',
  PARTIAL: 'PARTIAL',
  FAIL: 'FAIL',
  NOT_EXERCISED: 'NOT_EXERCISED',
  UNSIGNED: 'UNSIGNED',
  UNVERIFIABLE: 'UNVERIFIABLE',
  UNKNOWN: 'UNKNOWN',
  FLIP: 'FLIP',
})

/** 拒因闭集。降级必须从这里取，避免各模块自造文案。 */
export const REASONS = Object.freeze({
  NO_OBJECT_ID: 'NO_OBJECT_ID',
  AMBIGUOUS_OBJECT_ID: 'AMBIGUOUS_OBJECT_ID',
  COUNT_MISMATCH: 'COUNT_MISMATCH',
  NOT_ATTEMPTED: 'NOT_ATTEMPTED',
  SELF_SIGNED: 'SELF_SIGNED',
  MISSING_ANCHOR: 'MISSING_ANCHOR',
  CLOCK_NOT_INDEPENDENT: 'CLOCK_NOT_INDEPENDENT',
  PROTOCOL_NO_INTEGRITY_FIELD: 'PROTOCOL_NO_INTEGRITY_FIELD',
  SCOPE_UNDECLARED: 'SCOPE_UNDECLARED',
  BLACKLIST_SCOPE: 'BLACKLIST_SCOPE',
  INTEGRITY_MISMATCH: 'INTEGRITY_MISMATCH',
  VERSION_FIELD_MISSING: 'VERSION_FIELD_MISSING',
  ONE_VERSION_SOURCE: 'ONE_VERSION_SOURCE',
  CRITERIA_DRIFT: 'CRITERIA_DRIFT',
  SNAPSHOT_INCOMPLETE: 'SNAPSHOT_INCOMPLETE',
  VOID_AS_STRING: 'VOID_AS_STRING',
  FIELD_ABSENT: 'FIELD_ABSENT',
  DECLARATION_MISSING: 'DECLARATION_MISSING',
  UNDER_DECLARED: 'UNDER_DECLARED',
  OBSERVABILITY_GAP: 'OBSERVABILITY_GAP',
  NO_DENOMINATOR: 'NO_DENOMINATOR',
  READ_FAILED: 'READ_FAILED',
  NOT_COMPARABLE: 'NOT_COMPARABLE',
  EQUIVALENT_REWRITE: 'EQUIVALENT_REWRITE',
  INSENSITIVE_BY_CONSTRUCTION: 'INSENSITIVE_BY_CONSTRUCTION',
})

const REASON_SET = new Set(Object.values(REASONS))
const VERDICT_SET = new Set(Object.values(V))

/** 最坏优先排序：数字越小越坏。理由见 CONTRACT §31.2。 */
const SEVERITY = Object.freeze({
  [V.FAIL]: 0,
  [V.FLIP]: 1,
  [V.NOT_EXERCISED]: 2,
  [V.UNSIGNED]: 3,
  [V.UNVERIFIABLE]: 4,
  [V.PARTIAL]: 5,
  [V.UNKNOWN]: 6,
  [V.PASS]: 7,
})

/** 只有这个值允许被当作「已完成」对外说。 */
export const COMPLETABLE = new Set([V.PASS])

const OBJECT_ID_KEYS = Object.freeze([
  'msg_id', 'item_id', 'attention_id', 'conv_id', 'commit',
  'sha256', 'digest', 'object_id', 'run_id', 'receipt_id',
])

const isStr = (x) => typeof x === 'string' && x.trim() !== ''
const isNum = (x) => typeof x === 'number' && Number.isFinite(x)

/** 严重度（越小越坏）。给需要「取最坏那一层的理由」的调用方用。 */
export function severityOf(v) {
  return Number.isFinite(SEVERITY[v]) ? SEVERITY[v] : SEVERITY[V.UNKNOWN]
}

function normReason(reason, fallback = REASONS.INSENSITIVE_BY_CONSTRUCTION) {
  return REASON_SET.has(reason) ? reason : fallback
}

function normVerdict(v) {
  return VERDICT_SET.has(v) ? v : V.UNKNOWN
}

/**
 * 聚合法：一组判定取最坏的那个。用于「一个周期由多个阶段组成」的场合。
 * 空数组不是 PASS —— 没有证据不等于通过。
 */
export function worst(verdicts) {
  const list = Array.isArray(verdicts) ? verdicts.filter((v) => VERDICT_SET.has(v)) : []
  if (list.length === 0) return V.UNKNOWN
  let best = list[0]
  for (const v of list) if (SEVERITY[v] < SEVERITY[best]) best = v
  return best
}

/** 给调用方用：这一组里有没有不可完结的格子（非 PASS）。 */
export function blocking(verdicts) {
  const list = Array.isArray(verdicts) ? verdicts : []
  return list.filter((v) => COMPLETABLE.has(normVerdict(v)) === false)
}

/**
 * 从动作返回值里取对象标识。
 * 只有「真实对象 id」才算数：布尔 status、退出码、自由文本都不算。
 * 同值歧义（msg_id === conv_id）单独标出 —— 同值无法区分「消息存在」与「会话存在」。
 */
export function extractObjectId(actionResult) {
  if (!actionResult || typeof actionResult !== 'object') {
    return { objectId: null, key: null, ambiguous: [], keysFound: [] }
  }
  const keysFound = []
  for (const k of OBJECT_ID_KEYS) {
    const v = actionResult[k]
    if (isStr(v) || (isNum(v) && v > 0)) keysFound.push([k, String(v)])
  }
  // 同值检测：多个键给出同一个字符串，且这些键属于「语义本应不同」的一族
  const byValue = new Map()
  for (const [k, v] of keysFound) {
    if (!byValue.has(v)) byValue.set(v, [])
    byValue.get(v).push(k)
  }
  const ambiguous = []
  for (const [v, ks] of byValue) {
    if (ks.length > 1 && ks.includes('msg_id') && ks.includes('conv_id')) ambiguous.push({ value: v, keys: ks })
  }
  if (ambiguous.length > 0) {
    const first = keysFound[0]
    return { objectId: first ? first[1] : null, key: first ? first[0] : null, ambiguous, keysFound }
  }
  if (keysFound.length === 0) return { objectId: null, key: null, ambiguous: [], keysFound }
  const first = keysFound[0]
  return { objectId: first[1], key: first[0], ambiguous: [], keysFound }
}

/**
 * 回执判定：把「已完成」绑到对象标识与计数上。
 *   - 没有对象标识 → UNVERIFIABLE/NO_OBJECT_ID（不猜、不补）
 *   - 同值歧义 → UNSIGNED/AMBIGUOUS_OBJECT_ID
 *   - succeeded === planned → PASS；0<成功<计划 → PARTIAL；计划>0 成功=0 → FAIL
 */
export function judgeReceipt({ actionResult, claim = null, planned = null, succeeded = null } = {}) {
  const { objectId, key, ambiguous } = extractObjectId(actionResult)

  if (ambiguous.length > 0) {
    return {
      verdict: V.UNSIGNED,
      objectId,
      objectKey: key,
      ambiguousObjectId: true,
      reason: REASONS.AMBIGUOUS_OBJECT_ID,
      reported: claim,
      observed: { hasObjectId: true, ambiguous },
    }
  }
  if (!objectId) {
    return {
      verdict: V.UNVERIFIABLE,
      objectId: null,
      objectKey: null,
      ambiguousObjectId: false,
      reason: REASONS.NO_OBJECT_ID,
      reported: claim,
      observed: { hasObjectId: false },
    }
  }

  const p = isNum(planned) ? planned : null
  const s = isNum(succeeded) ? succeeded : (claim && isNum(claim.succeeded) ? claim.succeeded : null)

  if (p !== null && s !== null) {
    if (p > 0 && s === 0) {
      return {
        verdict: V.FAIL, objectId, objectKey: key, ambiguousObjectId: false,
        reason: REASONS.COUNT_MISMATCH, planned: p, succeeded: s,
        reported: claim, observed: { hasObjectId: true, planned: p, succeeded: s },
      }
    }
    if (s < p) {
      return {
        verdict: V.PARTIAL, objectId, objectKey: key, ambiguousObjectId: false,
        reason: REASONS.COUNT_MISMATCH, planned: p, succeeded: s,
        reported: claim, observed: { hasObjectId: true, planned: p, succeeded: s },
      }
    }
    if (s > p) {
      return {
        verdict: V.FLIP, objectId, objectKey: key, ambiguousObjectId: false,
        reason: REASONS.COUNT_MISMATCH, planned: p, succeeded: s,
        reported: claim, observed: { hasObjectId: true, planned: p, succeeded: s },
      }
    }
  }

  return {
    verdict: V.PASS, objectId, objectKey: key, ambiguousObjectId: false,
    reason: null, planned: p, succeeded: s,
    reported: claim, observed: { hasObjectId: true },
  }
}

/**
 * 批量计划判定：区分「没跑」与「跑了但零成功」。
 * attempts 每条：{ status: 'ok'|'failed'|'skipped', objectId?: string }
 */
export function judgeBatch({ planned, attempts = [] } = {}) {
  const p = isNum(planned) ? planned : 0
  const list = Array.isArray(attempts) ? attempts : []
  if (p > 0 && list.length === 0) {
    return {
      verdict: V.NOT_EXERCISED, planned: p, attempted: 0, succeeded: 0,
      notAttempted: p, reason: REASONS.NOT_ATTEMPTED,
    }
  }
  const succeeded = list.filter((a) => a && a.status === 'ok' && isStr(a.objectId)).length
  const okNoId = list.filter((a) => a && a.status === 'ok' && !isStr(a.objectId)).length
  const notAttempted = Math.max(0, p - list.length)

  if (okNoId > 0) {
    return {
      verdict: V.UNVERIFIABLE, planned: p, attempted: list.length, succeeded,
      notAttempted, reason: REASONS.NO_OBJECT_ID,
    }
  }
  if (p > 0 && succeeded === 0) {
    return { verdict: V.FAIL, planned: p, attempted: list.length, succeeded, notAttempted, reason: REASONS.COUNT_MISMATCH }
  }
  if (p > 0 && succeeded < p) {
    return { verdict: V.PARTIAL, planned: p, attempted: list.length, succeeded, notAttempted, reason: REASONS.COUNT_MISMATCH }
  }
  return { verdict: V.PASS, planned: p, attempted: list.length, succeeded, notAttempted: 0, reason: null }
}

/**
 * 签发层：一条结论必须能说出它被哪一层签发。
 * 只有执行者自己签 → UNSIGNED；时钟与执行者同源 → 视为缺时钟层；缺外部锚点 → UNSIGNED。
 */
export function judgeSigning({ producer = null, clock = null, anchor = null } = {}) {
  const missing = []
  const signedBy = []
  if (!producer || !isStr(producer.signer)) missing.push('producer')
  else signedBy.push(producer.signer)

  const clockIndependent = clock && isStr(clock.signer) && (!producer || clock.signer !== producer.signer)
  if (!clockIndependent) missing.push('clock')
  else signedBy.push(clock.signer)

  const anchorIndependent = anchor && isStr(anchor.signer) && (!producer || anchor.signer !== producer.signer)
  if (!anchorIndependent) missing.push('anchor')
  else signedBy.push(anchor.signer)

  // 连产物侧都没有：不是「自签」，是「没有可判的结果」
  if (missing.includes('producer')) {
    return { verdict: V.UNVERIFIABLE, signedBy, missing, reason: REASONS.SELF_SIGNED }
  }
  if (missing.includes('anchor')) {
    const reason = clockIndependent ? REASONS.MISSING_ANCHOR : REASONS.SELF_SIGNED
    return { verdict: V.UNSIGNED, signedBy, missing, reason }
  }
  if (missing.includes('clock')) {
    return { verdict: V.UNSIGNED, signedBy, missing, reason: REASONS.CLOCK_NOT_INDEPENDENT }
  }
  return { verdict: V.PASS, signedBy, missing: [], reason: null }
}

/**
 * 送达 ≠ 完好。两件事分别返回，绝不折叠成一个布尔。
 * 协议只保证结构合法与投递完成时，损坏会以完全合法的形态到达 —— 这一格只能 UNVERIFIABLE。
 */
export function judgeDelivery({ delivery = null, integrity = null } = {}) {
  const validDelivery = ['accepted_by_api', 'persisted', 'unknown']
  const deliveryState = validDelivery.includes(delivery) ? delivery : 'unknown'
  const it = integrity || {}

  if (it.protocolHasField === false) {
    return {
      verdict: V.UNVERIFIABLE, deliveryState, integrityState: 'unverifiable',
      reason: REASONS.PROTOCOL_NO_INTEGRITY_FIELD,
      note: '协议未提供完整性字段：损坏与完好在场内不可区分',
    }
  }
  const scope = it.scope || null
  if (!scope || !isStr(scope.kind)) {
    return { verdict: V.UNVERIFIABLE, deliveryState, integrityState: 'unverifiable', reason: REASONS.SCOPE_UNDECLARED }
  }
  if (scope.kind !== 'whitelist') {
    return {
      verdict: V.FAIL, deliveryState, integrityState: 'unverifiable',
      reason: REASONS.BLACKLIST_SCOPE,
      note: '黑名单会随新增字段自动扩大，等于校验范围在悄悄变',
    }
  }
  if (!isStr(scope.version)) {
    return { verdict: V.UNVERIFIABLE, deliveryState, integrityState: 'unverifiable', reason: REASONS.SCOPE_UNDECLARED }
  }
  if (it.expected != null && it.actual != null && it.expected !== it.actual) {
    return {
      verdict: V.FAIL, deliveryState, integrityState: 'mismatched',
      reason: REASONS.INTEGRITY_MISMATCH,
      expected: it.expected, actual: it.actual,
    }
  }
  if (it.expected == null || it.actual == null) {
    return { verdict: V.UNVERIFIABLE, deliveryState, integrityState: 'unverifiable', reason: REASONS.SCOPE_UNDECLARED }
  }
  // 结构上到达 且 完整性与声明一致 —— 仍然不等于「对方已读」
  const verdict = deliveryState === 'persisted' ? V.PASS : V.PARTIAL
  return {
    verdict, deliveryState, integrityState: 'verified', reason: null,
    note: deliveryState === 'persisted' ? '已落库且完整性一致；对方是否已读本侧不可验' : '仅接口受理，未回读确认落库',
  }
}

function cmpVersion(a, b) {
  const pa = String(a).split(/[.\-+]/).map((x) => (x === '' ? 0 : Number.isFinite(Number(x)) ? Number(x) : 0))
  const pb = String(b).split(/[.\-+]/).map((x) => (x === '' ? 0 : Number.isFinite(Number(x)) ? Number(x) : 0))
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/**
 * 三个版本号必须并排：已装 / 要求 / 平台自称最新（内部探测 + 外部来源）。
 * 版本号不能代表判据行为 —— 版本没变而 digest 变了，判 CRITERIA_DRIFT。
 */
export function judgeVersions({ installed = null, required = null, latestSelf = null, latestExternal = null, criteria = null } = {}) {
  const numbers = { installed, required, latestSelf, latestExternal }
  const missing = Object.entries(numbers).filter(([, v]) => !isStr(v)).map(([k]) => k)
  if (missing.length > 0) {
    return { verdict: V.UNKNOWN, numbers, missing, reason: REASONS.VERSION_FIELD_MISSING, drift: null }
  }

  const c = criteria || {}
  const drift = {
    declaredVersion: c.declaredVersion ?? null,
    criteriaChanged: !!(isStr(c.computedDigest) && isStr(c.recordedDigest) && c.computedDigest !== c.recordedDigest),
  }
  if (drift.criteriaChanged) {
    return {
      verdict: V.FLIP, numbers, missing: [], reason: REASONS.CRITERIA_DRIFT, drift,
      note: '版本说没变，判据正文或参数变了：以 digest 为准',
    }
  }

  if (isStr(latestSelf) && isStr(latestExternal) && cmpVersion(latestSelf, latestExternal) !== 0) {
    return { verdict: V.FLIP, numbers, missing: [], reason: REASONS.ONE_VERSION_SOURCE, drift, note: '内部探测与外部来源不一致' }
  }
  if (!isStr(latestExternal)) {
    return { verdict: V.UNSIGNED, numbers, missing: [], reason: REASONS.ONE_VERSION_SOURCE, drift }
  }
  const outdated = cmpVersion(installed, required) < 0
  return { verdict: V.PASS, numbers, missing: [], reason: null, drift, outdated }
}

/**
 * 不可变快照：只锁哈希漏窗口边界，只锁时刻漏集合，必须「签发方 + 时刻 + 集合」。
 */
export function judgeSnapshot({ issuer = null, time = null, setDigest = null, window = null } = {}) {
  const missing = []
  if (!isStr(issuer)) missing.push('issuer')
  if (!isStr(time)) missing.push('time')
  if (!isStr(setDigest)) missing.push('setDigest')
  const windowInDigest = window && window.inDigest === true
  if (window && !windowInDigest) {
    return {
      verdict: V.UNVERIFIABLE, missing, reason: REASONS.SNAPSHOT_INCOMPLETE,
      note: '固定集合配可动窗口：值侧全绿而漂移藏在边界',
    }
  }
  if (missing.length > 0) return { verdict: V.UNVERIFIABLE, missing, reason: REASONS.SNAPSHOT_INCOMPLETE }
  return { verdict: V.PASS, missing: [], reason: null }
}

/** 集合差：删一条、插一条、重建链之后，唯一还能抓到篡改的判据。 */
export function diffSets(before = [], after = [], key = 'id') {
  const k = (x) => String(x && typeof x === 'object' ? x[key] : x)
  const b = new Set((before || []).map(k))
  const a = new Set((after || []).map(k))
  const added = [...a].filter((x) => !b.has(x))
  const removed = [...b].filter((x) => !a.has(x))
  return {
    added, removed,
    intact: added.length === 0 && removed.length === 0,
    beforeCount: b.size, afterCount: a.size,
  }
}

/**
 * 三种篡改检测方式的对照。count 与 chain 可以同时通过，只有 setdiff 会红。
 * chainOk 由调用方算（这里是「重建链后自洽」的布尔），我们不替它算链。
 */
export function judgeTamper({ before = [], after = [], method = 'count', chainOk = true, key = 'id' } = {}) {
  const d = diffSets(before, after, key)
  if (method === 'count') {
    const same = d.beforeCount === d.afterCount
    return {
      verdict: same ? V.PASS : V.FAIL, method, counts: { before: d.beforeCount, after: d.afterCount },
      reason: same ? null : REASONS.COUNT_MISMATCH, setdiff: d,
      note: same ? '条数守恒 —— 这条判据抓不到「换一条」' : '条数变了',
    }
  }
  if (method === 'chain') {
    return {
      verdict: chainOk ? V.PASS : V.FAIL, method, reason: chainOk ? null : REASONS.COUNT_MISMATCH, setdiff: d,
      note: chainOk ? '链自洽 —— 重建链之后仍然自洽，抓不到换行' : '链断',
    }
  }
  return {
    verdict: d.intact ? V.PASS : V.FAIL, method, reason: d.intact ? null : REASONS.COUNT_MISMATCH, setdiff: d,
    note: d.intact ? '集合一致' : `集合差检出 added=${d.added.length} removed=${d.removed.length}`,
  }
}

/** 墓碑：VOID 不能序列化成字符串状态值，否则下游把它当正常记录参与计算。 */
export function judgeVoid(value) {
  if (value === undefined || value === null) {
    return { verdict: V.PASS, reason: null, note: '无 VOID 值' }
  }
  if (typeof value === 'string') {
    return { verdict: V.FAIL, reason: REASONS.VOID_AS_STRING, note: '字符串 VOID 会被当作一条值等于 VOID 的正常记录' }
  }
  if (typeof value === 'object' && value.state === 'VOID' && value.is_tombstone === true && value.exclude_from_join === true) {
    return { verdict: V.PASS, reason: null, tombstone: true }
  }
  return { verdict: V.UNVERIFIABLE, reason: REASONS.VOID_AS_STRING, note: '既不是墓碑也不是字符串，语义未声明' }
}

/** 缺席 vs 未变更：两者数值都为空，语义是两个结论。 */
export function judgeFieldPresence({ declared = [], snapshot = {} } = {}) {
  const have = new Set(Object.keys(snapshot || {}))
  const absent = (declared || []).filter((k) => !have.has(k))
  if (absent.length > 0) {
    return {
      verdict: V.UNVERIFIABLE, absent, reason: REASONS.FIELD_ABSENT,
      note: '声明应存在的字段缺席：不能被判成「未变更」',
    }
  }
  return { verdict: V.PASS, absent: [], reason: null }
}

/** 覆盖清单：不申报 = 未必检；被验方少声明 = UNDER_DECLARED。 */
export function judgeCoverage({ builtin = [], declaredExternal = null, observedExternal = [] } = {}) {
  const built = new Set(builtin || [])
  const observed = new Set(observedExternal || [])
  if (!Array.isArray(declaredExternal)) {
    return {
      verdict: V.NOT_EXERCISED,
      builtin: [...built], undeclared: [...observed].filter((x) => !built.has(x)),
      underDeclared: [], observabilityGap: [],
      reason: REASONS.DECLARATION_MISSING,
      note: '外部动作未申报：默认「未必检」，不得算通过',
    }
  }
  const declared = new Set(declaredExternal)
  const undeclared = [...observed].filter((x) => !declared.has(x) && !built.has(x))
  const underDeclared = undeclared
  const declaredNotObserved = [...declared].filter((x) => !observed.has(x))
  const observabilityGap = declaredNotObserved
  if (underDeclared.length > 0) {
    return {
      verdict: V.UNVERIFIABLE, builtin: [...built], undeclared, underDeclared, observabilityGap,
      reason: REASONS.UNDER_DECLARED,
    }
  }
  if (observabilityGap.length > 0) {
    return {
      verdict: V.UNVERIFIABLE, builtin: [...built], undeclared, underDeclared, observabilityGap,
      reason: REASONS.OBSERVABILITY_GAP,
      note: '申报了但未观测到：不能假装覆盖了，只能降置信度',
    }
  }
  return { verdict: V.PASS, builtin: [...built], undeclared: [], underDeclared: [], observabilityGap: [], reason: null }
}

/**
 * 空结果 vs 没跑。
 * 分母必须挂在「即使内容为空也依然存在」的那一层；没有分母时，「读到 0 条」与「没读」同形。
 */
export function judgeEmpty({ readOutcome = 'ok', statement = null } = {}) {
  if (readOutcome !== 'ok') {
    return { verdict: V.FAIL, reason: REASONS.READ_FAILED, readOutcome, statement }
  }
  if (!statement || !isNum(statement.total)) {
    return { verdict: V.UNVERIFIABLE, reason: REASONS.NO_DENOMINATOR, readOutcome, statement }
  }
  if (statement.total === 0) {
    return { verdict: V.PASS, reason: null, empty: true, readOutcome, statement, note: '真空：读到 0 条且有分母' }
  }
  return { verdict: V.PASS, reason: null, empty: false, readOutcome, statement }
}

/**
 * 可比性：语种不同是结构性偏置（不是分类错误）；生成方/kind 不同的比较只能进等价改写桶。
 */
export function judgeComparable({ a = null, b = null } = {}) {
  if (!a || !b || !isStr(a.language) || !isStr(b.language)) {
    return { verdict: V.UNVERIFIABLE, reason: REASONS.NOT_COMPARABLE, note: '缺语种或生成方标签：分母不明的数' }
  }
  if (a.language !== b.language) {
    return {
      verdict: V.UNVERIFIABLE, reason: REASONS.NOT_COMPARABLE,
      note: '语种不同的一对是结构性偏置，不能并入总负向率',
    }
  }
  const sameGenerator = isStr(a.generator) && isStr(b.generator) && a.generator === b.generator
  const sameKind = a.kind === b.kind
  if (!sameGenerator && !sameKind) {
    return {
      verdict: V.PARTIAL, reason: REASONS.EQUIVALENT_REWRITE, bucket: 'EQUIVALENT_REWRITE',
      note: '生成方与类型都不同：只能进等价改写桶，不能记成失真',
    }
  }
  return { verdict: V.PASS, reason: null, note: '同语种，可比较' }
}

/** 把判定渲染成一行给人看（回执/报告用）。 */
export function renderVerdict(r) {
  if (!r || !VERDICT_SET.has(r.verdict)) return `[UNKNOWN] 判定缺失`
  const reason = r.reason ? ` reason=${normReason(r.reason)}` : ''
  return `[${r.verdict}]${reason}`
}

/** 闭集自检：供测试断言「枚举与理由码都封闭」。 */
export const ENUMS = Object.freeze({
  verdicts: Object.keys(V),
  reasons: Object.keys(REASONS),
  isReason: (x) => REASON_SET.has(x),
  isVerdict: (x) => VERDICT_SET.has(x),
})