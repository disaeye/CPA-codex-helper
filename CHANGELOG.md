# Changelog

本文件记录 CPA Codex Helper 的所有显著变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 初始化油猴脚本仓库结构。
- 新增 Codex 周期用量展示，包括 token、费用与请求次数。
- 新增基于 Codex 已用百分比的周期总额度反推。
- 新增剩余额度估算与提前耗尽预警。
- 新增 Codex 区块标题聚合统计。
- 新增 localStorage 缓存，减少短时间内重复请求。
- 新增 analytics 端点不可用时的降级逻辑。
- 新增未使用账号的额度估算：按同周期窗口的中位数估算总额度，并入区块标题聚合统计。
- 新增多语言支持：跟随 CPA-Manager-Plus 当前语言（简体中文 / 繁体中文 / 英文 / 俄文），通过读取页面 `<html lang>` 与 `localStorage` 检测，内置字典翻译所有注入文案与时间单位。

### Changed

- 脚本默认按路径匹配任意域名下的 `management.html` 页面，覆盖自部署 CPA-Manager-Plus 管理页，无需手动配置实例域名。
- 脚本运行时机调整为 `document-start`，确保能在页面首批请求前安装 XHR hook。
- 更新 README，补充安装、使用、限制与自部署匹配规则说明。

## [0.1.0] - YYYY-MM-DD

### Added

- 项目初始版本。
