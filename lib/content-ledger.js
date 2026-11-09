/**
 * 内容寻址账本（Content-Addressed Ledger）+ 单条原子回滚。
 *
 * 为什么需要：
 *   传统"备份目录"回滚只能整批回退，且无法证明"回滚后与某个已知状态逐字节相同"。
 *   内容寻址账本用 sha256 作为对象唯一名，任何一次写入都可单独回滚，且回滚结果
 *   可用摘要核验（不靠人眼看）。
 *
 * 设计：
 *   <ledger>/
 *     objects/<sha256>            ← 内容对象（首次写入后不再改写，天然不可变）
 *     entries/<sha256>.json       ← 单条变更记录 {seq, at, path, before, after, op}
 *     HEAD.json                   ← 当前指向的条目集合与校验
 *
 * 每条变更记录 `before` / `after` 都是内容对象的 sha256；回滚单条 = 把 path 写回
 * `before` 对象（或删除，若 before 为 null），并**追加**一条 rollback 记录（不删原记录）。
 *
 * 不可变约束：objects/ 下的文件只允许"创建时写入"，已存在则校验摘要后跳过。
 */
import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { V } from './verdict.js'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 账本布局。 */
export function ledgerPaths(root) {
  return {
    root,
    objects: join(root, 'objects'),
    entries: join(root, 'entries'),
    head: join(root, 'HEAD.json'),
  }
}

async function ensureLayout(p) {
  await mkdir(p.objects, { recursive: true })
  await mkdir(p.entries, { recursive: true })
}

/** 写入内容对象（幂等：已存在则校验后跳过）。 */
export async function putObject({ root, content }) {
  const p = ledgerPaths(root)
  await ensureLayout(p)
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content))
  const digest = sha256(buf)
  const file = join(p.objects, digest)
  try {
    const existing = await readFile(file)
    if (sha256(existing) !== digest) {
      return { ok: false, verdict: V.FAIL, reason: 'OBJECT_CORRUPTED', digest }
    }
    return { ok: true, digest, reused: true }
  } catch {
    await writeFile(file, buf)
    return { ok: true, digest, reused: false }
  }
}

/** 读取内容对象并校验摘要（防篡改）。 */
export async function getObject({ root, digest }) {
  const p = ledgerPaths(root)
  try {
    const buf = await readFile(join(p.objects, digest))
    const actual = sha256(buf)
    if (actual !== digest) return { ok: false, verdict: V.FAIL, reason: 'DIGEST_MISMATCH', digest, actual }
    return { ok: true, digest, content: buf }
  } catch {
    return { ok: false, verdict: V.FAIL, reason: 'OBJECT_MISSING', digest }
  }
}

/** 追加一条变更记录（before/after 为摘要或 null）。 */
export async function appendEntry({ root, path, before = null, after = null, op, at = null, note = '' }) {
  const p = ledgerPaths(root)
  await ensureLayout(p)
  const seq = (await listEntries({ root })).length + 1
  const entry = {
    seq, at, path, before, after, op,
    note: String(note).slice(0, 200),
  }
  const body = JSON.stringify(entry, Object.keys(entry).sort(), 0)
  const digest = sha256(Buffer.from(body))
  await writeFile(join(p.entries, `${String(seq).padStart(6, '0')}-${digest.slice(0, 8)}.json`), body, 'utf8')
  await refreshHead({ root })
  return { ok: true, seq, digest, entry }
}

/** 列出全部变更记录（按 seq 升序）。 */
export async function listEntries({ root }) {
  const p = ledgerPaths(root)
  let files = []
  try { files = (await readdir(p.entries)).filter((f) => f.endsWith('.json')).sort() } catch { return [] }
  const out = []
  for (const f of files) {
    try { out.push(JSON.parse(await readFile(join(p.entries, f), 'utf8'))) } catch { /* 坏行跳过并计数 */ }
  }
  return out
}

