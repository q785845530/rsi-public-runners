# rsi-public-runners

**只跑流程、得结果。不含任何本地信息**（无绝对路径、无用户名、无凭据、无内部产品名）。

## 两个独立标记（不要混）

| 维度 | 取值 | 含义 |
|---|---|---|
| `result_marker` | `LOCAL_RUN` / `CI_RUN` | **在哪跑**（本地 or GitHub Actions） |
| `data_source` | `LIVE` / `FIXTURE` | **数据哪来**（真检索 or 手写样例） |

**关键**：`CI_RUN + FIXTURE` 表示"在云端跑了一次，但用的是手写样例"——**不能当真实文献证据**。

## 用法

```bash
# 判定流程（12 类 / 16 断言），默认 FIXTURE 标识
node scripts/run-all.mjs
node scripts/run-all.mjs --live        # 标为 LIVE

# 真采集（arXiv + OpenAlex + GitHub）
node scripts/collect.mjs --online --out knowledge_drop
node scripts/collect.mjs --fixture --out knowledge_drop   # 显式用样例
```

## 采集器的三处硬性约束

1. **每条产出带 `data_source:` 字段**（`LIVE` 或 `FIXTURE`），在 markdown frontmatter 里，可逐条核。
2. **S2 会持续 429**（实测 3/3 被限流）→ 用 **OpenAlex** 作为替代源，并对每个源做指数退避重试（3 次）。
3. **抓不到就写 0 条并记录 errors**，绝不用 fixture 冒充 LIVE。

## 实测数据格式（LIVE 样例）

```yaml
source: arXiv
data_source: LIVE
invariant: unified-ledger
title: Audited Skill-Graph Self-Improvement for Agentic LLMs via Verifiable Rewards, ...
url: http://arxiv.org/abs/2512.23760v1
retrieved_at: 2026-11-09T15:05:00Z
core_claim: This paper proposes Audited Skill-Graph Self-Improvement (ASG-SI), a framework that treats ...
mechanism: ...
evidence_strength: B
potential_implication_for_rsi: 作为提案候选来源，不参与验收判定
```

## 刻意不做

- 不写绝对路径、用户名、凭据
- 不自动推送、不改外部状态
- 判定全部纯函数；采集只用公开 API，无需 key
