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
const wantFixture = has('--fixture')
if (wantOnline && wantFixture) { console.error('--online 与 --fixture 不能同时使用'); process.exit(2) }
const mode = wantOnline ? 'online' : (wantFixture ? 'fixture' : 'online')

const UA = 'rsi-collect/1.0 (research metadata collector)'
const QUERIES = ['recursive self-improvement agent', 'agent skill audit provenance']

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
  for (const q of QUERIES) {
    // arXiv
    const a = await fetchWithRetry(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=5`)
    if (a.ok) entries.push(...parseArxiv(a.text).map((e) => ({ ...e, __q: q })))
    else errors.push(...(a.errors ?? ['arxiv:unknown']))

    // OpenAlex（S2 的替代源：实测 S2 持续 429，OpenAlex 重试可取）
    const o = await fetchWithRetry(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=5`)
    if (o.ok) { try { entries.push(...parseOpenAlex(JSON.parse(o.text)).map((e) => ({ ...e, __q: q }))) } catch { errors.push('openalex:parse') } }
    else errors.push(...(o.errors ?? ['openalex:unknown']))

    // GitHub
    const g = await fetchWithRetry(`https://api.github.com/search/repositories?q=${encodeURIComponent(q.replace(/\s+/g, '+'))}&per_page=5`)
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

const written = []
let skipped = 0
for (const e of entries) {
  const fp = createHash('sha256').update(dataSource + '|' + e.source + '|' + e.title).digest('hex').slice(0, 12)
  if (index.entries[fp]) { skipped += 1; continue }
  const name = `${dataSource}-${e.source}-${fp}.md`
  await writeFile(join(outDir, name), toMarkdown(e, { dataSource, retrievedAt: at }), 'utf8')
  index.entries[fp] = { name, at, dataSource, url: e.url }
  written.push(name)
}

index.lastRun = { at, mode, dataSource, written: written.length, skipped, fetched: entries.length, errors: errors.slice(0, 10) }
await writeFile(indexFile, JSON.stringify(index, null, 2), 'utf8')

const marker = process.env.GITHUB_ACTIONS === 'true' ? 'CI_RUN' : 'LOCAL_RUN'
console.log(JSON.stringify({
  ok: written.length > 0 && errors.length === 0,
  result_marker: marker,
  data_source: dataSource,
  at, outDir,
  fetched: entries.length, written: written.length, skipped,
  errors: errors.slice(0, 10),
  files: written.slice(0, 5),
}, null, 2))
process.exit(written.length > 0 ? 0 : 1)
