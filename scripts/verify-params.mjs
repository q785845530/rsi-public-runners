/**
 * 参数白名单校验（在 workflow 里被调用，避免把逻辑内联进 YAML）。
 *
 * 为什么要独立成文件：
 *   之前这段 JS 内联在 `node -e "..."` 里，注释中一个 ASCII 双引号就会提前闭合
 *   bash 字符串，导致 `syntax error near unexpected token '('`——参数完全合法却被拒。
 *   独立文件没有引号转义问题，且能在本地直接跑。
 *
 * 退出码约定（关键）：
 *   0 = 通过（把结果写进 GITHUB_OUTPUT）
 *   2 = 越权输入被白名单拒绝（**不是故障**，是闸门正常工作）
 *   1 = 真故障（本文件不产生；留给其它步骤）
 */
import { appendFileSync } from 'node:fs'

const FOCI = ['rsi-self-verification', 'sandbox-isolation', 'self-improving-search', 'anti-cheat-verifier', 'program-synthesis']
const DEPTHS = ['shallow', 'standard', 'deep']
const CAPS = { shallow: 10, standard: 30, deep: 50 }
const MAX_ITEMS_CAP = 50

const focus = process.env.FOCUS || 'rsi-self-verification'
const depth = process.env.DEPTH || 'standard'
const raw = Number(process.env.MAX_ITEMS || 30)

const reject = (msg) => {
  console.error(`::error::REJECTED_BY_WHITELIST: ${msg}`)
  process.exit(2)
}

if (!FOCI.includes(focus)) reject(`非法 focus: ${focus}`)
if (!DEPTHS.includes(depth)) reject(`非法 depth: ${depth}`)
if (!Number.isFinite(raw) || raw < 1 || raw > MAX_ITEMS_CAP) reject(`max_items 越界: ${raw}`)

const maxItems = Math.min(raw, CAPS[depth])
console.log(`focus=${focus} depth=${depth} max_items=${maxItems}`)

const outFile = process.env.GITHUB_OUTPUT
if (outFile) {
  appendFileSync(outFile, `focus=${focus}\n`)
  appendFileSync(outFile, `depth=${depth}\n`)
  appendFileSync(outFile, `max_items=${maxItems}\n`)
}
