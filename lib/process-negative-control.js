/**
 * 流程规则的判据负控（Process Negative Control）。
 *
 * 为什么需要它：上一轮实测 39 条候选里 **28 条没有主题标签**，内容是"流程规则"
 * （提议者与验收者必须分离 / 必须给出统计判据 / 拒绝必须留理由码 / 必须配对比较…）。
 * 这类规则**无法**用配对试验验——配对试验要求规则能挂到一个任务主题上，
 * 而流程规则谈的是"怎么验收"，不是"在某主题上判断对错"。
 * 于是词表判据（要命中主题词）与配对试验（要能构造任务）**共享同一个前提**：
 * 规则必须先有主题标签。这就是两种判据共同的盲区。
 *
 * 解法：换一种**判据形式**——不去测规则的效果，而是测**判据自身**：
 * 构造一个"流程被违反"的场景，断言对应判据**变红**。
 * 它与任务集无关，因此能验流程规则。
 *
 * 本模块只声明"哪种违反场景必须让哪种判据变红"并提供纯函数判定；
 * 具体的红/绿由被验判据通过注入的 predicate 决定（调用方提供）。
 */
import { V } from './verdict.js'

/**
 * 流程规则类型 → 必须为红的不变式。
 * 每个不变式是一个纯函数 check(fact) → boolean（true = 该事实违反不变式）。
 */
