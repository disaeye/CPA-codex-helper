// ==UserScript==
// @name         CPA Codex Helper
// @namespace    https://github.com/disaeye/CPA-codex-helper
// @version      0.1.3
// @description  增强 CPA-Manager-Plus 的 Codex 额度展示，显示周期用量、反推总额度与提前耗尽预警
// @author       disaeye
// @license      MIT
// @match        *://*/*management.html*
// @match        *://*/management.html*
// @run-at       document-start
// @grant        none
// @homepageURL  https://github.com/disaeye/CPA-codex-helper
// @supportURL   https://github.com/disaeye/CPA-codex-helper/issues
// @downloadURL  https://raw.githubusercontent.com/disaeye/CPA-codex-helper/main/CPA-codex-helper.user.js
// @updateURL    https://raw.githubusercontent.com/disaeye/CPA-codex-helper/main/CPA-codex-helper.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 常量
  // ============================================================

  const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
  const AUTH_FILES_PATH = '/auth-files';
  const API_CALL_PATH = '/api-call';
  // CPA-Manager-Plus monitoring analytics 端点，用于按 authIndex 聚合周期用量
  const ANALYTICS_PATH = '/v0/management/monitoring/analytics';
  const MGMT_PREFIX = '/v0/management';

  const MIN_CYCLE_SECONDS = 3600;

  // 注入标记，防重复
  const INJECTED_FLAG = 'data-cmp-cycle-injected';
  const ROW_CLASS = 'cmp-cycle-usage-row';

  // ============================================================
  // 状态
  // ============================================================

  const state = {
    authToken: null,                          // Bearer token（从 XHR 抓）
    apiBase: '',                              // 真实 apiBase（含 origin，从已发请求推导）
    // null=未知, true=可用, false=已确认 404（CPA 原生前端无此端点）
    analyticsAvailable: null,
    // fileName -> authIndex（从 auth-files 响应）
    fileToAuthIndex: new Map(),
    // authIndex -> { resetAtMs, usedPercent, limitWindowSeconds, fileName, capturedAt, httpStatus }
    quotaInfo: new Map(),
    // authIndex -> { tokens, cost, requests, fetchedAt, error }
    cycleUsage: new Map(),
    // authIndex -> { disabled, status, unavailable, statusMessage, capturedAt }
    authFileMeta: new Map(),
    // 正在请求中的 authIndex Set，防重复
    pendingAnalytics: new Set(),
  };

  // ============================================================
  // 工具函数
  // ============================================================

  // ---------- i18n（跟随 CPA-Manager-Plus 当前语言） ----------
  // 页面用 i18next 但未挂 window，这里读 documentElement.lang / localStorage 自行翻译
  const SUPPORTED_LANGS = ['zh-CN', 'zh-TW', 'en', 'ru'];
  const LANG_STORE_KEY = 'cli-proxy-language';

  function detectLang() {
    const domLang = document.documentElement.lang;
    if (SUPPORTED_LANGS.includes(domLang)) return domLang;
    try {
      const raw = localStorage.getItem(LANG_STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const lang = parsed?.state?.language ?? parsed?.language ?? parsed;
        if (SUPPORTED_LANGS.includes(lang)) return lang;
      }
    } catch { /* ignore */ }
    const nav = (navigator.languages?.[0] || navigator.language || 'zh-CN').toLowerCase();
    if (['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'].some((p) => nav.startsWith(p))) return 'zh-TW';
    if (nav.startsWith('zh')) return 'zh-CN';
    if (nav.startsWith('ru')) return 'ru';
    return 'en';
  }

  // 命名约定对齐上游：section.key，插值用 {{var}}
  const I18N = {
    'zh-CN': {
      'time.exhausted': '已耗尽',
      'time.day': '天',
      'time.hour': '小时',
      'time.minute': '分',
      'time.requests_suffix': '次',
      'card.used_this_cycle': '本周期已用',
      'card.total_limit': '总额度',
      'card.remaining_prefix': '剩',
      'card.not_used': '尚未使用',
      'card.estimated_limit': '估算总额度',
      'card.estimated_sample_note': '（参考同周期 {{count}} 个账号中位数）',
      'card.exhaust_warning': '⚠ 提前耗尽预警',
      'card.exhaust_in': '{{time}}后用完',
      'card.exhaust_early': '（早 {{time}}）',
      'summary.aggregate_title': 'Codex 周期用量聚合（{{active}} 个活跃账号{{estimated}}）',
      'summary.estimated_accounts_suffix': ' + {{count}} 个估算账号',
      'summary.used_label': '已用',
      'summary.total_label': '总额度',
      'summary.remaining_label': '剩余',
      'summary.incl_estimate': '（含估算 {{tokens}}）',
      'summary.exhaust_predict': '⚠ 按当前合并速度预计 {{time}} 耗尽（早 {{early}}）',
      'summary.no_exhaust': '预计周期内不会耗尽',
      'summary.badge_cycle': '周期',
      'summary.badge_est_accounts': '估 {{count}} 账号',
      'summary.badge_excluded_accounts': '剔除 {{count}} 异常',
      'summary.badge_exhaust_in': '⚠ {{time}}后耗尽',
    },
    'zh-TW': {
      'time.exhausted': '已耗盡',
      'time.day': '天',
      'time.hour': '小時',
      'time.minute': '分',
      'time.requests_suffix': '次',
      'card.used_this_cycle': '本週期已用',
      'card.total_limit': '總額度',
      'card.remaining_prefix': '剩',
      'card.not_used': '尚未使用',
      'card.estimated_limit': '估算總額度',
      'card.estimated_sample_note': '（參考同週期 {{count}} 個帳號中位數）',
      'card.exhaust_warning': '⚠ 提前耗盡預警',
      'card.exhaust_in': '{{time}}後用完',
      'card.exhaust_early': '（早 {{time}}）',
      'summary.aggregate_title': 'Codex 週期用量聚合（{{active}} 個活躍帳號{{estimated}}）',
      'summary.estimated_accounts_suffix': ' + {{count}} 個估算帳號',
      'summary.used_label': '已用',
      'summary.total_label': '總額度',
      'summary.remaining_label': '剩餘',
      'summary.incl_estimate': '（含估算 {{tokens}}）',
      'summary.exhaust_predict': '⚠ 按目前合併速度預計 {{time}} 耗盡（早 {{early}}）',
      'summary.no_exhaust': '預計週期內不會耗盡',
      'summary.badge_cycle': '週期',
      'summary.badge_est_accounts': '估 {{count}} 帳號',
      'summary.badge_excluded_accounts': '剔除 {{count}} 異常',
      'summary.badge_exhaust_in': '⚠ {{time}}後耗盡',
    },
    en: {
      'time.exhausted': 'Exhausted',
      'time.day': 'd',
      'time.hour': 'h',
      'time.minute': 'm',
      'time.requests_suffix': 'times',
      'card.used_this_cycle': 'Used this cycle',
      'card.total_limit': 'Total limit',
      'card.remaining_prefix': 'Left',
      'card.not_used': 'Not used yet',
      'card.estimated_limit': 'Estimated limit',
      'card.estimated_sample_note': '(median of {{count}} same-cycle accounts)',
      'card.exhaust_warning': '⚠ Early exhaustion warning',
      'card.exhaust_in': 'runs out in {{time}}',
      'card.exhaust_early': '({{time}} early)',
      'summary.aggregate_title': 'Codex cycle usage aggregate ({{active}} active{{estimated}})',
      'summary.estimated_accounts_suffix': ' + {{count}} estimated',
      'summary.used_label': 'Used',
      'summary.total_label': 'Total',
      'summary.remaining_label': 'Remaining',
      'summary.incl_estimate': '(incl. estimate {{tokens}})',
      'summary.exhaust_predict': '⚠ At current combined rate, exhausts {{time}} ({{early}} early)',
      'summary.no_exhaust': 'Not expected to exhaust this cycle',
      'summary.badge_cycle': 'Cycle',
      'summary.badge_est_accounts': '~{{count}} acct',
      'summary.badge_excluded_accounts': 'excl {{count}}',
      'summary.badge_exhaust_in': '⚠ exhausts in {{time}}',
    },
    ru: {
      'time.exhausted': 'Исчерпано',
      'time.day': 'д',
      'time.hour': 'ч',
      'time.minute': 'м',
      'time.requests_suffix': 'раз',
      'card.used_this_cycle': 'Использовано за цикл',
      'card.total_limit': 'Общий лимит',
      'card.remaining_prefix': 'Ост.',
      'card.not_used': 'Ещё не использовалось',
      'card.estimated_limit': 'Оценочный лимит',
      'card.estimated_sample_note': '(медиана по {{count}} аккаунтам того же цикла)',
      'card.exhaust_warning': '⚠ Раннее исчерпание',
      'card.exhaust_in': 'закончится через {{time}}',
      'card.exhaust_early': '({{time}} ранее)',
      'summary.aggregate_title': 'Суммарное использование за цикл Codex ({{active}} активных{{estimated}})',
      'summary.estimated_accounts_suffix': ' + {{count}} расчётных',
      'summary.used_label': 'Использовано',
      'summary.total_label': 'Всего',
      'summary.remaining_label': 'Остаётся',
      'summary.incl_estimate': '(вкл. оценку {{tokens}})',
      'summary.exhaust_predict': '⚠ При текущей суммарной скорости закончится {{time}} (на {{early}} раньше)',
      'summary.no_exhaust': 'В этом цикле не ожидается исчерпание',
      'summary.badge_cycle': 'Цикл',
      'summary.badge_est_accounts': '~{{count}} акк',
      'summary.badge_excluded_accounts': 'искл {{count}}',
      'summary.badge_exhaust_in': '⚠ закончится через {{time}}',
    },
  };

  function t(key, vars) {
    const lang = detectLang();
    let text = I18N[lang]?.[key] ?? I18N.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(new RegExp('{{' + k + '}}', 'g'), v);
      }
    }
    return text;
  }

  const LOG_PREFIX = '[CPA Codex Helper]';
  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  function parseJSON(text) {
    if (!text || typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  // 安全读 number（兼容 string / null）
  function toNum(v) {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ============================================================
  // localStorage 缓存（持久化 quotaInfo + cycleUsage）
  // ============================================================

  const CACHE_KEY = 'cmp-codex-cycle-cache-v1';
  // 缓存条目最大保留时长：7 天（超过则视为陈旧，loadCache 时丢弃）
  const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const data = parseJSON(raw);
      if (!data || typeof data !== 'object') return;

      const now = Date.now();
      const quotaInfo = data.quotaInfo;
      if (quotaInfo && typeof quotaInfo === 'object') {
        for (const [authIndex, info] of Object.entries(quotaInfo)) {
          if (!info || typeof info !== 'object') continue;
          if (typeof info.capturedAt !== 'number' || now - info.capturedAt > CACHE_MAX_AGE_MS) continue;
          state.quotaInfo.set(authIndex, info);
        }
      }

      const cycleUsage = data.cycleUsage;
      if (cycleUsage && typeof cycleUsage === 'object') {
        for (const [authIndex, usage] of Object.entries(cycleUsage)) {
          if (!usage || typeof usage !== 'object') continue;
          if (typeof usage.fetchedAt !== 'number' || now - usage.fetchedAt > CACHE_MAX_AGE_MS) continue;
          // 降级模式的错误标记不持久化（每次会话要重新探测 analytics 可用性）
          if (usage.error) continue;
          state.cycleUsage.set(authIndex, usage);
        }
      }

      const fileMap = data.fileToAuthIndex;
      if (fileMap && typeof fileMap === 'object') {
        for (const [fileName, authIndex] of Object.entries(fileMap)) {
          if (typeof authIndex === 'string') state.fileToAuthIndex.set(fileName, authIndex);
        }
      }

      const metaMap = data.authFileMeta;
      if (metaMap && typeof metaMap === 'object') {
        for (const [authIndex, meta] of Object.entries(metaMap)) {
          if (!meta || typeof meta !== 'object') continue;
          if (typeof meta.capturedAt !== 'number' || now - meta.capturedAt > CACHE_MAX_AGE_MS) continue;
          state.authFileMeta.set(authIndex, meta);
        }
      }

      log('Loaded cache:', state.quotaInfo.size, 'quota,', state.cycleUsage.size, 'usage,', state.authFileMeta.size, 'meta');
    } catch (e) {
      warn('loadCache failed:', e);
    }
  }

  // 防抖保存，避免高频写 localStorage
  let saveCacheTimer = null;
  function saveCache() {
    if (saveCacheTimer) clearTimeout(saveCacheTimer);
    saveCacheTimer = setTimeout(() => {
      saveCacheTimer = null;
      try {
        // httpStatus 不持久化：它是「最后一次 Codex 调用的 HTTP 结果」，会过时
        // （账号可能已经重新授权或恢复），每次会话必须重新探测
        const quotaInfoForSave = {};
        for (const [k, v] of state.quotaInfo.entries()) {
          if (!v) { quotaInfoForSave[k] = v; continue; }
          const { httpStatus, ...rest } = v;
          quotaInfoForSave[k] = rest;
        }
        const data = {
          savedAt: Date.now(),
          quotaInfo: quotaInfoForSave,
          cycleUsage: Object.fromEntries(state.cycleUsage),
          fileToAuthIndex: Object.fromEntries(state.fileToAuthIndex),
          authFileMeta: Object.fromEntries(state.authFileMeta),
        };
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      } catch (e) {
        warn('saveCache failed:', e);
      }
    }, 500);
  }

  // 从原始 Codex window 对象提取周期信息
  function extractWindowInfo(rateLimit) {
    if (!rateLimit || typeof rateLimit !== 'object') return null;
    // primary 或 secondary，取 longer window（月 > 周 > 5h）
    const candidates = [
      rateLimit.primary_window ?? rateLimit.primaryWindow,
      rateLimit.secondary_window ?? rateLimit.secondaryWindow,
    ].filter(Boolean);

    if (candidates.length === 0) return null;

    // 选 limitWindowSeconds 最大的窗口（月窗口优先于周/5h）
    let best = null;
    for (const w of candidates) {
      const secs = toNum(w.limit_window_seconds ?? w.limitWindowSeconds);
      if (secs == null || secs < MIN_CYCLE_SECONDS) continue;
      if (!best || secs > best.limitWindowSeconds) {
        best = {
          limitWindowSeconds: secs,
          usedPercent: toNum(w.used_percent ?? w.usedPercent),
          resetAtSec: toNum(w.reset_at ?? w.resetAt),
          resetAfterSec: toNum(w.reset_after_seconds ?? w.resetAfterSeconds),
        };
      }
    }
    if (!best) return null;

    // 算 resetAtMs
    let resetAtMs = null;
    if (best.resetAtSec && best.resetAtSec > 0) {
      resetAtMs = best.resetAtSec * 1000;
    } else if (best.resetAfterSec && best.resetAfterSec > 0) {
      resetAtMs = Date.now() + best.resetAfterSec * 1000;
    }
    if (!resetAtMs) return null;

    return {
      resetAtMs,
      usedPercent: best.usedPercent,
      limitWindowSeconds: best.limitWindowSeconds,
    };
  }

  // 从 api-call 请求体读 authIndex 和目标 url
  function parseApiCallBody(bodyText) {
    const body = parseJSON(bodyText);
    if (!body || typeof body !== 'object') return null;
    return {
      authIndex: body.authIndex ?? body.auth_index ?? null,
      url: body.url ?? null,
    };
  }

  // 从 api-call 响应体读 Codex 周期信息
  function parseApiCallResponse(bodyText) {
    const body = parseJSON(bodyText);
    if (!body || typeof body !== 'object') return null;

    // api-call 响应结构：{ status_code, body: <CodexUsagePayload 或 string>, bodyText }
    const inner = body.body ?? null;
    let payload = inner;
    if (typeof inner === 'string') {
      payload = parseJSON(inner);
    }
    if (!payload || typeof payload !== 'object') return null;

    // rate_limit 或 code_review_rate_limit
    const rl =
      payload.rate_limit ?? payload.rateLimit ??
      payload.code_review_rate_limit ?? payload.codeReviewRateLimit;
    const info = extractWindowInfo(rl);
    if (!info) return null;

    const statusCode = body.status_code ?? body.statusCode;
    return {
      ...info,
      httpStatus: typeof statusCode === 'number' ? statusCode : null,
    };
  }

  // 格式化 token 数：1234567 -> "1.2M"
  function formatTokens(n) {
    if (n == null || !Number.isFinite(n)) return '--';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  // 格式化 $：5.2 -> "$5.20"
  function formatCost(n) {
    if (n == null || !Number.isFinite(n)) return '--';
    return '$' + n.toFixed(2);
  }

  // 格式化剩余毫秒：259200000 -> "3天 0小时"；负数 -> "已耗尽"
  function formatRemainingMs(ms) {
    if (ms == null || !Number.isFinite(ms)) return '--';
    if (ms <= 0) return t('time.exhausted');
    const seconds = Math.floor(ms / 1000);
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return d + t('time.day') + (h > 0 ? ' ' + h + t('time.hour') : '');
    if (h > 0) return h + t('time.hour') + (m > 0 ? ' ' + m + t('time.minute') : '');
    return m + t('time.minute');
  }

  // 格式化时间戳：日期 + 时分，locale 跟随页面语言
  function formatDateTime(ms) {
    if (ms == null || !Number.isFinite(ms)) return '--';
    const d = new Date(ms);
    const locale = detectLang();
    return d.toLocaleDateString(locale) + ' ' + d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }

  // ============================================================
  // XHR Hook —— 抓 Authorization、auth-files 映射、Codex 配额响应
  // ============================================================

  function installXHRHook() {
    const OrigXHR = window.XMLHttpRequest;
    if (!OrigXHR) return;

    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    const origSetHeader = OrigXHR.prototype.setRequestHeader;

    OrigXHR.prototype.open = function (method, url, ...rest) {
      this.__cmpMethod = (method || 'GET').toUpperCase();
      this.__cmpUrl = String(url || '');
      // 从已发的 management 请求推导 apiBase（含 origin + /v0/management）
      if (!state.apiBase && this.__cmpUrl.includes(MGMT_PREFIX)) {
        const idx = this.__cmpUrl.indexOf(MGMT_PREFIX);
        const base = this.__cmpUrl.slice(0, idx + MGMT_PREFIX.length);
        if (base) {
          state.apiBase = base;
          log('Captured apiBase:', base);
        }
      }
      return origOpen.call(this, method, url, ...rest);
    };

    OrigXHR.prototype.setRequestHeader = function (name, value) {
      // 抓 Authorization
      if (name && /^authorization$/i.test(name) && typeof value === 'string') {
        const token = value.replace(/^Bearer\s+/i, '').trim();
        if (token && token !== '$TOKEN$' && state.authToken !== token) {
          state.authToken = token;
          log('Captured auth token');
        }
      }
      return origSetHeader.call(this, name, value);
    };

    OrigXHR.prototype.send = function (body) {
      this.__cmpReqBody = body;

      // 对 api-call 请求：暂存请求体供响应时关联 authIndex
      if (this.__cmpUrl && this.__cmpUrl.includes(API_CALL_PATH) && this.__cmpMethod === 'POST') {
        const parsed = parseApiCallBody(typeof body === 'string' ? body : '');
        if (parsed && parsed.url === CODEX_USAGE_URL && parsed.authIndex) {
          this.__cmpCodexAuthIndex = parsed.authIndex;
        }
      }

      this.addEventListener('load', function () {
        try {
          handleXHRResponse(this);
        } catch (e) {
          warn('XHR response handler error:', e);
        }
      });

      return origSend.call(this, body);
    };

    log('XHR hook installed');
  }

  function handleXHRResponse(xhr) {
    const url = xhr.__cmpUrl || '';
    const respText = xhr.responseText || '';

    // 1) auth-files 响应 —— 建 fileName -> authIndex 映射，并清理已删除账号的陈旧缓存
    //    服务端返回的是当前文件全集，作为 ground truth 对本地四个 Map 做全量 reconcile；
    //    否则删除账号后 quotaInfo/cycleUsage/authFileMeta 残留，聚合统计（computeAggregateStats）
    //    仍会累加已删账号，导致标题徽章的总额度不下降。
    if (url.includes(AUTH_FILES_PATH) && respText) {
      const data = parseJSON(respText);
      const files = data?.files ?? data?.data?.files ?? null;
      if (Array.isArray(files)) {
        const freshFileMap = new Map();
        const freshAuthIndices = new Set();
        const freshMeta = new Map();
        const now = Date.now();
        for (const f of files) {
          const name = f.name ?? f.file_name ?? f.fileName;
          const ai = f.auth_index ?? f.authIndex ?? f['auth-index'];
          if (name && ai) {
            const aiStr = String(ai);
            freshFileMap.set(name, aiStr);
            freshAuthIndices.add(aiStr);
            const rawStatusMsg = f.status_message ?? f.statusMessage ?? f['status-message'];
            freshMeta.set(aiStr, {
              disabled: f.disabled === true || f.Disabled === true,
              status: typeof (f.status ?? f.state) === 'string' ? String(f.status ?? f.state) : null,
              unavailable: f.unavailable === true || f.Unavailable === true,
              statusMessage: typeof rawStatusMsg === 'string' ? rawStatusMsg : '',
              capturedAt: now,
            });
          }
        }

        // 全量 reconcile：删除不在本次响应里的陈旧条目
        // （文件改名 → 旧 fileName 移除；账号删除 → 对应 authIndex 四处同步清理）
        // 空响应视为「无数据」（可能是筛选/异常结果），跳过清理避免误删全部
        let pruned = 0;
        if (freshAuthIndices.size > 0) {
          for (const fname of [...state.fileToAuthIndex.keys()]) {
            if (!freshFileMap.has(fname)) { state.fileToAuthIndex.delete(fname); pruned++; }
          }
          for (const ai of [...state.quotaInfo.keys()]) {
            if (!freshAuthIndices.has(ai)) { state.quotaInfo.delete(ai); pruned++; }
          }
          for (const ai of [...state.cycleUsage.keys()]) {
            if (!freshAuthIndices.has(ai)) { state.cycleUsage.delete(ai); pruned++; }
          }
          for (const ai of [...state.authFileMeta.keys()]) {
            if (!freshAuthIndices.has(ai)) { state.authFileMeta.delete(ai); pruned++; }
          }
        }

        let added = 0;
        let metaUpdated = 0;
        for (const [name, ai] of freshFileMap) {
          if (!state.fileToAuthIndex.has(name)) added++;
          state.fileToAuthIndex.set(name, ai);
        }
        for (const [ai, meta] of freshMeta) {
          const prev = state.authFileMeta.get(ai);
          if (!prev || prev.disabled !== meta.disabled || prev.status !== meta.status
              || prev.unavailable !== meta.unavailable || prev.statusMessage !== meta.statusMessage) {
            metaUpdated++;
          }
          state.authFileMeta.set(ai, meta);
        }

        if (added > 0 || pruned > 0 || metaUpdated > 0) {
          log('Mapped', added, 'files to authIndex; pruned', pruned, 'stale entries; meta updated for', metaUpdated);
          saveCache();
          scheduleInjection();
        }
      }
      return;
    }

    // 2) Codex 配额响应 —— 提取 resetAt / usedPercent / limitWindowSeconds
    if (xhr.__cmpCodexAuthIndex && respText) {
      const info = parseApiCallResponse(respText);
      if (info) {
        // 找 fileName（通过 authIndex 反查）
        let fileName = null;
        for (const [fname, ai] of state.fileToAuthIndex) {
          if (ai === xhr.__cmpCodexAuthIndex) { fileName = fname; break; }
        }
        state.quotaInfo.set(xhr.__cmpCodexAuthIndex, {
          ...info,
          authIndex: xhr.__cmpCodexAuthIndex,
          fileName,
          capturedAt: Date.now(),
        });
        log('Captured quota for', xhr.__cmpCodexAuthIndex, info);
        saveCache();

        // 触发该账号的 analytics 请求
        fetchCycleUsage(xhr.__cmpCodexAuthIndex);
      }
    }
  }

  // ============================================================
  // 周期用量获取 —— 调 monitoring/analytics
  // ============================================================

  function computeCycleBounds(info) {
    if (!info || !info.resetAtMs || !info.limitWindowSeconds) return null;
    const cycleEndMs = info.resetAtMs;
    const cycleStartMs = cycleEndMs - info.limitWindowSeconds * 1000;
    return { cycleStartMs, cycleEndMs };
  }

  // 缓存命中阈值：5 分钟内的数据直接复用，不重新调 analytics
  const CACHE_HIT_MS = 5 * 60 * 1000;

  async function fetchCycleUsage(authIndex) {
    // 降级模式：已确认 analytics 端点不可用（CPA 原生前端），不再重试
    if (state.analyticsAvailable === false) return;
    if (state.pendingAnalytics.has(authIndex)) return;

    // 缓存命中：5 分钟内的数据直接复用，跳过网络请求
    const cached = state.cycleUsage.get(authIndex);
    if (cached && !cached.error && cached.tokens != null) {
      const age = Date.now() - (cached.fetchedAt || 0);
      if (age < CACHE_HIT_MS) {
        log('Cache hit for', authIndex, '(age', Math.round(age / 1000) + 's)');
        scheduleInjection();
        return;
      }
    }

    if (!state.authToken) {
      warn('No auth token yet, skip analytics');
      return;
    }
    if (!state.apiBase) {
      warn('No apiBase yet, skip analytics');
      return;
    }

    const info = state.quotaInfo.get(authIndex);
    if (!info) return;

    const bounds = computeCycleBounds(info);
    if (!bounds) return;

    const now = Date.now();
    const fromMs = bounds.cycleStartMs;
    const toMs = Math.min(now, bounds.cycleEndMs);

    // 服务端 handler.go 严格校验：from_ms > 0 && to_ms > 0 && from_ms < to_ms
    if (!Number.isFinite(fromMs) || fromMs <= 0 || !Number.isFinite(toMs) || toMs <= 0 || fromMs >= toMs) {
      state.cycleUsage.set(authIndex, { tokens: 0, cost: 0, requests: 0, fetchedAt: now, error: null });
      scheduleInjection();
      return;
    }

    state.pendingAnalytics.add(authIndex);

    const payload = {
      from_ms: fromMs,
      to_ms: toMs,
      now_ms: now,
      filters: { auth_indices: [authIndex] },
      include: { summary: true },
    };

    // 拼绝对 URL：apiBase + 去重前缀的 ANALYTICS_PATH
    const pathSuffix = ANALYTICS_PATH.replace(MGMT_PREFIX, '');
    const url = state.apiBase.replace(/\/+$/, '') + pathSuffix;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + state.authToken,
        },
        body: JSON.stringify(payload),
      });

      if (resp.status === 404) {
        // CPA 原生前端无此端点 —— 进入降级模式，本次会话不再重试
        state.analyticsAvailable = false;
        warn('Analytics endpoint 404, entering degraded mode (CPA native frontend?)');
        state.cycleUsage.set(authIndex, { tokens: null, cost: null, requests: null, fetchedAt: now, error: 'degraded' });
        scheduleInjection();
        return;
      }

      if (!resp.ok) {
        throw new Error('HTTP ' + resp.status);
      }

      state.analyticsAvailable = true;
      const data = await resp.json();
      const summary = data?.summary ?? {};
      const tokens = toNum(summary.total_tokens) ?? 0;
      const cost = toNum(summary.total_cost) ?? 0;
      const requests = toNum(summary.total_calls) ?? 0;

      state.cycleUsage.set(authIndex, { tokens, cost, requests, fetchedAt: now, error: null });
      log('Cycle usage for', authIndex, { tokens, cost, requests });
      saveCache();
    } catch (e) {
      warn('Analytics fetch failed for', authIndex, e);
      state.cycleUsage.set(authIndex, { tokens: null, cost: null, requests: null, fetchedAt: now, error: String(e.message || e) });
    } finally {
      state.pendingAnalytics.delete(authIndex);
      scheduleInjection();
    }
  }

  // ============================================================
  // 额度推算 —— 用 Codex 权威 usedPercent 反推总额度
  // ============================================================

  // 判定一个账号是否「真实有消耗且能反推总额度」
  // 用于估算未使用账号额度时的样本来源
  function hasUsablePrediction(authIndex) {
    const usage = state.cycleUsage.get(authIndex);
    if (!usage || usage.error != null || usage.tokens == null || usage.tokens === 0) return false;
    const info = state.quotaInfo.get(authIndex);
    return !!(info && info.usedPercent && info.usedPercent > 0.01);
  }

  // 按 limitWindowSeconds 分组，给出每组「真实反推」账号的 token/cost 额度中位数
  // 未使用账号按自己的周期窗口查同一组的样本，避免月/周窗口混用
  function computeMedianLimitsByWindow() {
    // windowSeconds -> { tokens: number[], costs: number[] }
    const buckets = new Map();

    for (const authIndex of state.quotaInfo.keys()) {
      if (!hasUsablePrediction(authIndex)) continue;
      const info = state.quotaInfo.get(authIndex);
      const usage = state.cycleUsage.get(authIndex);
      const ratio = info.usedPercent / 100;
      const totalTokens = usage.tokens / ratio;
      const totalCost = usage.cost != null ? usage.cost / ratio : null;

      let bucket = buckets.get(info.limitWindowSeconds);
      if (!bucket) {
        bucket = { tokens: [], costs: [] };
        buckets.set(info.limitWindowSeconds, bucket);
      }
      bucket.tokens.push(totalTokens);
      if (totalCost != null) bucket.costs.push(totalCost);
    }

    // 转中位数（比均值抗异常值）
    const result = new Map(); // windowSeconds -> { medianTokens, medianCost, sampleCount }
    for (const [window, bucket] of buckets.entries()) {
      const sortedT = bucket.tokens.slice().sort((a, b) => a - b);
      const sortedC = bucket.costs.slice().sort((a, b) => a - b);
      const mid = (arr) => (arr.length === 0 ? null : arr.length % 2 === 1
        ? arr[(arr.length - 1) / 2]
        : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2);
      result.set(window, {
        medianTokens: mid(sortedT),
        medianCost: mid(sortedC),
        sampleCount: bucket.tokens.length,
      });
    }
    return result;
  }

  // 给未使用账号估算总额度：查同周期窗口的中位数
  // 返回 null 表示没有可用样本（同组无消耗账号）
  function computeEstimatedLimit(info) {
    if (!info || !info.limitWindowSeconds) return null;
    const medians = computeMedianLimitsByWindow();
    const bucket = medians.get(info.limitWindowSeconds);
    if (!bucket || bucket.medianTokens == null) return null;
    return {
      totalTokens: bucket.medianTokens,
      totalCost: bucket.medianCost,
      sampleCount: bucket.sampleCount,
    };
  }

  function computePrediction(info, usage) {
    if (!info || !usage || usage.tokens == null) return null;

    const now = Date.now();
    const cycleEndMs = info.resetAtMs;
    const cycleStartMs = cycleEndMs - info.limitWindowSeconds * 1000;
    const totalMs = info.limitWindowSeconds * 1000;
    const elapsedMs = now - cycleStartMs;
    const elapsedRatio = totalMs > 0 ? elapsedMs / totalMs : null;
    const timeElapsedPct = elapsedRatio != null ? Math.max(0, Math.min(1, elapsedRatio)) : null;

    // 核心推算：usedPercent（0~100）是 Codex 基于真实账户状态给出的已用百分比，
    // 配合 usage_events 聚合出的实际已用 token 数，直接反推总额度。
    // 比时间外推靠谱 —— 不管密集用还是均匀用，usedPercent 都反映真实消耗。
    const usedPercent = info.usedPercent;
    let totalTokens = null;
    let totalCost = null;
    let remainingTokens = null;
    let remainingCost = null;
    let calcBasis = '';

    if (usedPercent != null && usedPercent > 0.01 && usage.tokens > 0) {
      // 只有真实有消耗（usage.tokens > 0）才能反推总额度
      // 否则 0 / 0.31 = 0，反推出无意义的 0 总额度
      const ratio = usedPercent / 100;
      totalTokens = usage.tokens / ratio;
      remainingTokens = Math.max(0, totalTokens - usage.tokens);
      if (usage.cost != null) {
        totalCost = usage.cost / ratio;
        remainingCost = Math.max(0, totalCost - usage.cost);
      }
      calcBasis = '基于 Codex 已用百分比 ' + usedPercent.toFixed(1) + '% 反推';
    } else if (usedPercent != null && usedPercent <= 0.01) {
      calcBasis = '已用百分比接近 0，无法反推总额度';
    } else if (usage.tokens === 0) {
      calcBasis = '本周期尚未使用';
    } else {
      calcBasis = 'Codex 未返回已用百分比';
    }

    // 次要参考：按当前速度外推到周期结束
    let paceTokens = null;
    let paceCost = null;
    if (elapsedRatio != null && elapsedRatio > 0.0001 && elapsedRatio < 1) {
      paceTokens = usage.tokens / elapsedRatio;
      paceCost = usage.cost != null ? usage.cost / elapsedRatio : null;
    }

    // 基于当前速度预估额度耗尽时间
    // consumptionRate = 周期内平均每毫秒消耗的 token 数
    // remainingMs = 剩余 token / 消耗速率 = 按当前速度还能用多久
    // exhaustAtMs = now + remainingMs
    let consumptionRate = null;
    let remainingMs = null;
    let exhaustAtMs = null;
    // 'exhausted' | 'will_exhaust'（早于周期结束耗尽）| 'safe'（周期内不会耗尽）| null
    let exhaustStatus = null;

    if (elapsedMs > 0 && remainingTokens != null && remainingTokens > 0 && usage.tokens > 0) {
      consumptionRate = usage.tokens / elapsedMs;
      if (consumptionRate > 0) {
        remainingMs = remainingTokens / consumptionRate;
        exhaustAtMs = now + remainingMs;
        if (exhaustAtMs <= cycleEndMs) {
          exhaustStatus = 'will_exhaust';
        } else {
          exhaustStatus = 'safe';
        }
      }
    } else if (usage.tokens > 0 && remainingTokens != null && remainingTokens <= 0) {
      // 真耗尽：用过且剩余为 0（区别于「没用过」的 remainingTokens 也为 0）
      exhaustStatus = 'exhausted';
    }

    return {
      timeElapsedPct,
      totalTokens,
      totalCost,
      remainingTokens,
      remainingCost,
      calcBasis,
      paceTokens,
      paceCost,
      consumptionRate,
      remainingMs,
      exhaustAtMs,
      exhaustStatus,
      cycleStartMs,
      cycleEndMs,
    };
  }

  // ============================================================
  // DOM 注入 —— MutationObserver + 找 Codex 卡片 + 插入周期行
  // ============================================================

  let injectScheduled = false;
  function scheduleInjection() {
    if (injectScheduled) return;
    injectScheduled = true;
    requestAnimationFrame(() => {
      injectScheduled = false;
      injectAll();
    });
  }

  // ============================================================
  // 区块标题聚合统计
  // ============================================================

  // 判定账号是否应计入聚合统计
  // 剔除规则：unavailable（瞬时不可用，如配额耗尽/限流）、status==='error'（异常，如需重新授权）、
  // httpStatus>=400（api-call 代理 Codex 返回非 2xx）
  // 保留规则：disabled（操作员手动禁用，仍保留额度）、pending/refreshing/unknown（瞬时中间态）
  function isAccountIncludedInAggregate(authIndex) {
    const meta = state.authFileMeta.get(authIndex);
    if (meta) {
      if (meta.unavailable === true) return false;
      if (meta.status === 'error') return false;
    }
    const info = state.quotaInfo.get(authIndex);
    if (info && typeof info.httpStatus === 'number' && info.httpStatus >= 400) return false;
    return true;
  }

  // 遍历所有 Codex 账号的缓存数据，算出总已用 + 总额度
  // - 真实反推账号：used / (usedPercent/100)
  // - 未使用账号：用同周期窗口的中位数估算（计入 estimatedAccounts）
  function computeAggregateStats() {
    let totalUsedTokens = 0;
    let totalUsedCost = 0;
    let totalLimitTokens = 0;
    let totalLimitCost = 0;
    let accountCount = 0;          // 真实反推账号数
    let estimatedAccounts = 0;     // 估算额度账号数
    let estimatedLimitTokens = 0;  // 估算账号贡献的额度（用于 UI 提示）
    let excludedAccounts = 0;      // 因异常状态被剔除的账号数

    for (const [authIndex, usage] of state.cycleUsage.entries()) {
      const info = state.quotaInfo.get(authIndex);
      if (!info) continue;

      if (!isAccountIncludedInAggregate(authIndex)) {
        excludedAccounts++;
        continue;
      }

      if (usage && usage.error == null && usage.tokens != null && usage.tokens > 0
          && info.usedPercent && info.usedPercent > 0.01) {
        // 真实反推
        totalUsedTokens += usage.tokens;
        if (usage.cost != null) totalUsedCost += usage.cost;
        const ratio = info.usedPercent / 100;
        totalLimitTokens += usage.tokens / ratio;
        if (usage.cost != null) totalLimitCost += usage.cost / ratio;
        accountCount++;
      } else {
        // 未使用账号：估算
        const est = computeEstimatedLimit(info);
        if (est && est.totalTokens != null) {
          totalLimitTokens += est.totalTokens;
          if (est.totalCost != null) totalLimitCost += est.totalCost;
          estimatedLimitTokens += est.totalTokens;
          estimatedAccounts++;
        }
      }
    }

    return {
      totalUsedTokens,
      totalUsedCost,
      totalLimitTokens,
      totalLimitCost,
      accountCount,
      estimatedAccounts,
      estimatedLimitTokens,
      excludedAccounts,
    };
  }

  const SUMMARY_SPAN_ID = 'cmp-cycle-aggregate-summary';

  function injectSectionSummary() {
    if (state.analyticsAvailable === false) return;

    // 找 Codex 区块的卡片容器（class 含 codexGrid），然后回溯到 Card 组件根节点找标题
    // codexGrid 在 QuotaSection.tsx:459 的 <div className={config.gridClassName}>
    const codexGrid = document.querySelector('[class*="codexGrid"]');
    if (!codexGrid) return;

    // Card 组件的标题区域 .titleWrapper 含「Codex 额度」文本
    // 由于页面有多个 provider 的 titleWrapper，需要找包含 codex 文本的
    const titleWrappers = document.querySelectorAll('[class*="titleWrapper"]');
    let codexTitleWrapper = null;
    for (const tw of titleWrappers) {
      const text = tw.textContent || '';
      if (/codex/i.test(text)) {
        codexTitleWrapper = tw;
        break;
      }
    }
    if (!codexTitleWrapper) return;

    const stats = computeAggregateStats();
    if (stats.accountCount === 0 && stats.estimatedAccounts === 0) {
      // 没有任何有效数据 —— 移除可能存在的旧统计
      const existing = codexTitleWrapper.querySelector('#' + SUMMARY_SPAN_ID);
      if (existing) existing.remove();
      return;
    }

    const remainTokens = Math.max(0, stats.totalLimitTokens - stats.totalUsedTokens);
    const remainCost = Math.max(0, stats.totalLimitCost - stats.totalUsedCost);
    const usedPct = stats.totalLimitTokens > 0
      ? (stats.totalUsedTokens / stats.totalLimitTokens) * 100
      : 0;

    const tokensStr = formatTokens(stats.totalUsedTokens) + ' / ' + formatTokens(stats.totalLimitTokens);
    const costStr = formatCost(stats.totalUsedCost) + ' / ' + formatCost(stats.totalLimitCost);
    const remainTokensStr = formatTokens(remainTokens);
    const remainCostStr = formatCost(remainCost);
    const pctStr = usedPct.toFixed(1) + '%';

    // 聚合耗尽预估：合并所有真实账号的消耗速率（未使用账号速率为 0，不贡献）
    // exhaustAtMs = now + realRemainingTokens / totalRate
    // 仅在有活跃消耗（totalRate > 0）且预估早于所有账号最晚 cycleEnd 时给出预警
    //
    // 分子必须只用真实账号的剩余额度，不能直接用 stats.totalLimitTokens - totalUsedTokens：
    // 后者包含未使用账号的估算额度，但分母 aggregateRate 只来自真实账号（tokens===0 被跳过），
    // 分子分母来自不同账号集合会让预估时间被严重拉长。
    let aggregateRate = 0;
    let realRemainingTokens = 0;
    let latestCycleEndMs = 0;
    for (const [authIndex, usage] of state.cycleUsage.entries()) {
      if (!usage || usage.error != null || usage.tokens == null || usage.tokens === 0) continue;
      if (!isAccountIncludedInAggregate(authIndex)) continue;
      const info = state.quotaInfo.get(authIndex);
      if (!info || !info.usedPercent || info.usedPercent <= 0.01) continue;
      const ratio = info.usedPercent / 100;
      const limitForThis = usage.tokens / ratio;
      realRemainingTokens += Math.max(0, limitForThis - usage.tokens);
      const cycleStartMs = info.resetAtMs - info.limitWindowSeconds * 1000;
      const elapsedMs = Date.now() - cycleStartMs;
      if (elapsedMs > 0) aggregateRate += usage.tokens / elapsedMs;
      if (info.resetAtMs > latestCycleEndMs) latestCycleEndMs = info.resetAtMs;
    }
    let aggregateExhaustAtMs = null;
    let aggregateExhaustEarlyMs = null;
    if (aggregateRate > 0 && realRemainingTokens > 0) {
      const remainingMs = realRemainingTokens / aggregateRate;
      aggregateExhaustAtMs = Date.now() + remainingMs;
      if (latestCycleEndMs > 0 && aggregateExhaustAtMs < latestCycleEndMs) {
        aggregateExhaustEarlyMs = latestCycleEndMs - aggregateExhaustAtMs;
      }
    }

    // 根据使用率选颜色（参考原卡片进度条阈值 30/70）
    let color = 'var(--success-color, #22c55e)';
    if (usedPct >= 70) color = 'var(--danger-color, #ef4444)';
    else if (usedPct >= 30) color = 'var(--quota-medium-color, #e6a23c)';

    let span = codexTitleWrapper.querySelector('#' + SUMMARY_SPAN_ID);
    if (!span) {
      span = document.createElement('span');
      span.id = SUMMARY_SPAN_ID;
      span.style.cssText = [
        'display: inline-flex',
        'align-items: center',
        'padding: 2px 10px',
        'border-radius: 999px',
        'font-size: 12px',
        'font-weight: 600',
        'font-variant-numeric: tabular-nums',
        'color: ' + color,
        'background-color: color-mix(in srgb, ' + color + ' 12%, transparent)',
        'border: 1px solid color-mix(in srgb, ' + color + ' 30%, transparent)',
        'cursor: help',
        'white-space: nowrap',
      ].join('; ');
      codexTitleWrapper.appendChild(span);
    } else {
      // 动态更新颜色
      span.style.color = color;
      span.style.backgroundColor = 'color-mix(in srgb, ' + color + ' 12%, transparent)';
      span.style.borderColor = 'color-mix(in srgb, ' + color + ' 30%, transparent)';
    }

    const estimatedSuffix = stats.estimatedAccounts > 0
      ? t('summary.estimated_accounts_suffix', { count: stats.estimatedAccounts })
      : '';
    const inclEstimate = stats.estimatedAccounts > 0
      ? ' ' + t('summary.incl_estimate', { tokens: formatTokens(stats.estimatedLimitTokens) })
      : '';

    span.title = [
      t('summary.aggregate_title', { active: stats.accountCount, estimated: estimatedSuffix }),
      t('summary.used_label') + ': ' + formatTokens(stats.totalUsedTokens) + ' tokens · ' + formatCost(stats.totalUsedCost),
      t('summary.total_label') + ': ' + formatTokens(stats.totalLimitTokens) + ' tokens · ' + formatCost(stats.totalLimitCost) + inclEstimate,
      t('summary.remaining_label') + ': ' + remainTokensStr + ' tokens · ' + remainCostStr,
      aggregateExhaustEarlyMs != null
        ? t('summary.exhaust_predict', { time: formatDateTime(aggregateExhaustAtMs), early: formatRemainingMs(aggregateExhaustEarlyMs) })
        : t('summary.no_exhaust'),
    ].join('\n');

    let summaryText = t('summary.badge_cycle') + ' ' + tokensStr + ' · ' + costStr + ' · ' + pctStr;
    if (stats.estimatedAccounts > 0) {
      summaryText += ' · ' + t('summary.badge_est_accounts', { count: stats.estimatedAccounts });
    }
    if (stats.excludedAccounts > 0) {
      summaryText += ' · ' + t('summary.badge_excluded_accounts', { count: stats.excludedAccounts });
    }
    if (aggregateExhaustEarlyMs != null) {
      // 徽章显示「X 天后耗尽」—— 必须用真正剩余时间（exhaustAt - now），
      // 不能用 aggregateExhaustEarlyMs（那是「比周期结束早多少」，会被误解为剩余时间）
      const realBadgeRemainingMs = Math.max(0, aggregateExhaustAtMs - Date.now());
      summaryText += ' · ' + t('summary.badge_exhaust_in', { time: formatRemainingMs(realBadgeRemainingMs) });
    }
    span.textContent = summaryText;
  }

  function injectAll() {
    // 找所有 Codex 卡片：class 含 codexCard 的 div
    const cards = document.querySelectorAll('[class*="codexCard"]');
    if (!cards || cards.length === 0) return;

    for (const card of cards) {
      injectCard(card);
    }

    // 注入区块标题聚合统计
    injectSectionSummary();
  }

  function injectCard(card) {
    // 降级模式（analytics 不可用）：完全不注入，保留原卡片原貌
    if (state.analyticsAvailable === false) return;

    const fileNameEl = card.querySelector('[class*="fileName"]');
    if (!fileNameEl) return;
    const fileName = fileNameEl.textContent?.trim();
    if (!fileName) return;

    const authIndex = state.fileToAuthIndex.get(fileName);
    if (!authIndex) {
      // fileName 在卡片里但不在 fileToAuthIndex 映射里 —— 可能 auth-files 响应还没到
      return;
    }

    const info = state.quotaInfo.get(authIndex);
    const usage = state.cycleUsage.get(authIndex);

    // 有 quotaInfo 但还没有 cycleUsage：主动触发 analytics 获取
    // 覆盖「页面刚加载、缓存命中 quotaInfo、但 cycleUsage 还没拉」的场景
    if (info && !usage && !state.pendingAnalytics.has(authIndex)) {
      fetchCycleUsage(authIndex);
    }

    const section = card.querySelector('[class*="quotaSection"]');
    if (!section) return;

    const hasRealUsage = usage && usage.error == null && usage.tokens != null && usage.tokens > 0;
    const hasEstimate = !hasRealUsage && !!info && !!computeEstimatedLimit(info);
    if (!hasRealUsage && !hasEstimate) {
      const existingRow = section.querySelector('.' + ROW_CLASS);
      if (existingRow) existingRow.remove();
      return;
    }

    let row = section.querySelector('.' + ROW_CLASS);
    const isNew = !row;
    if (isNew) {
      row = document.createElement('div');
      row.className = ROW_CLASS;
      row.setAttribute(INJECTED_FLAG, '1');
    }

    // 找稳定的锚点：quotaSection 的直接子元素中，最后一个含 quotaRow 类的元素
    // 注意 [class*="quotaRow"] 会误匹配 .quotaRowHeader，所以必须用 :scope > 限定直接子元素
    const originalRows = section.querySelectorAll(':scope > [class*="quotaRow"]:not(.' + ROW_CLASS + ')');
    const planRow = section.querySelector(':scope > [class*="codexPlan"]');
    // idle 状态下的「点击此处刷新额度」按钮 / loading 消息
    const idleMessage = section.querySelector(':scope > [class*="quotaMessage"]');
    let anchor = null;
    if (originalRows.length > 0) {
      anchor = originalRows[originalRows.length - 1];
    } else if (planRow) {
      anchor = planRow;
    } else if (idleMessage) {
      anchor = idleMessage;
    }

    if (anchor) {
      // 插到锚点之后 —— 每次 injectCard 都重新校正位置，对抗 React 重渲染导致的顺序错乱
      if (anchor.nextElementSibling !== row) {
        anchor.insertAdjacentElement('afterend', row);
      }
    } else if (row.parentNode !== section) {
      section.appendChild(row);
    }

    updateRow(row, info, usage);
  }

  // 从原卡片元素读取 CSS module 实际类名（如 "QuotaPage_quotaRow__a1b2c"）
  // CSS module 会保留原字段名作为子串，所以用 "quotaRow" 去匹配 classList 里的每一项
  function readOriginalClasses(card) {
    const result = {};
    const fields = [
      'quotaRowHeader',
      'quotaRow',
      'quotaMeta',
      'quotaModel',
      'quotaPercent',
      'quotaReset',
      'quotaAmount',
      'codexPlanLabel',
      'codexPlanValue',
      'codexPlan',
    ];
    for (const field of fields) {
      const el = card.querySelector('[class*="' + field + '"]');
      if (el) {
        for (const cls of el.classList) {
          if (cls.includes(field)) {
            result[field] = cls;
            break;
          }
        }
      }
    }
    return result;
  }

  // 全局缓存已读取的类名（同页面所有 Codex 卡片共享同一 CSS module）
  // 但要等原卡片至少有 quotaRow 后才缓存，否则缓存空对象会永久失效
  let cachedClasses = null;

  function getCachedClasses() {
    if (cachedClasses && cachedClasses.quotaRow) return cachedClasses;
    const firstCard = document.querySelector('[class*="codexCard"]');
    if (!firstCard) return null;
    const classes = readOriginalClasses(firstCard);
    if (classes.quotaRow) {
      cachedClasses = classes;
    }
    return classes;
  }

  function updateRow(row, info, usage) {
    // 分支 A：有真实消耗 —— 反推总额度 + 自身速度预测耗尽
    const hasRealUsage = !!info && !!usage && usage.tokens != null && usage.tokens > 0;
    if (hasRealUsage) {
      updateRowWithRealUsage(row, info, usage);
      return;
    }

    // 分支 B：无真实消耗 —— 用同周期窗口样本中位数估算额度，
    // 用样本账号平均消耗速率预测「如果按当前同组平均速度用，何时耗尽」
    if (info) {
      updateRowWithEstimate(row, info);
      return;
    }

    row.innerHTML = '';
  }

  function updateRowWithRealUsage(row, info, usage) {
    const pred = computePrediction(info, usage);
    const cls = getCachedClasses() || {};
    // fallback：原卡片处于 idle 时没有 quotaRow，此时用我们自己的内联类
    // 等用户点刷新后，原卡片渲染出 quotaRow，下次 injectCard 会自动切换回原类名
    const useFallback = !cls.quotaRow;
    const c = (key) => cls[key] || (useFallback ? 'cmp-fallback-' + key : '');

    // 行：本周期用量（token/$/次）—— 原卡片不提供
    const tokensStr = formatTokens(usage.tokens);
    const costStr = formatCost(usage.cost);
    const requestsStr = usage.requests != null ? usage.requests + ' ' + t('time.requests_suffix') : null;
    const usedDetail = [tokensStr, costStr, requestsStr].filter(Boolean).join(' · ');

    row.innerHTML = `
      <div class="${c('quotaRow')}">
        <div class="${c('quotaRowHeader')}">
          <span class="${c('quotaModel')}">${escapeHtml(t('card.used_this_cycle'))}</span>
          <div class="${c('quotaMeta')}">
            <span class="${c('quotaAmount')}">${escapeHtml(usedDetail)}</span>
          </div>
        </div>
      </div>
    `;

    // 总额度反推（基于 Codex usedPercent）
    if (pred && pred.totalTokens != null) {
      const totalTokensStr = formatTokens(pred.totalTokens);
      const totalCostStr = formatCost(pred.totalCost);
      const remainTokensStr = formatTokens(pred.remainingTokens);
      const remainCostStr = formatCost(pred.remainingCost);

      row.innerHTML += `
        <div class="${c('quotaRow')}">
          <div class="${c('quotaRowHeader')}">
            <span class="${c('quotaModel')}">${escapeHtml(t('card.total_limit'))}</span>
            <div class="${c('quotaMeta')}">
              <span class="${c('quotaAmount')}">${totalTokensStr} · ${totalCostStr}</span>
              <span class="${c('quotaReset')}">${escapeHtml(t('card.remaining_prefix'))} ${remainTokensStr} · ${remainCostStr}</span>
            </div>
          </div>
        </div>
      `;
    }

    // 耗尽时间预测（仅在提前耗尽时有预警价值）
    if (pred && pred.exhaustStatus === 'will_exhaust') {
      const remainTimeStr = formatRemainingMs(pred.remainingMs);
      const exhaustDateStr = formatDateTime(pred.exhaustAtMs);
      const earlyMs = pred.cycleEndMs - pred.exhaustAtMs;
      const earlyStr = formatRemainingMs(earlyMs);

      row.innerHTML += `
        <div class="${c('quotaRow')}">
          <div class="${c('quotaRowHeader')}">
            <span class="${c('quotaModel')}" style="color: var(--danger-color);">${escapeHtml(t('card.exhaust_warning'))}</span>
            <div class="${c('quotaMeta')}">
              <span class="${c('quotaPercent')}" style="color: var(--danger-color);">${escapeHtml(t('card.exhaust_in', { time: remainTimeStr }))}</span>
              <span class="${c('quotaReset')}">${escapeHtml(exhaustDateStr)} ${escapeHtml(t('card.exhaust_early', { time: earlyStr }))}</span>
            </div>
          </div>
        </div>
      `;
    }
  }

  function updateRowWithEstimate(row, info) {
    const est = computeEstimatedLimit(info);
    if (!est || est.totalTokens == null) {
      row.innerHTML = '';
      return;
    }

    const cls = getCachedClasses() || {};
    const useFallback = !cls.quotaRow;
    const c = (key) => cls[key] || (useFallback ? 'cmp-fallback-' + key : '');

    const totalTokensStr = formatTokens(est.totalTokens);
    const totalCostStr = formatCost(est.totalCost);

    const sampleNote = est.sampleCount > 0
      ? t('card.estimated_sample_note', { count: est.sampleCount })
      : '';

    row.innerHTML = `
      <div class="${c('quotaRow')}">
        <div class="${c('quotaRowHeader')}">
          <span class="${c('quotaModel')}">${escapeHtml(t('card.used_this_cycle'))}</span>
          <div class="${c('quotaMeta')}">
            <span class="${c('quotaAmount')}">${escapeHtml(t('card.not_used'))}</span>
          </div>
        </div>
      </div>
      <div class="${c('quotaRow')}">
        <div class="${c('quotaRowHeader')}">
          <span class="${c('quotaModel')}" style="opacity: 0.85;">${escapeHtml(t('card.estimated_limit'))}</span>
          <div class="${c('quotaMeta')}">
            <span class="${c('quotaAmount')}">${totalTokensStr}${totalCostStr !== '--' ? ' · ' + totalCostStr : ''}</span>
            <span class="${c('quotaReset')}">${escapeHtml(sampleNote)}</span>
          </div>
        </div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ============================================================
  // 注入样式
  // ============================================================

  function injectStyles() {
    if (document.getElementById('cmp-cycle-usage-style')) return;
    const style = document.createElement('style');
    style.id = 'cmp-cycle-usage-style';
    style.textContent = `
      .${ROW_CLASS} {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .${ROW_CLASS} [class*="quotaRow"] [class*="quotaModel"] {
        flex: 0 0 auto;
      }

      /* fallback 类样式：原卡片处于 idle 时使用（视觉风格与原 .quotaRow 一致） */
      .cmp-fallback-quotaRow {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .cmp-fallback-quotaRowHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
      }
      .cmp-fallback-quotaModel {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary, inherit);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        min-width: 0;
      }
      .cmp-fallback-quotaMeta {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: var(--text-secondary, #888);
        white-space: nowrap;
      }
      .cmp-fallback-quotaPercent {
        font-weight: 600;
        color: var(--text-primary, inherit);
      }
      .cmp-fallback-quotaReset {
        color: var(--text-tertiary, #aaa);
      }
      .cmp-fallback-quotaAmount {
        color: var(--text-secondary, #888);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ============================================================
  // 启动
  // ============================================================

  function start() {
    // 先加载 localStorage 缓存，这样重新打开页面时可直接用上次数据
    loadCache();

    // document-start 阶段先装 XHR hook，避免错过 app 首批接口请求
    installXHRHook();

    // 等 DOM ready 后注入样式 + 启动 observer
    const onReady = () => {
      injectStyles();

      const observer = new MutationObserver(() => {
        scheduleInjection();
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // 首次尝试注入
      scheduleInjection();
      log('Started, observing DOM');
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onReady, { once: true });
    } else {
      onReady();
    }
  }

  start();
})();
