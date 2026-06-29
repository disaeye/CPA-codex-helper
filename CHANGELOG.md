# Changelog

本文件记录 CPA Codex Helper 的所有显著变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.3] - 2026-06-29

### Fixed

- 修复聚合徽章耗尽预警显示错误数字的问题：徽章用了 `aggregateExhaustEarlyMs`（早于周期结束的提前量，例如 28 天）配合「X 天后耗尽」文案，让用户误以为是真正的剩余时间。实际真正的剩余时间是 `aggregateExhaustAtMs - NOW`（例如 18 小时）。现改为用真正剩余时间，与文案语义一致。

## [0.1.2] - 2026-06-29

### Fixed

- 修复聚合耗尽预估时间被严重拉长的问题：原算法分子 `remainTokens`（来自 `totalLimitTokens - totalUsedTokens`）包含了 23 个未使用账号的估算额度，但分母 `aggregateRate` 只来自真实有消耗的账号——分子分母来自不同账号集合，等于假设未使用账号的额度也会以现有真实账号的速率被消耗。现改为分子只用真实账号剩余额度总和（`Σ (used/usedPercent - used)`），与分母口径一致。

## [0.1.1] - 2026-06-29

### Fixed

- 修复删除账号后「Codex 周期用量聚合」徽章总额度不下降的问题：`auth-files` 响应现作为账号全集对 `fileToAuthIndex` / `quotaInfo` / `cycleUsage` / `authFileMeta` 四个 Map 做全量 reconcile，清理已删除账号的陈旧缓存（含 localStorage 持久化部分），使下一次注入时聚合统计基于当前真实账号集合。
- 修复异常账号仍被计入总额度的问题：聚合统计现按账号状态过滤——剔除 `status: "error"`（如需重新授权）、`unavailable: true`（瞬时不可用）以及 `api-call` 响应 `status_code >= 400` 的账号；保留 `disabled`（操作员手动禁用，仍保留额度）与中间态账号。徽章新增「剔除 N 异常」后缀显示被过滤的账号数。

## [0.1.0] - YYYY-MM-DD

### Added

- 项目初始版本。