export const PROCESS_INVARIANTS = Object.freeze({
  'independent-signer': {
    id: 'independent-signer',
    desc: '期望签发 / 执行 / 判定必须三方分离；同源时不得直接判通过',
    violates: (f) => {
      const signers = Array.isArray(f?.signers) ? f.signers : []
      if (signers.length === 0) return true
      // 三方同源 → 违反
      const uniq = [...new Set(signers)]
      if (uniq.length < 2) return true
      // 同源时必须标记且不得进通过/失败计数
      if (f?.sameOrigin === true) {
        if (f?.countedInPass === true || f?.countedInFail === true) return true
        if (f?.sameOriginLabeled !== true) return true
      }
      return false
    },
  },
  'dual-completion-marker': {
    id: 'dual-completion-marker',
    desc: '意图(attempt_start)与落地(attempt_done)必须各落一条独立事件；done 不得由传输推定',
    violates: (f) => {
      if (!f?.attemptStartEvent) return true
      if (!f?.attemptDoneEvent) return true
      if (f?.attemptStartEvent === f?.attemptDoneEvent) return true
      if (f?.doneInferredFromTransport === true) return true
      return false
    },
  },
  'statistical-gate': {
    id: 'statistical-gate',
    desc: '验收必须带统计判据（样本量 + 区间），单次跑通不算',
    violates: (f) => {
      const s = f?.statistics
      if (!s) return true
      if (!Number.isFinite(s.samples) || s.samples < 2) return true
      if (!Array.isArray(s.ci) || s.ci.length !== 2) return true
      // 区间跨 0 → 增益不显著，不得判通过
      if (s.ci[0] <= 0 && s.ci[1] >= 0) return true
      return false
    },
  },
  'rejection-record': {
    id: 'rejection-record',
    desc: '被拒绝的候选必须留拒绝记录与理由码，不得静默丢弃',
    violates: (f) => {
      if (f?.rejected !== true) return false
      if (!f?.rejectionRecorded) return true
      if (typeof f?.reasonCode !== 'string' || f.reasonCode.trim() === '') return true
      return false
    },
  },
  'claim-vs-fact': {
    id: 'claim-vs-fact',
    desc: '未经下游判定的状态只是主张（claim），不得当事实（fact）使用',
    violates: (f) => {
      // 状态是 claim 但被当 fact 用 → 违反
      if (f?.statusKind === 'claim' && f?.treatedAsFact === true) return true
      // 缺证据支撑却被判"已就位/已完成" → 违反
      if (f?.lifecycleState !== undefined && f?.evidenceBacked !== true) return true
      return false
    },
  },
  'evidence-freshness': {
    id: 'evidence-freshness',
    desc: '证据必须在判定时刻仍有效；过期证据不得用于放行',
    violates: (f) => {
      if (f?.evidenceAt !== undefined && f?.decidedAt !== undefined) {
        if (new Date(f.evidenceAt).getTime() > new Date(f.decidedAt).getTime()) return true
      }
      if (f?.evidenceExpired === true && f?.usedToPass === true) return true
      if (f?.evidenceExpired === true) return true
      return false
    },
  },
  'deterministic-decision': {
    id: 'deterministic-decision',
    desc: '下游判定必须确定性，不得把决定权交给被验方自评',
    violates: (f) => {
      if (f?.decisionBy === 'self' || f?.decisionBy === 'subject') return true
      if (f?.decidedBySubject === true) return true
      if (f?.modelInDecisionPath === true) return true
      return false
    },
  },
  'effect-path-record': {
    id: 'effect-path-record',
    desc: '记录必须写在效果路径上，不得由过程自己在效果旁边另发一份 trace',
    violates: (f) => {
      if (f?.recordOnEffectPath !== true) return true
      if (f?.sidecarTraceOnly === true) return true
      return false
    },
  },
  'unified-ledger': {
    id: 'unified-ledger',
    desc: '提案、裁决、验证者或人的答复必须持久化到同一份可离线校验的账',
    violates: (f) => {
      const ledger = f?.ledger
      if (!ledger) return true
      if (ledger.proposalRecorded !== true) return true
      if (ledger.verdictRecorded !== true) return true
      if (ledger.humanOrValidatorAnswerRecorded !== true) return true
      if (ledger.offlineVerifiable !== true) return true
      return false
    },
  },
  'mandatory-slots': {
    id: 'mandatory-slots',
    desc: '终止/放行必须显式证明强制槽位已填满，"没有更多动作"不是终止证据',
    violates: (f) => {
      if (f?.terminationClaimed === true) {
        if (f?.mandatorySlotsProven !== true) return true
        if (f?.noMoreActionsAsEvidence === true) return true
        if (!Array.isArray(f?.mandatorySlots)) return true
        const filled = f.mandatorySlots.filter((s) => s?.filled === true).length
        if (filled < f.mandatorySlots.length) return true
      }
      return false
    },
  },
  'bidirectional-correctness': {
    id: 'bidirectional-correctness',
    desc: '判定必须双向成立：通过则证据齐备，证据不齐则不得通过',
    violates: (f) => {
      if (f?.verdict === 'PASS' && f?.evidenceComplete !== true) return true
      if (f?.verdict !== 'PASS' && f?.evidenceComplete === true && f?.rejectedWithoutReason === true) return true
      return false
    },
  },
  'budget-evidence': {
    id: 'budget-evidence',
    desc: '预算/耗时要作为证据记录，不只是记录一个数',
    violates: (f) => {
      if (f?.budgetRecorded !== true) return true
      if (f?.budgetReportedOnly === true) return true
      return false
    },
  },
  'proposer-gate-separation': {
    id: 'proposer-gate-separation',
    desc: '演化循环的提议者与验收闸必须分离；同一方不得既提议又验收',
    violates: (f) => {
      if (f?.proposer === undefined || f?.gate === undefined) return true
      if (f.proposer === f.gate) return true
      return false
    },
  },
  'regression-check-before-promotion': {
    id: 'regression-check-before-promotion',
    desc: '新增技能必须证明不破坏此前已正确的行为；回归未检查即不得晋升',
    violates: (f) => {
      if (f?.promoting === true) {
        if (f?.regressionChecked !== true) return true
        if (f?.regressions !== 0) return true
      }
      return false
    },
  },
  'replayable-evidence': {
    id: 'replayable-evidence',
    desc: '技能演化必须绑定可重放证据：改了什么、为什么有依据、何时持久化',
    violates: (f) => {
      if (f?.changed === undefined) return false
      if (f?.changed !== true) return false
      if (!f?.evidenceReplayable) return true
      if (typeof f?.rationale !== 'string' || f.rationale.trim() === '') return true
      if (f?.persistedAt === undefined) return true
      return false
    },
  },
  'periodic-reaudit': {
    id: 'periodic-reaudit',
    desc: '技能库不能只追加：必须定期用新证据重审旧技能并给出仍成立/已失效判定',
    violates: (f) => {
      if (f?.libraryChanged === true) {
        if (f?.oldSkillsReaudited !== true) return true
        if (!Array.isArray(f?.oldSkillVerdicts)) return true
        if (f.oldSkillVerdicts.some((v) => v !== 'still_valid' && v !== 'invalidated')) return true
      }
      return false
    },
  },
  'budget-bound-exploration': {
    id: 'budget-bound-exploration',
    desc: '探索必须在交互预算内；超预算的候选一律不进入验收',
    violates: (f) => {
      if (f?.explored === true) {
        if (!Number.isFinite(f?.budgetUsed)) return true
        if (!Number.isFinite(f?.budgetLimit)) return true
        if (f.budgetUsed > f.budgetLimit) return true
      }
      if (f?.overBudget && f?.enteredAcceptance === true) return true
      return false
    },
  },
  'candidate-zone-boundary': {
    id: 'candidate-zone-boundary',
    desc: '无法验证的条目只允许留在候选区，不得标记为已采纳',
    violates: (f) => {
      if (f?.verifiable !== true && f?.markedAdopted === true) return true
      if (f?.inCandidateZone !== true && f?.verifiable !== true && f?.adopted === true) return true
      return false
    },
  },
  'batch-atomic-signing': {
    id: 'batch-atomic-signing',
    desc: '批量操作必须先数成功数与计划数相等再整批签，不得边做边签',
    violates: (f) => {
      if (f?.batch !== true) return false
      if (f?.signedDuringExecution === true) return true
      if (f?.planned !== undefined && f?.succeeded !== undefined && f.planned !== f.succeeded) {
        if (f?.signedAsComplete === true) return true
      }
      return false
    },
  },
  'information-increment': {
    id: 'information-increment',
    desc: '循环必须能判断本轮是否带来新信息；轮次增加不等于进展',
    violates: (f) => {
      if (f?.roundCompleted !== true) return false
      if (f?.incrementChecked !== true) return true
      if (f?.contentChanged === false && f?.claimedProgress === true) return true
      return false
    },
  },
  'content-addressed-identity': {
    id: 'content-addressed-identity',
    desc: '标识必须由内容哈希决定；时间只能单列，不得混入标识',
    violates: (f) => {
      if (f?.idSource === undefined) return false
      if (f.idSource !== 'content-hash' && f.idSource !== 'content-hash+time') return true
      if (f?.idIncludesTimestamp === true) return true
      if (f?.timestampFieldSeparate !== true && f.idSource === 'content-hash') return true
      return false
    },
  },
  'export-digest': {
    id: 'export-digest',
    desc: '导出包必须带每个文件的摘要，否则搬运后无法证明未被改动',
    violates: (f) => {
      if (f?.exported !== true) return false
      if (!Array.isArray(f?.files)) return true
      if (f.files.length === 0) return true
      if (f.files.some((x) => !/^[0-9a-f]{16,64}$/.test(String(x?.sha256 ?? '')))) return true
      return false
    },
  },
  'paired-comparison': {
    id: 'paired-comparison',
    desc: '评估技能有效性必须在同任务上做带/不带配对比较',
    violates: (f) => {
      if (f?.evaluated !== true) return false
      const pairs = Array.isArray(f?.pairedCases) ? f.pairedCases : []
      if (pairs.length < 2) return true
      if (pairs.every((p) => p?.without === undefined || p?.with === undefined)) return true
      return false
    },
  },
})