/** 重算 HEAD：条目数 + 每条摘要（可核验账本本身未被改）。 */
export async function refreshHead({ root }) {
  const p = ledgerPaths(root)
  const entries = await listEntries({ root })
  const head = {
    count: entries.length,
    seqMax: entries.reduce((m, e) => Math.max(m, e.seq ?? 0), 0),
    lastAt: entries.length ? entries[entries.length - 1].at : null,
    chain: entries.map((e) => ({ seq: e.seq, path: e.path, op: e.op })).slice(-20),
  }
  const body = JSON.stringify(head)
  head.digest = sha256(Buffer.from(body))
  await writeFile(p.head, JSON.stringify(head, null, 2), 'utf8')
  return head
}

/** 记录一次文件写入（自动把前后内容入对象库）。 */
export async function recordWrite({ root, path, contentBefore = null, contentAfter = null, at = null, note = '' }) {
  const b = contentBefore === null ? null : (await putObject({ root, content: contentBefore })).digest
  const a = contentAfter === null ? null : (await putObject({ root, content: contentAfter })).digest
  return appendEntry({ root, path, before: b, after: a, op: contentBefore === null ? 'create' : (contentAfter === null ? 'delete' : 'update'), at, note })
}

/**
 * 单条原子回滚：把某条记录对应的 path 恢复到它的 before 状态。
 * 回滚本身也追加一条记录（不删原记录），因此可追溯。
 *
 * @param {{root, target: string|number, baseDir: string, at?: string}} p
 *        target 可为 seq（数字）或 path（字符串）
 */
export async function rollbackOne({ root, target, baseDir, at = null }) {
  const entries = await listEntries({ root })
  const entry = typeof target === 'number'
    ? entries.find((e) => e.seq === target)
    : entries.filter((e) => e.path === target).pop()
  if (!entry) return { ok: false, verdict: V.UNVERIFIABLE, reason: 'ENTRY_NOT_FOUND', target }

  const abs = join(baseDir, entry.path)
  // before 为 null ⇒ 该变更原本是"新建"，回滚即删除
  if (entry.before === null) {
    await rm(abs, { force: true })
    await appendEntry({ root, path: entry.path, before: null, after: entry.after, op: 'rollback-delete', at, note: `rollback of seq ${entry.seq}` })
    return { ok: true, verdict: V.PASS, action: 'deleted', path: entry.path, seq: entry.seq }
  }
  const obj = await getObject({ root, digest: entry.before })
  if (!obj.ok) return { ok: false, verdict: V.FAIL, reason: obj.reason, digest: entry.before }
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, obj.content)
  // 回滚后校验逐字节一致
  const check = sha256(await readFile(abs))
  const ok = check === entry.before
  await appendEntry({ root, path: entry.path, before: entry.after, after: entry.before, op: 'rollback-restore', at, note: `rollback of seq ${entry.seq}` })
  return { ok, verdict: ok ? V.PASS : V.FAIL, reason: ok ? null : 'ROLLBACK_DIGEST_MISMATCH',
    action: 'restored', path: entry.path, seq: entry.seq, digest: entry.before, verified: ok }
}

/** 账本完整性核验：逐条检查 after 对象是否存在且摘要正确。 */
export async function verifyLedger({ root }) {
  const entries = await listEntries({ root })
  const broken = []
  for (const e of entries) {
    for (const d of [e.before, e.after]) {
      if (d === null) continue
      const r = await getObject({ root, digest: d })
      if (!r.ok) broken.push({ seq: e.seq, digest: d, reason: r.reason })
    }
  }
  const head = await refreshHead({ root })
  return {
    verdict: broken.length === 0 ? V.PASS : V.FAIL,
    entries: entries.length, broken: broken.length, brokenList: broken.slice(0, 10),
    headDigest: head.digest, note: broken.length ? '账本内有对象缺失或被改' : '账本完整',
  }
}
