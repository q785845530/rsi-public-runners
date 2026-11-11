/**
 * 采集器（公共库版）：多源检索 → 确定性筛选 → 结构化 Markdown。
 *
 * 三个设计要点（都是被真实事故逼出来的）：
 *   ① 数据来源必须可区分：每条产出的 frontmatter 带 `data_source: LIVE|FIXTURE`。
 *      fixture 是**手写的**样例，不是检索结果——不标出来就会被当成真实文献证据。
 *   ② S2 会 429：加指数退避重试，且**用 OpenAlex 作为替代源**（实测 OpenAlex
 *      偶发 429 但重试可取，S2 持续 429）。
 *   ③ 不编造：抓不到就写 0 条并如实记录 errors，**绝不**用 fixture 冒充 LIVE。
 *
 *   node scripts/collect.mjs --online --out <dir>     # 真抓
 *   node scripts/collect.mjs --fixture --out <dir>    # 显式用样例（会标 FIXTURE）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const has = (k) => argv.includes(k)

const outDir = arg('--out', join(HERE, '..', 'knowledge_drop'))
const indexFile = arg('--index', join(outDir, 'INDEX.json'))
const at = arg('--at', new Date().toISOString())
const wantOnline = has('--online')
const focusArg = arg('--focus', 'rsi-self-verification')
const depthArg = arg('--depth', 'standard')
const maxItemsArg = Number(arg('--max-items', '30'))
const wantFixture = has('--fixture')
if (wantOnline && wantFixture) { console.error('--online 与 --fixture 不能同时使用'); process.exit(2) }
const mode = wantOnline ? 'online' : (wantFixture ? 'fixture' : 'online')

const UA = 'rsi-collect/1.0 (research metadata collector)'
/**
 * focus 是**缺口类型**，不是自由关键词。
 * 这个映射决定"补哪个缺口要搜什么"，可审计、可冻结；RSI 只能选枚举，不能自造关键词。
 */
export const FOCUS_QUERIES = Object.freeze({
  'rsi-self-verification': ['self-verification agent invariant', 'agent self-verification taxonomy'],
  'sandbox-isolation': ['sandbox isolation agent execution', 'process isolation microvm agent'],
  'self-improving-search': ['descriptive claim extraction nlp', 'abstractive claim mining'],
  'anti-cheat-verifier': ['verifier gaming detection reward hacking', 'anti-cheat evaluation agent'],
  'program-synthesis': ['program synthesis agent verification', 'code synthesis correctness agent'],
})
// 非法 focus 必须**硬拒绝**，不能静默回落到默认值
// （实测踩到：自由文本 focus 被静默接受，等于白名单形同虚设）
const DEPTH_LIMIT = Object.freeze({ shallow: 10, standard: 30, deep: 50 })
if (!Object.prototype.hasOwnProperty.call(FOCUS_QUERIES, focusArg)) {
  console.error(JSON.stringify({
    ok: false, reason: 'ILLEGAL_FOCUS', got: focusArg,
    allowed: Object.keys(FOCUS_QUERIES),
  }, null, 2))
  process.exit(2)
}
if (!Object.prototype.hasOwnProperty.call(DEPTH_LIMIT, depthArg)) {
  console.error(JSON.stringify({ ok: false, reason: 'ILLEGAL_DEPTH', got: depthArg, allowed: Object.keys(DEPTH_LIMIT) }, null, 2))
  process.exit(2)
}
const QUERIES = FOCUS_QUERIES[focusArg]
const MAX_ITEMS = Math.min(Number.isFinite(maxItemsArg) ? maxItemsArg : 30, DEPTH_LIMIT[depthArg] ?? 30)

/** 指数退避：S2 实测持续 429，重试 3 次仍失败就放弃并记录。 */
async function fetchWithRetry(url, { tries = 3, baseMs = 800, timeoutMs = 20000 } = {}) {
  const errors = []
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json, application/atom+xml' }, signal: AbortSignal.timeout(timeoutMs) })
      if (res.status === 429) { errors.push(`429`); await sleep(baseMs * 2 ** i); continue }
      if (!res.ok) { errors.push(`HTTP${res.status}`); return { ok: false, status: res.status, errors } }
      const text = await res.text()
      return { ok: true, status: res.status, text, attempts: i + 1 }
    } catch (e) {
      errors.push(String(e.message).slice(0, 50))
      await sleep(baseMs * 2 ** i)
    }
  }
  return { ok: false, status: 0, errors }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析器：把各源响应转成统一条目。 */