/**
 * 判定一个"流程事实"是否违反某条不变式。
 * @param {{kind:string, fact:object}} p
 */
export function judgeProcessInvariant({ kind, fact = {} } = {}) {
  const inv = PROCESS_INVARIANTS[kind]
  if (!inv) {
    return { verdict: V.UNVERIFIABLE, reason: 'UNKNOWN_INVARIANT', kind, red: null,
      available: Object.keys(PROCESS_INVARIANTS) }
  }
  const red = inv.violates(fact)
  return {
    verdict: red ? V.FAIL : V.PASS,
    reason: red ? 'INVARIANT_VIOLATED' : null,
    kind, red,
    desc: inv.desc,
    note: red ? '事实违反该不变式：对应判据必须变红' : '事实满足该不变式',
  }
}

/**
 * 对一批"违反场景"跑负控：每一类都必须能判红，否则说明该不变式**测不出来**。
 *
 * 这是本模块的核心：**判据的判据**。如果一个不变式在任何注入事实下都判绿，
 * 它就没有鉴别力，应当被撤掉而不是留着装点。
 *
 * @param {Array<{kind:string, fact:object}>} cases
 */
export function runNegativeControls({ cases = [] } = {}) {
  const list = Array.isArray(cases) ? cases : []
  const rows = []
  for (const c of list) {
    const r = judgeProcessInvariant({ kind: c.kind, fact: c.fact ?? {} })
    rows.push({ kind: c.kind, red: r.red, verdict: r.verdict, reason: r.reason })
  }
  const notRed = rows.filter((r) => r.red !== true)
  return {
    verdict: notRed.length === 0 && rows.length > 0 ? V.PASS : (rows.length === 0 ? V.UNVERIFIABLE : V.FAIL),
    total: rows.length,
    allRed: rows.length > 0 && notRed.length === 0,
    notRed: notRed.map((r) => r.kind),
    rows,
    note: notRed.length === 0
      ? '全部违反场景都判红：这些不变式有鉴别力'
      : `这些不变式在注入的违反场景下没判红：${notRed.map((r) => r.kind).join(', ')}（无鉴别力，应撤）`,
  }
}

