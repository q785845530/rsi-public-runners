/**
 * 判别向量自检（补自《可执行方案》§10 第五条）。
 *
 * 为什么：用纯 ASCII 键验证键序，等于在"两种口径等价的定义域"上自证——
 * 实现方写错了序，这组向量照样全绿。判别向量必须**能区分两种口径**。
 */
import { V } from './verdict.js'

/** 码点序 vs 码元序在含私用区/星平面字符时不同。 */
export function judgeKeyOrderVector({ keys = [] } = {}) {
  const list = Array.isArray(keys) ? keys : []
  const hasSupplementary = list.some((k) => [...String(k)].some((ch) => ch.codePointAt(0) > 0xffff))
  const hasPrivate = list.some((k) => [...String(k)].some((ch) => {
    const c = ch.codePointAt(0)
    return c >= 0xe000 && c <= 0xf8ff
  }))
  if (!hasSupplementary && !hasPrivate) {
    return {
      verdict: V.FAIL, reason: 'VECTOR_INSENSITIVE', discriminative: false,
      note: '纯 ASCII 键在两种序下摘要相同：这条向量证明不了序口径正确',
    }
  }
  // 两种序的排序结果必须不同，才算真能分辨。
  // 注意：JS 的 `<` 比的是 UTF-16 **码元**，直接用它会退化成码元序，
  // 两种序永远相同 —— 必须显式取 codePointAt 比较（这里踩过一次）。
  const cpOf = (v) => [...String(v)].map((ch) => ch.codePointAt(0))
  const cmpCodePoint = (a, b) => {
    const A = cpOf(a), B = cpOf(b)
    for (let i = 0; i < Math.min(A.length, B.length); i += 1) {
      if (A[i] !== B[i]) return A[i] - B[i]
    }
    return A.length - B.length
  }
  const cmpCodeUnit = (a, b) => {
    const sa = String(a), sb = String(b)
    for (let i = 0; i < Math.min(sa.length, sb.length); i += 1) {
      const d = sa.charCodeAt(i) - sb.charCodeAt(i)
      if (d !== 0) return d
    }
    return sa.length - sb.length
  }
  const byCodePoint = [...list].sort(cmpCodePoint)
  const byCodeUnit = [...list].sort(cmpCodeUnit)
  const differs = JSON.stringify(byCodePoint) !== JSON.stringify(byCodeUnit)
  return {
    verdict: differs ? V.PASS : V.FAIL,
    reason: differs ? null : 'VECTOR_INSENSITIVE',
    discriminative: differs,
    codePointOrder: byCodePoint,
    codeUnitOrder: byCodeUnit,
  }
}
