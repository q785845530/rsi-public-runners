# rsi-public-runners

**只跑流程、得结果。不含任何本地信息**（无绝对路径、无用户名、无凭据、无内部产品名）。

## 用法

```bash
node scripts/run-all.mjs          # 跑全部流程
```

结果 JSON 带标识：

- `"result_marker": "LOCAL_RUN"` —— 本地/离线运行
- `"result_marker": "CI_RUN"` —— GitHub Actions 运行

## 覆盖的流程

| # | 流程 | 断言要点 |
|---|---|---|
| 1 | 主张阶梯 | 手填高级别 → 降级 |
| 2 | 证据门 | 六指标全缺 → NEEDS_EVIDENCE；safety 不可补偿 → QUARANTINE |
| 3 | 单变量 / 轴级去重 | 多变量 → FAIL；同轴不同 id 被抓 |
| 4 | 隐藏集 / 捷径率 | 分片可复算；无负控 → rate=null |
| 5 | 元层演化 | 缺证据 → ARCHIVE |
| 6 | 判别向量 | 纯 ASCII → 无鉴别力 |
| 7 | 配对试验 | lift>0 且零回归才 PASS |
| 8 | 增量闸 | 内容未变 → SKIP |
| 9 | 证据判定 | ruleRef 不匹配 → 拒 |
| 10 | 流程不变式负控 | 全部违反场景必须判红 |
| 11 | 知识闸门 | 投毒 → POISONED_INPUT |
| 12 | 内容寻址账本 | 单条回滚逐字节还原 |

## 刻意不做

- 不写绝对路径、用户名、凭据
- 不自动推送、不改外部状态
- 所有判定为纯函数，无网络、无模型调用