function parseArxiv(xml) {
  const out = []
  for (const m of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = m[1]
    const title = decodeEntities((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]??'').replace(/\s+/g, ' ').trim()
    const id = (block.match(/<id>([\s\S]*?)<\/id>/) || [])[1]?.trim()
    const summary = (block.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]?.replace(/\s+/g, ' ').trim()
    if (!title) continue
    out.push({ source: 'arXiv', title, url: id ?? '', core_claim: firstSentence(summary ?? ''), mechanism: (summary ?? '').slice(0, 160) })
  }
  return out
}
function parseOpenAlex(json) {
  const out = []
  for (const w of (json.results ?? [])) {
    if (!w?.title) continue
    out.push({ source: 'OpenAlex', title: w.title, url: w.doi ?? w.id ?? '',
      core_claim: firstSentence(reconstructAbstract(w)), mechanism: (w.primary_location?.source?.display_name ?? '').slice(0, 80) })
  }
  return out
}
function parseGithub(json) {
  const out = []
  for (const r of (json.items ?? [])) {
    if (!r?.full_name) continue
    out.push({ source: 'GitHub', title: r.full_name, url: r.html_url ?? '',
      core_claim: (r.description ?? '').slice(0, 200), mechanism: `stars=${r.stargazers_count} pushed=${r.pushed_at ?? '-'}` })
  }
  return out
}
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}
function reconstructAbstract(w) {
  const inv = w?.abstract_inverted_index
  if (!inv) return ''
  const words = []
  for (const [k, idxs] of Object.entries(inv)) for (const i of idxs) words[i] = k
  return words.join(' ')
}
/**
 * 从摘要里取"更可能是主张"的句子。
 * 实测：直接取首句会取到背景句（"X is increasingly used to…"），不是核心主张。
 * 策略：优先取含 we/this work/propose/introduce/show/find/demonstrate 的句子，其次退回首句。
 */
function firstSentence(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  if (t === '') return ''
  const sentences = t.split(/(?<=[.!?])\s+/).filter((x) => x.length >= 20)
  const CLAIM = /\b(we|this work|this paper|we propose|we introduce|we show|we find|we demonstrate|here we|results show|propose|introduce)\b/i
  const claim = sentences.find((x) => CLAIM.test(x))
  const pick = claim ?? sentences[0] ?? t
  return pick.slice(0, 220).trim()
}

/** 每条产出都必须标注数据来源；invariant 由关键词映射（映射不到就写 unknown 并进隔离）。 */
const INVARIANT_RULES = [
  ['unified-ledger', /audit|provenance|ledger|trace|record|memory/i],
  ['paired-comparison', /benchmark|compar\w*|evaluat|ablation|experiment|a\/b/i],
  ['evidence-freshness', /version\w*|freshness|temporal|drift|stale|expire/i],
  ['independent-signer', /verif\w*|attest|independent|trust|reward|critic/i],
  ['regression-check-before-promotion', /regress\w*|preserve|no.?degrad|retention/i],
  ['replayable-evidence', /replay|reproduc\w*|determinis\w*/i],
  ['proposer-gate-separation', /propose\w*|gate\w*|harness|separation/i],
  ['statistical-gate', /statistic\w*|confidence\w*|sample\w*|significan\w*/i],
  ['periodic-reaudit', /re.?audit|revis\w*|continual\w*|lifelong/i],
]

function toMarkdown(entry, { dataSource, retrievedAt }) {
  const inv = INVARIANT_RULES.find(([, re]) => re.test(`${entry.title} ${entry.core_claim} ${entry.mechanism}`))?.[0] ?? 'unknown'
  return [
    `source: ${entry.source}`,
    `data_source: ${dataSource}`,     // ← LIVE | FIXTURE，必须标
    `invariant: ${inv}`,
    `title: ${entry.title}`,
    `url: ${entry.url}`,
    `retrieved_at: ${retrievedAt}`,
    `core_claim: ${entry.core_claim || '(none)'}`,
    `mechanism: ${entry.mechanism || '(none)'}`,
    `evidence_strength: ${dataSource === 'LIVE' ? 'B' : 'C'}`,
    `potential_implication_for_rsi: 作为提案候选来源，不参与验收判定`,
  ].join('\n') + '\n'
}

async function loadIndex() {
  try { return JSON.parse(await readFile(indexFile, 'utf8')) } catch { return { entries: {} } }
}

const index = await loadIndex()
await mkdir(outDir, { recursive: true })
const errors = []
const entries = []
let dataSource = 'LIVE'