/**
 * 判断一条**流程规则**能否被上述不变式验证。
 *
 * 做法：把规则文本映射到它声明的不变式类别（由调用方给出映射，因为纯函数不做语义理解），
 * 然后跑该类别的负控：若负控全红，说明这类规则**可验**，可进入晋升候选。
 *
 * @param {{rule:string, invariantKind:string, cases:Array}} p
 */
export function judgeProcessRulePromotion({ rule = '', invariantKind = null, cases = [] } = {}) {
  if (!invariantKind) {
    return { verdict: V.NOT_EXERCISED, promote: false, reason: 'NO_INVARIANT_MAPPING',
      note: '流程规则必须映射到一条不变式，否则无法验证' }
  }
  const inv = PROCESS_INVARIANTS[invariantKind]
  if (!inv) {
    return { verdict: V.UNVERIFIABLE, promote: false, reason: 'UNKNOWN_INVARIANT', invariantKind }
  }
  const relevant = cases.filter((c) => c.kind === invariantKind)
  if (relevant.length === 0) {
    return { verdict: V.NOT_EXERCISED, promote: false, reason: 'NO_NEGATIVE_CONTROL',
      invariantKind, note: '该不变式没有负控场景：无法证明它能判红' }
  }
  const nc = runNegativeControls({ cases: relevant })
  if (nc.allRed !== true) {
    return { verdict: V.FAIL, promote: false, reason: 'NEGATIVE_CONTROL_NOT_RED', invariantKind,
      notRed: nc.notRed, note: nc.note }
  }
  return { verdict: V.PASS, promote: true, reason: null, invariantKind,
    desc: inv.desc, negativeControls: nc.total,
    note: `该不变式的 ${nc.total} 个违反场景全部判红：规则可验` }
}