if (mode === 'online') {
  // 每个 query 的配额 = 上限 / query 数，至少 1
  const perQuery = Math.max(1, Math.ceil(MAX_ITEMS / Math.max(1, QUERIES.length)))
  for (const q of QUERIES) {
    // arXiv
    const a = await fetchWithRetry(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=${perQuery}`)
    if (a.ok) entries.push(...parseArxiv(a.text).map((e) => ({ ...e, __q: q })))
    else errors.push(...(a.errors ?? ['arxiv:unknown']))

    // OpenAlex（S2 的替代源：实测 S2 持续 429，OpenAlex 重试可取）
    const o = await fetchWithRetry(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${perQuery}`)
    if (o.ok) { try { entries.push(...parseOpenAlex(JSON.parse(o.text)).map((e) => ({ ...e, __q: q }))) } catch { errors.push('openalex:parse') } }
    else errors.push(...(o.errors ?? ['openalex:unknown']))

    // GitHub
    const g = await fetchWithRetry(`https://api.github.com/search/repositories?q=${encodeURIComponent(q.replace(/\s+/g, '+'))}&per_page=${perQuery}`)
    if (g.ok) { try { entries.push(...parseGithub(JSON.parse(g.text)).map((e) => ({ ...e, __q: q }))) } catch { errors.push('github:parse') } }
    else errors.push(...(g.errors ?? ['github:unknown']))
  }
  if (entries.length === 0) {
    // 抓不到就如实 0 条，**不**用 fixture 冒充
    dataSource = 'LIVE'
  }
} else {
  dataSource = 'FIXTURE'
  entries.push(
    { source: 'FIXTURE', title: '样例：技能复用审计', url: '', core_claim: '样例条目，非检索结果', mechanism: '手写样例' },
  )
}

// 写入记录与「实际落盘数」必须分开：前者是写入方的自述，后者是独立读回点。
// 两者同源时，一旦输出流被截断，计数会同步缩小、差值恒为零（真实事故，见广播 378660889336741888）。
const writtenNames = []
let skipped = 0
for (const e of entries) {
  if (writtenNames.length >= MAX_ITEMS) break
  // 指纹**不含 source**：来源是「这条从哪来」，不是「这条是什么」。
  // 含 source 会让同一份知识在 arXiv 与 OpenAlex 各存一份（实测已发生 4 例，虚增 9.1%）。
  // 归一：先抽 arXiv ID（两种 URL 形态都要覆盖），抽不到再退回标题。
  const arxivId = (String(e.url || '') + ' ' + String(e.title || '')).match(/arxiv[./](\d{4}\.\d{4,5})/i)?.[1]
    || String(e.url || '').match(/\/abs\/(\d{4}\.\d{4,5})/i)?.[1]
    || null
  const identity = arxivId ? 'arxiv:' + arxivId : 'title:' + String(e.title || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const fp = createHash('sha256').update(dataSource + '|' + identity).digest('hex').slice(0, 12)
  if (index.entries[fp]) { skipped += 1; continue }
  const name = `${dataSource}-${e.source}-${fp}.md`
  await writeFile(join(outDir, name), toMarkdown(e, { dataSource, retrievedAt: at }), 'utf8')
  index.entries[fp] = { name, at, dataSource, url: e.url }
  writtenNames.push(name)
}

// ★ 独立读回点：不信任写入方的自述，直接重新遍历落盘目录数一遍。
const { readdir } = await import('node:fs/promises')
const onDisk = (await readdir(outDir)).filter((f) => f.endsWith('.md'))
const writtenOnDisk = onDisk.length
const writtenThisRun = writtenNames.filter((n) => onDisk.includes(n)).length

index.lastRun = { at, mode, dataSource, focus: focusArg, depth: depthArg, max_items: MAX_ITEMS,
  written: writtenOnDisk, written_this_run: writtenThisRun,
  skipped, fetched: entries.length, errors: errors.slice(0, 10),
  count_source: 'readdir(outDir) — 独立读回，不采信写入返回值' }
await writeFile(indexFile, JSON.stringify(index, null, 2), 'utf8')

const marker = process.env.GITHUB_ACTIONS === 'true' ? 'CI_RUN' : 'LOCAL_RUN'
console.log(JSON.stringify({
  ok: writtenOnDisk > 0 && errors.length === 0,
  result_marker: marker,
  data_source: dataSource,
  focus: focusArg, depth: depthArg, max_items: MAX_ITEMS,
  at, outDir,
  fetched: entries.length, written: writtenOnDisk, written_this_run: writtenThisRun, skipped,
  count_source: 'readdir(outDir) — 独立读回，不采信写入返回值',
  errors: errors.slice(0, 10),
  files: writtenNames.slice(0, 5),
}, null, 2))
process.exit(writtenOnDisk > 0 ? 0 : 1)
