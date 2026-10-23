/**
 * Browser half of dsh-token-tree: the conversation tree docked above the composer
 * (`conversation.composer.dock`) so the graph, the transcript and the input share
 * one screen, plus a "树" header button that still opens the older floating panel.
 *
 * This file is the built artifact, written by hand in the closure-factory format
 * the client module registry serves (`window.__ModuleLoader__.load({ id, factory })`).
 * It has no build step and no dependencies beyond the shell's module table:
 * `react` and `react-dom` are platform modules, resolved through the injected
 * `require`. Data comes from `GET /api/token-tree/tree?session=<id>`, which the
 * host plugin mounts on the shared authenticated `/api` route.
 */
window.__ModuleLoader__.load({ id: 'dsh-bonsai', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var React = require('react')
  var createPortal = require('react-dom').createPortal
  var h = React.createElement

  // --- i18n ---------------------------------------------------------------
  // Phrase table keyed by the Chinese source string. A missing entry falls back to the
  // source, so a partially translated surface still renders.
  var PHRASES = {
    "盆栽": "Bonsai",
  "🌳 盆栽": "🌳 Bonsai",
  "在左边选一个节点，然后点「从这里继续」。下一轮你输入的问题会成为它的子节点。": "Select a node on the left, then click \"Continue here\". The question you send next becomes its child.",
  "拖动一行到另一行可以改父节点（整棵子树一起移动）；删除只是隐藏，可撤销。": "Drag one row onto another to reparent it (the whole subtree moves). Delete only hides, and can be undone.",
  "节点": "nodes",
  "原始相关度（余弦）达到这个值才进入排序，0 表示不设门槛；实测 0.3 召回不降、返回节点约少四成，0.5 会让七成查询空手（空手时会自动放宽一次）": "Raw cosine similarity needed to enter ranking; 0 disables it. Measured: 0.3 keeps recall with ~40% fewer nodes, 0.5 leaves 70% of queries empty (it relaxes once when empty)",
  "下拉里列的是磁盘上实际找到的 tokenizer.json；「自主学习」不用词表，靠估算 + 账单校准，节点预算会自动打 0.85 折": "The list shows the tokenizer.json files found on disk. \"Learned\" uses no vocabulary: estimates plus billing calibration, with the budget discounted to 0.85",
  "tokenizer: {} · 可用 {} · 预算折扣 {} · 账单拟合 {}": "tokenizer: {} · available {} · budget factor {} · billing fit {}",
  "（未知）": "(unknown)",
  "（未配置）": "(not configured)",
  "无": "none",
  "已覆盖": "overridden",
  "生效": "active",
  "样本不足": "not enough samples",
  "这些开关立即生效，写入 {}，重启后仍然有效。": "These switches apply immediately and are stored in {}; they survive a restart.",
  "已保存：{}": "Saved: {}",
  "已保存：{} = {}": "Saved: {} = {}",
  "保存失败：{}": "Save failed: {}",
  "读取设置失败：{}": "Could not read settings: {}",
  "单击选中（操作在右侧）；双击跳到对话中的这一轮": "Click to select (actions on the right); double-click to jump to that turn",
  "单击选中；双击跳到对话中的这一轮": "Click to select; double-click to jump to that turn",
  "这条不在对话区当前渲染范围内（列表虚拟化），原文见右侧详情。": "That turn is outside the rendered transcript (virtualised list); see the detail panel instead.",
  "界面语言": "Language",
  "隐藏工具": "Hide tools",
  "折叠历史阈值": "Fold history above",
  "超过这个 token 数就把旧的工具输出从模型视野里折叠掉（0 = 关闭）。用 surfaceOp replace，不调模型；原文留在日志与树里": "Above this many tokens, old tool output is folded out of the model view (0 disables). Uses surfaceOp replace with no model call; the original stays in the log and the tree.",
  "保留最近轮数": "Keep recent turns",
  "折叠范围": "Fold scope",
  "工具输出：只折叠旧的 tool/result。整轮：把整轮对话换成一个占位行（工具调用与结果一起消失，不会只剩一半）": "Tool output: fold old tool/result entries. Whole turns: replace an entire turn with one placeholder line (a tool call disappears together with its result, never half of a pair).",
  "工具输出": "Tool output",
  "整轮对话": "Whole turns",
  "最近这么多轮的工具输出不折叠，保证正在用的上下文完整": "Tool output from this many recent turns is left unfolded, so the context in use stays complete.",
  "上次折叠：{} 条工具输出（会话 {} tok，阈值 {}）": "Last fold: {} tool result(s) (session {} tok, threshold {})",
  "上次折叠：{} 轮对话（会话 {} tok，阈值 {}）": "Last fold: {} turn(s) (session {} tok, threshold {})",
  "上次折叠被拒：{}": "Last fold was rejected: {}",
  "{} 个已隐藏分支 · 恢复后回到原位置": "{} hidden branch(es) · restored in place",
  "全部恢复": "Restore all",
  "已恢复 {} 个分支。": "Restored {} branch(es).",
  "{} 节点 · {} tok": "{} node(s) · {} tok",
  "逗号分隔。工具 schema 是 prompt 的大头：实测隐藏 9 个工具可省 3,377 token/轮（−32%），且每轮都省。名字必须存在，否则整批被拒": "Comma separated. Tool schemas dominate the prompt: hiding nine tools saved 3,377 tokens per turn (-32%) in measurement. Names must exist, otherwise the whole filter is rejected.",
  "上次隐藏失败：": "Last hide attempt failed: ",
  "回收站": "Recycle bin",
  "回收站是空的：没有已隐藏的分支。": "The recycle bin is empty: no hidden branches.",
  "恢复此分支": "Restore",
  "自动压缩阈值": "Auto-compact threshold",
  "当前会话 {} tok；压缩一次会读 {} tok，之后每轮约省 {} tok，约 {} 轮回本（缓存价约为输入价的 1/10，实际花费远低于这些数字）": "This conversation: {} tok. A compaction reads {} tok and saves about {} tok per turn, paying off after roughly {} turn(s). Cached reads cost about a tenth of fresh input, so the real spend is far below these numbers.",
  "对话 token 超过这个值就主动压缩（0 = 关闭）。这是唯一能真正减少 input 的手段，代价是丢失细节": "Compact once the conversation passes this many tokens (0 disables). The only lever that actually reduces input, at the cost of detail.",
  "「自动」跟随浏览器/系统语言；选择后只影响这个插件，不影响宿主": "Auto follows the browser language; the choice only affects this plugin",
  "自动": "Auto",
  "中文": "Chinese",
  "English": "English",
  "这个节点下有 {} 个分支：": "{} branches under this node:",
  "问": "Q",
  "答": "A",
  "工具": "tools",
  "收起": "Collapse",
  "展开": "Expand",
  "在左边点一个节点，操作会出现在这里。": "Click a node on the left; its actions appear here.",
  "收起（输入框始终可用）": "Collapse (the input stays usable)",
  "就地展开盆栽（对话树），不离开对话区": "Open Bonsai in place, without leaving the conversation",
    "盆栽（树编辑器）": "Bonsai (tree editor)",
    "图形": "Graph",
    "列表": "List",
    "详细": "Detailed",
    "精简": "Compact",
    "全图": "Fit",
    "回到当前": "Current",
      "设置": "Settings",
    "对话块": "Blocks",
    "完整树": "Full tree",
    "刷新": "Refresh",
    "关闭": "Close",
    "隐藏工具结果": "Hide tool results",
    "跟随配置": "Follow config",
    "读取中…": "Loading…",
    "读取设置中…": "Loading settings…",
    "恢复默认": "Reset",
    "（空）": "(empty)",
    "（空问题）": "(empty question)",
    "（这个分支还没有回答）": "(no answer in this branch yet)",
    "还没有节点可以比较。": "No nodes to compare yet.",
    "没有发生过分叉，暂时无从比较。": "No branches yet, so nothing to compare.",
    "这个会话还没有节点。": "This session has no nodes yet.",
    "这个会话还没有对话块。": "This session has no blocks yet.",
    "选中": "Select",
    "从这里继续": "Continue here",
    "已锚定（重新确认）": "Anchored (confirm again)",
    "取消锚定": "Clear anchor",
    "置顶": "Pin",
    "取消置顶": "Unpin",
    "忽略": "Ignore",
    "取消忽略": "Unignore",
    "隐藏此分支": "Hide this branch",
    "撤销删除": "Undo delete",
    "撤销移动": "Undo move",
    "取消移动": "Cancel move",
    "把刚才隐藏的分支恢复回来": "Restore the branch just hidden",
    "入边代价": "Edge cost",
    "距当前": "From current",
    "深度": "Depth",
    "父节点": "Parent",
    "状态": "State",
    "已忽略": "ignored",
    "已置顶": "pinned",
    "普通": "normal",
    "根": "root",
    "子节点": "Children",
    "已锚定": "anchored",
    "锚定中": "anchored",
    "轮": "turn",
    "问": "Q",
    "答": "A",
    "工具": "tools",
    "节点": "nodes",
    "分支": "branches",
    "块": "blocks",
    "自动注入记忆块": "Inject a memory block",
    "每回合把检索到的节点作为一块推到上下文里（实测约 428 token/轮）": "Push retrieved nodes into the context every turn (~428 tokens/turn measured)",
    "一行检索提示": "One-line retrieval hint",
    "不注入整块，只在尾部加一行提醒模型可以调用 retrieve_context（约 57 token/轮）": "Skip the block; append one line suggesting retrieve_context (~57 tokens/turn)",
    "提示起始节点数": "Hint after N nodes",
    "节点数达到这个值才开始发提示；被压缩过的会话不受此限，会立即提示": "Start hinting once the session has this many nodes; compacted sessions hint immediately",
    "自动反思与回溯": "Reflect and backtrack",
    "回合结束时评估失败、写反思节点，并把 Agent 拉回更优的兄弟分支": "On failure, write a reflection node and move the agent to a better sibling branch",
    "检索准入阈值": "Admission threshold",
    "原始相关度（余弦）达到这个值才进入排序，0 表示不设门槛；实测 0.3 召回不降、返回节点约少四成，0.5 会让七成查询空手（空手时会自动放宽一次）": "Raw cosine similarity needed to enter ranking; 0 disables it. Measured: 0.3 keeps recall with ~40% fewer nodes, 0.5 leaves 70% of queries empty (it relaxes once when empty)",
    "提示起始 token 数": "Hint after N tokens",
    "实测对话 token 达到这个值才发检索提示；有 tokenizer 时按实测、没有时按估算（并自动打 0.85 折）": "Start hinting once the conversation reaches this many measured tokens; without a tokenizer the estimate is used and the budget is discounted to 0.85",
    "下拉里列的是磁盘上实际找到的 tokenizer.json；「自主学习」不用词表，靠估算 + 账单校准，节点预算会自动打 0.85 折": "The list shows the tokenizer.json files actually found on disk. \"Learned\" uses no vocabulary: estimates plus billing calibration, with the budget discounted to 0.85",
    "自动（最新一代）": "Auto (newest)",
    "自主学习（不用词表）": "Learned (no vocabulary)",
          "拖动一行到另一行可以改父节点（整棵树一起移动）；删除只是隐藏，可撤销。": "Drag one row onto another to reparent it (the subtree moves with it). Delete only hides, and can be undone.",
    "锚定只影响下一轮：你回到对话输入框发出的那条问题会挂到锚定节点下。": "Anchoring affects the next turn only: the next question you send attaches under the anchored node.",
    "单击选中并跳到这条对话；双击直接锚定（下一问挂到它下面）": "Click to select and jump to that turn; double-click to anchor the next question under it",
    "在只显示节点号和显示问题/回答摘要之间切换": "Toggle between node ids and question/answer summaries",
    "缩放到能看见整棵树": "Zoom to fit the whole tree",
    "回到当前节点": "Go to the current node",
    "恢复成 profile 配置里的值": "Reset to the profile value",
    "视图渲染出错，刷新页面可恢复": "The view failed to render; reload the page to recover",
    "盆栽：对话树的详细信息与设置": "Bonsai: details and settings for this conversation tree"
  }

  // `auto` | `zh` | `en`, set from the saved setting or the host page.
  var LOCALE_PREFERENCE = 'auto'
  // Test hook and manual escape hatch; not used in normal operation.
  var LOCALE_FORCED = null
  // The dock and the editor both re-render when this changes.
  var localeListeners = []

  /**
   * Which language the interface should use right now.
   *
   * The host page's `<html lang>` is a static template value ("en") while the real UI
   * language is switched at runtime, so it is only a last resort: the browser language is
   * the honest default, and an explicit preference wins over both.
   * @returns {'en'|'zh'} Active locale.
   */
  function activeLocale() {
    try {
      var hook = typeof window === 'undefined' ? undefined : window.__BONSAI_LOCALE__
      if (hook === 'en' || hook === 'zh') return hook
      if (LOCALE_FORCED === 'en' || LOCALE_FORCED === 'zh') return LOCALE_FORCED
      if (LOCALE_PREFERENCE === 'zh' || LOCALE_PREFERENCE === 'en') return LOCALE_PREFERENCE
      var nav = navigator && navigator.language ? navigator.language.toLowerCase() : ''
      if (nav.length > 0) return nav.indexOf('zh') === 0 ? 'zh' : 'en'
      var html = document.documentElement && document.documentElement.lang
      if (typeof html === 'string' && html.length > 0) return html.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      return 'zh'
    } catch (error) {
      return 'zh'
    }
  }

  /**
   * Apply a language preference and re-render.
   * @param {string} preference - `auto`, `zh` or `en`.
   */
  function setLocalePreference(preference) {
    LOCALE_PREFERENCE = preference === 'zh' || preference === 'en' ? preference : 'auto'
  }

  /**
   * Adopt the language stored in the settings payload.
   * @param {object|null} payload - response from `GET /api/token-tree/settings`.
   */
  function applyLocale(payload) {
    var value = payload && typeof payload.locale === 'string' ? payload.locale : 'auto'
    if (value === LOCALE_PREFERENCE) return false
    setLocalePreference(value)
    return true
  }

  /**
   * Translate a template with `{}` placeholders.
   * @param {string} template - Chinese source template.
   * @param {...(string|number)} values - Substitutions, in order.
   * @returns {string} The filled template.
   */
  function tf(template, ...values) {
    let index = 0
    return t(template).replace(/\{\}/g, () => String(values[index++]))
  }

  /**
   * Translate a source phrase.
   * @param {string} text - Chinese source string.
   * @returns {string} The phrase in the active locale.
   */
  function t(text) {
    if (activeLocale() === 'zh') return text
    var translated = PHRASES[text]
    return translated === undefined ? text : translated
  }

  var ROUTE = '/api/token-tree/tree'
  var FOCUS = '/api/token-tree/focus'
  var EDIT = '/api/token-tree/edit'
  var SETTINGS = '/api/token-tree/settings'
  var PANEL_WIDTH = 420

  /**
   * Read the runtime switches.
   * @returns {Promise<object>} `{ base, overrides, effective, path }`.
   */
  function settingsGet() {
    return fetch(SETTINGS, { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
  }

  /**
   * Change one switch and persist it.
   * @param {object} patch - keys to set; `null` hands a key back to the profile config.
   * @returns {Promise<object>} `{ effective, overrides }`.
   */
  function settingsPost(patch) {
    return fetch(SETTINGS, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok || payload.ok !== true) throw new Error(payload.error || ('HTTP ' + response.status))
        return payload
      })
    })
  }

  /**
   * Anchor the next turn on one node (or clear it).
   * @param {string} sessionId - bound session, may be empty before binding.
   * @param {string|null} nodeId - node to continue from; null clears.
   * @returns {Promise<object>} the host answer.
   */
  function focusRequest(sessionId, nodeId) {
    var body = {}
    if (typeof sessionId === 'string' && sessionId.length > 0) body.session = sessionId
    if (nodeId === null) body.clear = true
    else body.nodeId = nodeId
    return fetch(FOCUS, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok || payload.ok !== true) throw new Error(payload.error || ('HTTP ' + response.status))
        return payload
      })
    })
  }

  /**
   * Apply one structural edit through the host.
   * @param {string} sessionId - bound session.
   * @param {object} payload - action + node fields.
   * @returns {Promise<object>} the host answer.
   */
  function editRequest(sessionId, payload) {
    var body = { action: payload.action, nodeId: payload.nodeId }
    if (typeof sessionId === 'string' && sessionId.length > 0) body.session = sessionId
    if (payload.parentId !== undefined) body.parentId = payload.parentId
    if (payload.pinned !== undefined) body.pinned = payload.pinned
    if (payload.ignored !== undefined) body.ignored = payload.ignored
    return fetch(EDIT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response.json().then(function (result) {
        if (!response.ok || result.ok !== true) throw new Error(result.error || ('HTTP ' + response.status))
        return result
      })
    })
  }

  var styles = [
    // Theme tokens. The host ships `--dsw-alias-*` for light and dark; everything here
    // resolves through them so this UI follows the system instead of forcing dark chrome.
    ':root{',
    '--twt-surface:var(--dsw-alias-bg-base,#1d2026);',
    '--twt-panel:var(--dsw-elevation-panel,var(--dsw-alias-bg-base,#1d2026));',
    '--twt-border:var(--dsw-alias-border-l2,#30353f);',
    '--twt-border-strong:var(--dsw-alias-border-l1,#3b414c);',
    '--twt-text:var(--dsw-alias-label-primary,#e6e8ec);',
    '--twt-text-dim:var(--dsw-alias-label-secondary,#a8aeb8);',
    '--twt-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));',
    '--twt-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#6ea8fe);',
    '--twt-warn:#e0a458;',
    '--twt-danger:#e06c75;',
    '}',

    '@media (prefers-color-scheme:light){:root{',
    '--twt-surface:var(--dsw-alias-bg-base,#ffffff);',
    '--twt-panel:var(--dsw-elevation-panel,#ffffff);',
    '--twt-border:var(--dsw-alias-border-l2,#d8d8d8);',
    '--twt-border-strong:var(--dsw-alias-border-l1,#b9bdc4);',
    '--twt-text:var(--dsw-alias-label-primary,#1b1d21);',
    '--twt-text-dim:var(--dsw-alias-label-secondary,#545a63);',
    '--twt-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));',
    '}}',
    '.twt-btn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:7px;',
    'border:1px solid var(--twt-border);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
    '.twt-actions-row{display:inline-flex;gap:6px;align-items:center}',
    '.twt-btn:hover{background:var(--twt-hover)}',
    '.twt-btn[data-active="true"]{border-color:var(--twt-accent);color:var(--twt-accent)}',
    '.twt-count{opacity:.65;font-variant-numeric:tabular-nums}',
    '.twt-panel,.twt-editor,.twt-dock,.twt-eoverlay{color-scheme:light dark}',
    '.twt-panel{position:fixed;top:64px;right:16px;width:' + PANEL_WIDTH + 'px;max-height:72vh;display:flex;flex-direction:column;',
    'background:var(--twt-surface);color:var(--twt-text);border:1px solid var(--twt-border);',
    'border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.45);z-index:60;overflow:hidden}',
    '.twt-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--twt-border);font-size:12px}',
    '.twt-head b{font-size:12px}',
    '.twt-close{margin-left:auto;background:none;border:0;color:inherit;opacity:.6;cursor:pointer;font-size:14px;line-height:1}',
    '.twt-body{overflow:auto;padding:8px 10px 12px}',
    '.twt-row{display:flex;gap:6px;align-items:baseline;padding:5px 6px;border-radius:8px;cursor:pointer}',
    '.twt-row:hover{background:var(--twt-hover)}',
    '.twt-row[data-focus="true"]{outline:1px solid var(--twt-warn)}',
    '.twt-id{font-variant-numeric:tabular-nums;opacity:.55;font-size:11px}',
    '.twt-q{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.twt-meta{margin-left:auto;display:flex;gap:6px;align-items:center;font-size:10px;opacity:.75;white-space:nowrap}',
    '.twt-tag{border:1px solid currentColor;border-radius:999px;padding:0 6px;line-height:15px}',
    '.twt-tag[data-origin="auto"]{color:#8f7bf0}',
    '.twt-tag[data-origin="topic"]{color:#6ea8fe}',
    '.twt-tag[data-origin="chain"]{color:#6b7280}',
    '.twt-a{font-size:12px;opacity:.85;margin:2px 0 6px 18px;white-space:pre-wrap}',
    '.twt-tools{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px 18px}',
    '.twt-tool{font-size:10px;border:1px dashed var(--twt-border);border-radius:6px;padding:0 6px;opacity:.8}',
    '.twt-tool[data-ok="false"]{color:var(--twt-danger);border-color:rgba(224,108,117,.45)}',
    '.twt-note{padding:14px 12px;font-size:12px;opacity:.7}',
    '.twt-err{color:var(--twt-danger)}',
    '.twt-constraints{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--twt-border);font-size:11px}',
    '.twt-constraints-label{opacity:.6}',
    '.twt-constraint{border:1px solid rgba(224,164,88,.45);color:#e0a458;border-radius:999px;padding:0 8px;line-height:17px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.twt-branches{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--twt-border);padding-top:8px}',
    '.twt-branches-head{font-size:11px;opacity:.65}',
    '.twt-branch-row{border:1px solid var(--twt-border);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:4px;cursor:pointer}',
    '.twt-branch-row:hover{background:var(--twt-hover)}',
    '.twt-branch-row[data-anchored="true"]{border-color:var(--twt-warn)}',
    '.twt-branch-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;opacity:.85}',
    // Editor: a separate surface, big enough to read a long conversation and pick a node.
    '.twt-eoverlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:80;display:flex;align-items:center;justify-content:center}',
    '.twt-editor{width:min(880px,90vw);height:min(600px,72vh);display:flex;flex-direction:column;',
    'background:var(--twt-surface);color:var(--twt-text);border:1px solid var(--twt-border);',
    'border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.55);overflow:hidden}',
    '.twt-editor-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--twt-border);font-size:13px}',
    '.twt-editor-body{flex:1;display:flex;min-height:0}',
    '.twt-elist{flex:1.2;overflow:auto;padding:8px 6px 8px 10px;border-right:1px solid var(--twt-border)}',
    '.twt-edetail{flex:1;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
    '.twt-erow{display:flex;gap:8px;align-items:baseline;padding:6px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent}',
    '.twt-erow:hover{background:var(--twt-hover)}',
    '.twt-erow[data-picked="true"]{border-color:var(--twt-accent);background:rgba(110,168,254,.12)}',
    '.twt-erow[data-anchored="true"]{border-color:var(--twt-warn)}',
    '.twt-erow[data-drop="true"]{border-style:dashed;border-color:var(--twt-accent);background:rgba(110,168,254,.14)}',
    '.twt-erow[data-drag="true"]{opacity:.45}',
    '.twt-erow[data-ignored="true"]{opacity:.5}',
    '.twt-erow[data-ignored="true"] .twt-q{text-decoration:line-through}',
    '.twt-ekind{flex:0 0 auto;width:16px;height:16px;line-height:15px;text-align:center;border-radius:4px;font-size:10px;border:1px solid currentColor;opacity:.75}',
    '.twt-ekind[data-kind="question"]{color:#6ea8fe}',
    '.twt-ekind[data-kind="answer"]{color:#7bd88f}',
    '.twt-ekind[data-kind="tool_result"]{color:#9aa4b2}',
    '.twt-ekind[data-kind="reflection"]{color:#c792ea}',
    '.twt-ekind[data-kind="note"]{color:#e0a458}',
    '.twt-elist-graph{display:flex;overflow:hidden;padding:0}',
    '.twt-erow .twt-action{margin-left:8px}',
    '.twt-basket{display:flex;flex-direction:column;flex:1;overflow:hidden}',
    '.twt-basket-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px 8px}',
    '.twt-basket-list{border-right:none}',
    '.twt-basket-row{display:grid;grid-template-columns:18px 48px minmax(0,1fr) auto auto;gap:8px;align-items:center}',
    '.twt-basket-row .twt-q{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.twt-compare{display:flex;flex-direction:column;gap:8px;padding:8px 10px;overflow:auto;height:100%}',
  '.twt-compare-cols{display:flex;gap:10px;align-items:stretch;overflow:auto}',
  '.twt-branch-col{flex:1 1 0;min-width:180px;max-width:320px;border:1px solid var(--twt-border);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;background:var(--twt-surface)}',
  '.twt-branch-col[data-anchored="true"]{border-color:#e0a458;box-shadow:0 0 0 1px #e0a458 inset}',
  '.twt-branch-head{display:flex;align-items:center;gap:6px;font-size:11px;opacity:.75}',
  '.twt-branch-q{font-weight:600;font-size:12px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
  '.twt-branch-a{font-size:11px;line-height:1.45;white-space:pre-wrap;max-height:132px;overflow:auto;opacity:.85;border-left:2px solid var(--twt-border);padding-left:6px}',
  '.twt-branch-stats{font-size:10px}',
    '.twt-graph{flex:1;min-height:0;position:relative}',
    '.twt-graph svg{background:var(--twt-hover);border-radius:10px}',
    '.twt-ebadge{font-size:10px;border:1px solid currentColor;border-radius:999px;padding:0 6px;line-height:15px;opacity:.8}',
    '.twt-dtitle{font-size:12px;font-weight:700;opacity:.7;letter-spacing:.04em;text-transform:uppercase}',
    '.twt-dtext{font-size:12px;line-height:1.55;white-space:pre-wrap;max-height:26vh;overflow:auto;border-left:2px solid var(--twt-border);padding-left:10px}',
    '.twt-dgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;font-size:11px;opacity:.85}',
    '.twt-dgrid span b{font-weight:600;opacity:.7;margin-right:4px}',
    '.twt-actions{display:flex;gap:8px;flex-wrap:wrap}',
    '.twt-action{font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--twt-border);background:transparent;color:inherit}',
    '.twt-action[data-kind="primary"]{background:var(--twt-accent);border-color:transparent;color:#fff}',
    '.twt-action:disabled{opacity:.45;cursor:default}',
    '.twt-hint{font-size:11px;opacity:.62;line-height:1.5}',
    // Conversation mode: cover the transcript but leave the composer visible, so the
    // dialogue keeps going while the graph is the only thing being read.
    '.twt-eoverlay-conv{background:transparent;align-items:stretch;justify-content:stretch;pointer-events:none}',
    '.twt-editor-conv{position:absolute;inset:56px 12px 96px 12px;width:auto;height:auto;max-height:none;',
    'max-width:1040px;margin:0 auto;pointer-events:auto}',
    '.twt-editor-conv .twt-split{flex:1;display:flex;min-height:0;flex-direction:column}',
    '.twt-flash{font-size:11px;color:var(--twt-warn)}',
    // Dock: the same tree, but seated in the conversation column above the composer,
    // so reading the graph and typing the next question never share a screen.
    '.twt-dock{border:1px solid var(--twt-border);border-radius:10px;margin:0 0 8px;',
    'background:var(--twt-surface);font-size:12px;overflow:hidden}',
    '.twt-dockbar{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;user-select:none}',
    '.twt-dockbar:hover{background:var(--twt-hover)}',
    '.twt-docktitle{font-weight:600;white-space:nowrap}',
    '.twt-dockpath{opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}',
    '.twt-dockbody{display:flex;flex-direction:row;gap:0;height:32vh;max-height:32vh;border-top:1px solid var(--twt-border)}',
    '.twt-dockmain{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;padding:4px 6px 6px}',
    '.twt-dockmain .twt-graph{height:100%;min-height:0}',
    '.twt-dockside{flex:0 0 200px;min-width:0;border-left:1px solid var(--twt-border);',
    'padding:6px 8px 8px;overflow:auto;display:flex;flex-direction:column;gap:6px}',
    '.twt-dockactions-vertical{flex-direction:column;align-items:stretch}',
    '.twt-dockactions-vertical .twt-action{width:100%;text-align:center}',
    // Settings tab: one row per switch, control on the right.
    '.twt-settings{flex:1;min-height:0;overflow:auto;padding:10px 14px;display:flex;flex-direction:column;gap:10px}',
    '.twt-srow{display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:8px;',
    'border:1px solid var(--twt-border);background:rgba(255,255,255,.02)}',
    '.twt-slabel{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
    '.twt-slabel .twt-hint{font-size:11px;opacity:.7}',
    '.twt-scontrol{display:flex;align-items:center;gap:8px;flex:none}',
    // Embedded, not floating: the dock stays a normal flex item of the composer row, so
    // the transcript keeps its own space. Expanding only adds breathing room on both
    // sides, which pushes the tok/s, cache-hit and context widgets away from the graph
    // instead of squeezing the layout.
    '.twt-dock{position:relative}',
    '.twt-dock-panel{display:flex;flex-direction:column}',
    'body.twt-dock-expanded .twt-dock{margin-left:14px;margin-right:14px;max-width:none}',
    '.twt-dockrow{display:flex;gap:8px;align-items:baseline;padding:4px 6px;border-radius:7px;cursor:pointer;',
    'border:1px solid transparent}',
    '.twt-dockrow:hover{background:var(--twt-hover)}',
    '.twt-dockrow[data-picked="true"]{border-color:var(--twt-accent);background:rgba(110,168,254,.12)}',
    '.twt-dockrow[data-focus="true"]{outline:1px solid var(--twt-warn)}',
    '.twt-dockrow[data-future="true"]{border-style:dashed;border-color:var(--twt-accent)}',
    '.twt-dockrow[data-ignored="true"]{opacity:.55}',
    '.twt-dockdetail{font-size:11px;opacity:.78;line-height:1.5;white-space:pre-wrap;max-height:14vh;',
    'overflow:auto;padding:6px 10px 0}',
    '.twt-dockactions{display:flex;gap:6px;flex-wrap:wrap;padding:8px 10px}',
  ].join('')

  var injected = false
  function ensureStyles() {
    if (injected || typeof document === 'undefined') return
    injected = true
    var tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-token-tree'
    tag.textContent = styles
    document.head.appendChild(tag)
  }


  /**
   * Node-link diagram of the tree, drawn as plain SVG.
   *
   * The shell only exposes react and react-dom, so the layout is computed here:
   * leaves take sequential columns, every parent sits above the midpoint of its
   * children, and edges are cubic curves. The whole graph lives in one `viewBox`,
   * so wheel-zoom and drag-pan are just arithmetic on that box.
   * @param {object} props - nodes, selectedId, anchoredId, focusId, onPick.
   * @returns {object} rendered svg.
   */
  /** Flash one row so the user sees where the jump landed. */
  function highlightRow(row) {
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    var previous = row.style.outline
    row.style.outline = '2px solid #6ea8fe'
    row.style.outlineOffset = '2px'
    setTimeout(function () {
      row.style.outline = previous
      row.style.outlineOffset = ''
    }, 1600)
  }

  /**
   * The transcript row rendered for one turn, if it is in the DOM.
   * @param {number} turn - turn number.
   * @returns {Element|null} the row.
   */
  function turnRow(turn) {
    if (typeof turn !== 'number' || typeof document === 'undefined') return null
    return document.querySelector('[data-chat-turn="' + turn + '"]')
  }

  /**
   * Scroll the transcript to the row that shows one node.
   *
   * Matching is by text only as a fallback: our own `/tree` output quotes the same
   * question text, so the first hit used to be a command result. Among candidates
   * this picks the shortest row and skips anything produced by this plugin.
   * @param {string} text - node text to look for.
   * @returns {boolean} whether a row was found and scrolled to.
   */
  function revealByText(text) {
    if (typeof document === 'undefined' || typeof text !== 'string') return false
    var needle = text.replace(/\s+/g, ' ').trim().slice(0, 24)
    if (needle.length < 4) return false
    var rows = document.querySelectorAll('[data-chat-node-key], [data-chat-turn]')
    var best = null
    var bestLength = Number.POSITIVE_INFINITY
    for (var index = 0; index < rows.length; index++) {
      var row = rows[index]
      var content = (row.textContent || '').replace(/\s+/g, ' ')
      if (content.indexOf(needle) === -1) continue
      // Skip our own command output: it embeds the question text verbatim.
      if (content.indexOf('token-tree') !== -1) continue
      if (content.length < bestLength) {
        best = row
        bestLength = content.length
      }
    }
    if (best === null) return false
    highlightRow(best)
    return true
  }

  /** The scrollable transcript element that holds the chat rows. */
  function transcriptScroller() {    if (typeof document === 'undefined') return null
    var row = document.querySelector('[data-chat-node-key]')
    var node = row === null ? null : row.parentElement
    while (node !== null && node !== document.body) {
      var style = typeof window !== 'undefined' && window.getComputedStyle !== undefined
        ? window.getComputedStyle(node)
        : undefined
      var scrollable = style !== undefined && (style.overflowY === 'auto' || style.overflowY === 'scroll')
      if (scrollable && node.scrollHeight > node.clientHeight) return node
      node = node.parentElement
    }
    return null
  }

  /**
   * The host's turn rail (the marks down the right edge of the transcript).
   *
   * Each mark is a `<button data-index>` whose `aria-label` carries the turn number,
   * and clicking one runs the host's own `navigateToTurn`, which **pages history in**
   * before landing. That is why the rail can reach turns the virtualised list has not
   * loaded — the one jump path here without a history limit.
   * @returns {Element[]} rail marks, in rail order.
   */
  function railMarks() {
    if (typeof document === 'undefined') return []
    var found = []
    var buttons = document.querySelectorAll('button[data-index]')
    for (var index = 0; index < buttons.length; index++) {
      var button = buttons[index]
      var classes = String(button.className || '')
      if (classes.indexOf('_mark') === -1) continue
      found.push(button)
    }
    return found
  }

  /**
   * Jump by clicking the host's turn rail.
   * @param {number} turn - target turn.
   * @returns {boolean} whether a matching mark was clicked.
   */
  function revealViaRail(turn) {
    if (typeof turn !== 'number' || !Number.isFinite(turn)) return false
    var marks = railMarks()
    var best = null
    var bestDistance = Number.POSITIVE_INFINITY
    for (var index = 0; index < marks.length; index++) {
      var label = marks[index].getAttribute('aria-label') || ''
      var digits = label.match(/(\d+)/)
      if (digits === null) continue
      var marked = Number(digits[1])
      var distance = Math.abs(marked - turn)
      if (distance < bestDistance) {
        best = marks[index]
        bestDistance = distance
      }
      if (distance === 0) break
    }
    if (best === null || bestDistance > 1) return false
    if (typeof best.click === 'function') best.click()
    return true
  }

  /**
   * Reveal a node, paging older history in if the row is not rendered yet.
   *
   * Order of preference:
   * 1. the row is already rendered;
   * 2. the host's turn rail — it pages history itself, so very old turns work;
   * 3. scrolling to the top repeatedly and retrying;
   * 4. text matching, shortest row first, skipping this plugin's own output.
   * @param {string} text - node text, used only when the turn is unknown.
   * @param {number} turn - turn the node belongs to.
   * @returns {Promise<boolean>} whether the row was found.
   */
  async function revealDeep(text, turn) {
    var direct = turnRow(turn)
    if (direct !== null) {
      highlightRow(direct)
      return true
    }
    if (revealViaRail(turn)) {
      // The rail loads the page and scrolls; wait for the row, then flash it.
      for (var wait = 0; wait < 16; wait++) {
        await new Promise(function (resolve) { setTimeout(resolve, 250) })
        var landed = turnRow(turn)
        if (landed !== null) {
          highlightRow(landed)
          return true
        }
      }
      return true
    }
    if (revealByText(text)) return true
    var scroller = transcriptScroller()
    if (scroller === null) return false
    var height = scroller.scrollHeight
    for (var attempt = 0; attempt < 12; attempt++) {
      scroller.scrollTop = 0
      await new Promise(function (resolve) { setTimeout(resolve, 350) })
      var row = turnRow(turn)
      if (row !== null) {
        highlightRow(row)
        return true
      }
      if (revealByText(text)) return true
      if (scroller.scrollHeight === height) return false
      height = scroller.scrollHeight
    }
    return false
  }

  /**
   * Set when a pan actually moved, so the click that follows a drag does not also
   * select a node. Shared module state: only one graph is visible at a time.
   */
  var graphPanMoved = false

  function TreeGraph(props) {
    var nodes = props.nodes
    var onPick = props.onPick
    // Compact boxes keep a title: the node id plus its question, on one line. Only
    // the answer body moves to the right rail. The editor keeps the two-line cards.
    var compact = props.compact === true
    var NODE_W = compact ? 132 : 168
    var NODE_H = compact ? 26 : 46
    var GAP_X = compact ? 12 : 16
    var GAP_Y = compact ? 44 : 62

    var byId = {}
    var childrenOf = {}
    var roots = []
    for (var index = 0; index < nodes.length; index++) {
      var node = nodes[index]
      byId[node.id] = node
      childrenOf[node.id] = []
    }
    for (var index2 = 0; index2 < nodes.length; index2++) {
      var entry = nodes[index2]
      if (entry.parentId === null || byId[entry.parentId] === undefined) roots.push(entry.id)
      else childrenOf[entry.parentId].push(entry.id)
    }

    // Tidy layout: leaves occupy consecutive columns, parents centre over children.
    var slot = {}
    var cursor = 0
    function place(id, depth, guard) {
      if (guard > 200 || slot[id] !== undefined) return slot[id] === undefined ? cursor : slot[id].x
      var kids = childrenOf[id] || []
      if (kids.length === 0) {
        slot[id] = { x: cursor, y: depth }
        cursor += 1
        return slot[id].x
      }
      var xs = []
      for (var k = 0; k < kids.length; k++) xs.push(place(kids[k], depth + 1, guard + 1))
      var x = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2
      slot[id] = { x: x, y: depth }
      return x
    }
    for (var r = 0; r < roots.length; r++) place(roots[r], 0, 0)

    var maxX = 0
    var maxY = 0
    var placed = []
    for (var index3 = 0; index3 < nodes.length; index3++) {
      var item = nodes[index3]
      var spot = slot[item.id]
      if (spot === undefined) continue
      var px = spot.x * (NODE_W + GAP_X)
      var py = spot.y * (NODE_H + GAP_Y)
      if (px > maxX) maxX = px
      if (py > maxY) maxY = py
      placed.push({ node: item, x: px, y: py })
    }

    var pad = 24
    var width = maxX + NODE_W + pad * 2
    var height = maxY + NODE_H + pad * 2
    var boxState = React.useState(null)
    var box = boxState[0]
    var setBox = boxState[1]
    // A 1,800-node tree fitted to the viewport is a single faint line. Start on the
    // current node at a readable zoom instead; 「全图」 still fits everything.
    var focusSpot = props.focusId === undefined ? undefined : slot[props.focusId]
    var startWidth = compact ? 880 : 1100
    var startHeight = startWidth * 0.52
    var startX = focusSpot === undefined ? 0 : focusSpot.x * (NODE_W + GAP_X) + NODE_W / 2 + pad - startWidth / 2
    var startY = focusSpot === undefined ? 0 : focusSpot.y * (NODE_H + GAP_Y) + NODE_H / 2 + pad - startHeight / 2
    var fitBox = { x: startX, y: startY, w: startWidth, h: startHeight }
    var allBox = { x: 0, y: 0, w: Math.max(width, 200), h: Math.max(height, 160) }
    var current = box === null ? fitBox : box
    var viewBox = current.x + ' ' + current.y + ' ' + current.w + ' ' + current.h

    /**
     * Start a pan.
     *
     * The listeners live on `window`, not on the svg: a re-render used to rebuild
     * the old plain-object drag ref and kill the gesture after the first move, and
     * the pointer leaving the svg used to end it too.
     * @param {object} event - mousedown event.
     */
    function startPan(event) {
      if (event.button !== undefined && event.button !== 0) return
      var rect = event.currentTarget.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      var startX = event.clientX
      var startY = event.clientY
      var origin = current
      var scaleX = origin.w / rect.width
      var scaleY = origin.h / rect.height

      function onMove(moveEvent) {
        var dx = moveEvent.clientX - startX
        var dy = moveEvent.clientY - startY
        if (Math.abs(dx) + Math.abs(dy) > 3) graphPanMoved = true
        setBox({ x: origin.x - dx * scaleX, y: origin.y - dy * scaleY, w: origin.w, h: origin.h })
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        // The click event fires right after mouseup; clear the flag after it.
        setTimeout(function () { graphPanMoved = false }, 0)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      event.preventDefault()
    }

    /**
     * Zoom around the pointer so the point under the cursor stays put.
     *
     * Bound natively with `{ passive: false }`: React's `onWheel` is passive at the
     * root, so `preventDefault()` there is ignored and the page scrolls instead.
     * @param {object} event - wheel event.
     */
    function onWheel(event) {
      var rect = event.currentTarget.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      var scale = event.deltaY > 0 ? 1.12 : 1 / 1.12
      var w = Math.min(Math.max(current.w * scale, 120), Math.max(width, 200) * 6)
      var hh = w * (current.h / current.w)
      var px = current.x + (event.clientX - rect.left) * (current.w / rect.width)
      var py = current.y + (event.clientY - rect.top) * (current.h / rect.height)
      setBox({
        x: px - (px - current.x) * (w / current.w),
        y: py - (py - current.y) * (hh / current.h),
        w: w,
        h: hh,
      })
    }

    var svgRef = React.useRef(null)
    var wheelRef = React.useRef(onWheel)
    wheelRef.current = onWheel
    React.useEffect(function () {
      var element = svgRef.current
      if (element === null || element === undefined) return undefined
      function handleWheel(event) {
        event.preventDefault()
        wheelRef.current(event)
      }
      element.addEventListener('wheel', handleWheel, { passive: false })
      return function () { element.removeEventListener('wheel', handleWheel) }
    }, [])

    var edges = []
    for (var index4 = 0; index4 < placed.length; index4++) {
      var child = placed[index4]
      var parentSpot = child.node.parentId === null ? undefined : slot[child.node.parentId]
      if (parentSpot === undefined) continue
      var x1 = parentSpot.x * (NODE_W + GAP_X) + NODE_W / 2 + pad
      var y1 = parentSpot.y * (NODE_H + GAP_Y) + NODE_H + pad
      var x2 = child.x + NODE_W / 2 + pad
      var y2 = child.y + pad
      var mid = (y1 + y2) / 2
      edges.push(h('path', {
        key: 'e-' + child.node.id,
        d: 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + mid + ' ' + x2 + ',' + mid + ' ' + x2 + ',' + y2,
        fill: 'none',
        stroke: 'var(--dsw-border,#3a4150)',
        strokeWidth: 1.5,
      }))
    }

    var boxes = placed.map(function (item) {
      var node = item.node
      var isPicked = props.selectedId === node.id
      var isAnchored = props.anchoredId === node.id
      var isFocus = props.focusId === node.id
      var isMoveSource = props.moveSource === node.id
      var stroke = isAnchored ? '#e0a458' : (isPicked ? '#6ea8fe' : (isFocus ? '#7bd88f' : 'var(--dsw-border,#3a4150)'))
      // One box per exchange: the question is the title, the answer the body.
      // Both are width-fitted so nothing spills outside the box.
      var innerWidth = NODE_W - 16
      var title = fitText(node.id + ' ' + (node.preview || ''), 10.5, innerWidth)
      var body = fitText(node.detail === undefined ? '' : String(node.detail), 9.5, innerWidth)
      return h('g', {
        key: node.id,
        transform: 'translate(' + (item.x + pad) + ',' + (item.y + pad) + ')',
        style: { cursor: props.moveSource !== null ? 'crosshair' : 'pointer' },
        onClick: function () {
          if (graphPanMoved) return
          // In move mode a click picks the new parent instead of selecting.
          if (props.moveSource !== null && props.moveSource !== node.id) props.onMoveTarget(node.id)
          else onPick(node.id)
        },
        onDoubleClick: function () {
          if (graphPanMoved) return
          if (props.moveSource !== null) return
          if (typeof props.onJump === 'function') props.onJump(node.id)
        },
      },
        h('rect', {
          width: NODE_W,
          height: NODE_H,
          rx: compact ? 6 : 8,
          fill: kindFill(node.kind),
          stroke: isMoveSource ? '#e0a458' : stroke,
          strokeWidth: isPicked || isAnchored || isFocus || isMoveSource ? 2 : 1,
          strokeDasharray: props.moveSource !== null && !isMoveSource ? '4 3' : undefined,
          opacity: node.ignored === true ? 0.55 : 1,
        }),
        // Compact: one line — id plus the question, width-fitted so it never spills.
        compact
          ? h('text', {
            x: 7,
            y: NODE_H / 2 + 3.5,
            fill: 'var(--twt-text)',
            fontSize: 9.5,
            style: { pointerEvents: 'none' },
          }, fitText(node.id + ' ' + (node.preview || ''), 9.5, NODE_W - 12))
          : h(React.Fragment, null,
            h('text', {
              x: 8,
              y: 13,
              fill: 'var(--twt-text)',
              fontSize: 9.5,
              opacity: 0.7,
              style: { pointerEvents: 'none' },
            }, kindLabel(node.kind)),
            h('text', {
              x: 8,
              y: 27,
              fill: 'var(--twt-text)',
              fontSize: 10.5,
              fontWeight: 600,
              style: { pointerEvents: 'none' },
            }, title),
            body === '' ? null : h('text', {
              x: 8,
              y: 40,
              fill: 'var(--twt-text)',
              fontSize: 9.5,
              opacity: 0.65,
              style: { pointerEvents: 'none' },
            }, body)),
        node.pinned === true ? h('circle', { cx: NODE_W - 8, cy: 8, r: 3, fill: '#6ea8fe' }) : null,
        node.ignored === true ? h('circle', { cx: NODE_W - 8, cy: 8, r: 3, fill: '#e06c75' }) : null
      )
    })

    return h('div', { className: 'twt-graph' },
      h('svg', {
        ref: svgRef,
        width: '100%',
        height: '100%',
        viewBox: viewBox,
        style: { display: 'block', userSelect: 'none', cursor: 'grab' },
        onMouseDown: startPan,
      },
        h('g', null, edges),
        h('g', null, boxes)),
      // A reset button is cheaper than explaining how to recover a lost pan.
      h('button', {
        className: 'twt-action twt-graph-reset',
        style: { position: 'absolute', right: '10px', bottom: '10px', padding: '3px 10px' },
        onClick: function () { setBox(allBox) },
        title: t('缩放到能看见整棵树'),
      }, t('全图')),
      h('button', {
        className: 'twt-action',
        style: { position: 'absolute', right: '10px', bottom: '42px', padding: '3px 10px' },
        onClick: function () { setBox(null) },
        title: t('回到当前节点'),
      }, t('回到当前')),
      // Move-mode banner: the graph pan-gesture steals drag-to-move, so the mode has
      // to be visible and explicit.
      props.moveSource === null ? null : h('div', {
        style: {
          position: 'absolute', left: '10px', top: '10px', padding: '3px 10px',
          borderRadius: '8px', background: 'rgba(224,164,88,.16)', color: '#e0a458', fontSize: '11px',
        },
      }, '移动模式：点击目标节点，把 ' + props.moveSource + ' 挂到它下面（或按「取消移动」）')
    )
  }

  /** Soft fill per node kind. */
  function kindFill(kind) {
    if (kind === 'question') return 'rgba(110,168,254,.16)'
    if (kind === 'answer') return 'rgba(123,216,143,.14)'
    if (kind === 'tool_result') return 'rgba(154,164,178,.12)'
    if (kind === 'reflection') return 'rgba(199,146,234,.16)'
    return 'rgba(224,164,88,.14)'
  }

  /**
   * The tree editor: a full surface where the user picks a node and says
   * "continue from here". Picking posts to the focus route; the *next* message in
   * the chat box becomes that node's child, so the tree grows where the user
   * pointed instead of where auto-attachment guessed.
   * @param {object} props - sessionId, onClose, onChanged.
   * @returns {object} rendered element.
   */
  function TreeEditor(props) {
    ensureStyles()
    var sessionId = props.sessionId
    var onClose = props.onClose
    var onChanged = props.onChanged
    var conversation = props.conversationMode === true
    var viewState = React.useState({ loading: true, data: null, error: null })
    var view = viewState[0]
    var setView = viewState[1]
    var pickState = React.useState(null)
    var picked = pickState[0]
    var setPicked = pickState[1]
    var noteState = React.useState('')
    var note = noteState[0]
    var setNote = noteState[1]
    var busyState = React.useState(false)
    var busy = busyState[0]
    var setBusy = busyState[1]
    // Two-click move: pick the branch, then click its new parent. The graph needs
    // this because dragging there pans the canvas instead of moving nodes.
    var moveState = React.useState(null)
    var moveSource = moveState[0]
    var setMoveSource = moveState[1]
    // Last successful move, so one click can put the branch back.
    var lastMoveState = React.useState(null)
    var lastMove = lastMoveState[0]
    var setLastMove = lastMoveState[1]
    // Last hidden branch, so one click can restore it.
    var removedState = React.useState(null)
    var removedId = removedState[0]
    var setRemoved = removedState[1]
    // Drag state lives in a ref as well as state: the drop handler must read the
    // source synchronously, before React has re-rendered.
    var dragId = null
    var dragState = React.useState(null)
    var drag = dragState[0]
    var setDragId = dragState[1]
    var dropState = React.useState(null)
    var dropId = dropState[0]
    var setDropId = dropState[1]
    // Two views of the same tree: one row per exchange, or one row per node
    // (answers, tool results and reflections included). Conversation mode opens on
    // the graph and keeps it open while the dialogue continues.
    var modeState = React.useState(conversation ? 'graph' : 'blocks')
    var mode = modeState[0]
    var setMode = modeState[1]
    // Runtime switches: fetched once, then re-read after every save.
    // Bumped when the interface language changes, so the dock re-renders.
    var localeTickState = React.useState(0)
    var localeTick = localeTickState[0]
    var setLocaleTick = localeTickState[1]
    var settingsState = React.useState(null)
    var settings = settingsState[0]
    var setSettings = settingsState[1]
    var hideState = React.useState(false)
    var hideTools = hideState[0]
    var setHideTools = hideState[1]

    function load() {
      var params = []
      if (typeof sessionId === 'string' && sessionId.length > 0) params.push('session=' + encodeURIComponent(sessionId))
      if (mode !== 'blocks' && mode !== 'settings') params.push('view=nodes')
      var url = params.length === 0 ? ROUTE : ROUTE + '?' + params.join('&')
      fetch(url, { credentials: 'same-origin' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        })
        .then(function (data) { setView({ loading: false, data: data, error: null }) })
        .catch(function (error) { setView({ loading: false, data: null, error: '读取失败：' + error.message }) })
    }

    React.useEffect(function () { load() }, [sessionId, mode])

    // Language lives in the settings file; read it once so the dock matches the editor
    // even when the editor has never been opened.
    React.useEffect(function () {
      var cancelled = false
      settingsGet()
        .then(function (payload) {
          if (cancelled) return
          if (applyLocale(payload)) setDockLocale(function (value) { return value + 1 })
        })
        .catch(function () {})
      return function () { cancelled = true }
    }, [])

    // The switches are host state, not tree state: fetch them once so the settings tab
    // can render what is actually in force (profile config plus overrides).
    React.useEffect(function () {
      var cancelled = false
      settingsGet()
        .then(function (payload) {
          if (cancelled) return
          setSettings(payload)
          // Language can change here, and the whole dock has to re-render for it.
          if (applyLocale(payload)) setLocaleTick(function (value) { return value + 1 })
        })
        .catch(function (error) { if (!cancelled) setNote(tf('读取设置失败：{}', error.message)) })
      return function () { cancelled = true }
    }, [])

    /**
     * Save one switch and refresh the panel from the host.
     * @param {string} key - setting name.
     * @param {boolean|number|null} value - new value; null clears the override.
     */
    function saveSetting(key, value) {
      setBusy(true)
      setNote('')
      var patch = {}
      patch[key] = value
      settingsPost(patch)
        .then(function () {
          setNote(tf('已保存：{} = {}', key, value === null ? t('跟随配置') : String(value)))
          return settingsGet()
        })
        .then(function (payload) { setSettings(payload) })
        .catch(function (error) { setNote(tf('保存失败：{}', error.message)) })
        .finally(function () { setBusy(false) })
    }

    /**
     * One settings row: label, current source and a control.
     * @param {object} options - key, label, hint, control.
     * @returns {object} the row.
     */
    function settingRow(options) {
      var overridden = settings !== null && settings.overrides[options.key] !== undefined
      return h('div', { className: 'twt-srow', key: options.key },
        h('div', { className: 'twt-slabel' },
          h('b', null, options.label),
          h('span', { className: 'twt-hint' }, options.hint),
          h('span', { className: 'twt-ebadge', style: { color: overridden ? '#e0a458' : undefined } },
            overridden ? t('已覆盖') : t('跟随配置'))),
        h('div', { className: 'twt-scontrol' },
          options.control,
          overridden
            ? h('button', {
              className: 'twt-action',
              style: { padding: '2px 8px' },
              disabled: busy,
              onClick: function () { saveSetting(options.key, null) },
              title: t('恢复成 profile 配置里的值'),
            }, t('恢复默认'))
            : null))
    }

  
  /**
   * Options for the tokenizer dropdown.
   *
   * The payload carries whatever the backend found on disk, so dropping another
   * `tokenizer.json` in place makes it appear without touching this file.
   * @param {object|null} effective - effective settings.
   * @param {object|null} settings - full settings payload.
   * @returns {Array} React option elements.
   */
  function tokenizerOptions(effective, settings) {
    var choices = settings && settings.tokenizer && settings.tokenizer.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      choices = [{ id: 'auto', label: t('自动（最新一代）') }, { id: 'off', label: t('自主学习（不用词表）') }]
    }
    return choices.map(function (choice) {
      return h('option', { key: choice.id, value: choice.id }, t(choice.label))
    })
  }

  /**
   * Which option should be selected.
   *
   * A session that has not chosen anything shows the generation actually in use, so the
   * dropdown reflects reality rather than "auto".
   * @param {object|null} effective - effective settings.
   * @param {object|null} settings - full settings payload.
   * @returns {string} Option id.
   */
  function currentTokenizerChoice(effective, settings) {
    var requested = effective && effective.tokenizerVersion !== undefined ? String(effective.tokenizerVersion) : 'auto'
    if (requested !== '' && requested !== 'auto') return requested
    var active = settings && settings.tokenizer
    if (active && active.state === 'ready' && active.version) return String(active.version)
    return 'auto'
  }


  /**
   * Side-by-side view of the branches that leave one node.
   *
   * The point is comparison, not navigation: each column shows the branch's opening
   * question, what was concluded in it, and its cost, so "which line of thinking worked"
   * can be judged without scrolling back and forth in the transcript.
   * @param {object} props - nodes, parent, anchoredId, busy, onAnchor, onPick.
   * @returns {object} React element.
   */
  /**
   * The selected node's branches, listed in the detail panel.
   *
   * This replaces the old side-by-side tab: the graph shows the shape, this shows what each
   * branch actually concluded. Rows only appear for a node that has more than one branch,
   * because a single child is just the conversation continuing.
   * @param {object} props - nodes, parent, anchoredId, busy, onAnchor, onPick.
   * @returns {object|null} The list, or null when there is nothing to compare.
   */
  function BranchList(props) {
    var nodes = props.nodes || []
    var parent = props.parent
    if (parent === null || parent === undefined) return null
    var branches = nodes.filter(function (node) {
      return node.parentId === parent && node.kind !== 'answer' && node.kind !== 'tool_result'
    })
    if (branches.length < 2) return null
    var rows = branches.map(function (node) {
      var answer = nodes.find(function (candidate) {
        return candidate.parentId === node.id && candidate.kind === 'answer'
      })
      var isAnchored = props.anchoredId === node.id
      return h('div', {
        key: node.id,
        className: 'twt-branch-row',
        'data-anchored': String(isAnchored),
        onClick: function () { props.onPick(node.id) },
      },
        h('div', { className: 'twt-branch-head' },
          h('b', null, node.id),
          h('span', { className: 'twt-count' }, node.turn === undefined ? '' : ' ' + t('轮') + ' ' + node.turn),
          isAnchored ? h('span', { className: 'twt-ebadge' }, t('锚定中')) : null),
        h('div', { className: 'twt-branch-q' }, node.preview || t('（空问题）')),
        h('div', { className: 'twt-branch-a' }, answer === undefined
          ? h('span', { className: 'twt-hint' }, t('（这个分支还没有回答）'))
          : (answer.detail || answer.preview || t('（空）'))),
        h('div', { className: 'twt-branch-foot' },
          h('span', { className: 'twt-count' }, t('入边代价') + ' ' + String(node.pathCost === undefined ? '-' : node.pathCost)),
          h('button', {
            className: 'twt-action',
            disabled: props.busy,
            onClick: function (event) {
              event.stopPropagation()
              props.onAnchor(node.id)
            },
          }, isAnchored ? t('已锚定（重新确认）') : t('从这里继续'))))
    })
    return h('div', { className: 'twt-branches' },
      h('div', { className: 'twt-branches-head' }, tf('这个节点下有 {} 个分支：', branches.length)),
      rows)
  }

  var settingsPanel = null
    if (settings !== null) {
      // Defensive: an older or partial payload must not take the editor down.
    var effective = (settings && settings.effective) || {}
      settingsPanel = h('div', { className: 'twt-settings' },
        h('p', { className: 'twt-hint' },
          tf('这些开关立即生效，写入 {}，重启后仍然有效。', settings.path === null ? t('（未配置）') : settings.path)),
        settingRow({
          key: 'autoInject',
          label: t('自动注入记忆块'),
          hint: t('每回合把检索到的节点作为一块推到上下文里（实测约 428 token/轮）'),
          control: h('input', {
            type: 'checkbox',
            checked: effective.autoInject === true,
            disabled: busy,
            onChange: function (event) { saveSetting('autoInject', event.target.checked) },
          }),
        }),
        settingRow({
          key: 'retrievalHint',
          label: t('一行检索提示'),
          hint: t('不注入整块，只在尾部加一行提醒模型可以调用 retrieve_context（约 57 token/轮）'),
          control: h('input', {
            type: 'checkbox',
            checked: effective.retrievalHint === true,
            disabled: busy,
            onChange: function (event) { saveSetting('retrievalHint', event.target.checked) },
          }),
        }),
        settingRow({
          key: 'hintMinNodes',
          label: t('提示起始节点数'),
          hint: t('节点数达到这个值才开始发提示；被压缩过的会话不受此限，会立即提示'),
          control: h('input', {
            type: 'number',
            min: 1,
            step: 10,
            defaultValue: String(effective.hintMinNodes),
            disabled: busy,
            style: { width: '80px' },
            onBlur: function (event) {
              var next = Number(event.target.value)
              if (!Number.isFinite(next) || next <= 0) { event.target.value = String(effective.hintMinNodes); return }
              saveSetting('hintMinNodes', Math.round(next))
            },
          }),
        }),
        settingRow({
          key: 'autoReflect',
          label: t('自动反思与回溯'),
          hint: t('回合结束时评估失败、写反思节点，并把 Agent 拉回更优的兄弟分支'),
          control: h('input', {
            type: 'checkbox',
            checked: effective.autoReflect === true,
            disabled: busy,
            onChange: function (event) { saveSetting('autoReflect', event.target.checked) },
          }),
        }),
        settingRow({
          key: 'admitRelevance',
          label: t('检索准入阈值'),
          hint: t('原始相关度（余弦）达到这个值才进入排序，0 表示不设门槛；实测 0.3 召回不降、返回节点约少四成，0.5 会让七成查询空手（空手时会自动放宽一次）'),
          control: h('input', {
            type: 'number',
            min: 0,
            max: 1,
            step: 0.05,
            defaultValue: String(effective.admitRelevance === undefined ? 0.3 : effective.admitRelevance),
            disabled: busy,
            style: { width: '76px' },
            onBlur: function (event) {
              var next = Number(event.target.value)
              if (!Number.isFinite(next) || next < 0 || next > 1) {
                event.target.value = String(effective.admitRelevance === undefined ? 0.3 : effective.admitRelevance)
                return
              }
              saveSetting('admitRelevance', Math.round(next * 100) / 100)
            },
          }),
        }),
        settingRow({
          key: 'hintAboveTokens',
          label: t('提示起始 token 数'),
          hint: t('实测对话 token 达到这个值才发检索提示；有 tokenizer 时按实测、没有时按估算（并自动打 0.85 折）'),
          control: h('input', {
            type: 'number',
            min: 100,
            step: 1000,
            defaultValue: String(effective.hintAboveTokens === undefined ? 12000 : effective.hintAboveTokens),
            disabled: busy,
            style: { width: '92px' },
            onBlur: function (event) {
              var next = Number(event.target.value)
              if (!Number.isFinite(next) || next < 100) {
                event.target.value = String(effective.hintAboveTokens === undefined ? 12000 : effective.hintAboveTokens)
                return
              }
              saveSetting('hintAboveTokens', Math.round(next))
            },
          }),
        }),
        settingRow({
          key: 'tokenizerVersion',
          label: 'tokenizer',
          hint: t('下拉里列的是磁盘上实际找到的 tokenizer.json；「自主学习」不用词表，靠估算 + 账单校准，节点预算会自动打 0.85 折'),
          control: h('select', {
            defaultValue: currentTokenizerChoice(effective, settings),
            disabled: busy,
            style: { width: '184px' },
            onChange: function (event) {
              var next = String(event.target.value || '').trim()
              saveSetting('tokenizerVersion', next === '' || next === 'auto' ? null : next)
            },
          }, tokenizerOptions(effective, settings)),
        }),
        h('p', { className: 'twt-hint' },
          tf('tokenizer: {} · 可用 {} · 预算折扣 {} · 账单拟合 {}',
            settings.tokenizer === undefined
              ? t(t('（未知）'))
              : settings.tokenizer.state + (settings.tokenizer.version ? ' v' + settings.tokenizer.version : ''),
            settings.tokenizer === undefined || settings.tokenizer.available.length === 0
              ? t(t('无'))
              : settings.tokenizer.available.join(', '),
            settings.budget === undefined ? '-' : settings.budget.factor.toFixed(2),
            settings.billing === undefined ? '-' : (settings.billing.active ? t(t('生效')) : t(t('样本不足'))))),
        settings && settings.autoCompact && settings.autoCompact.estimate !== undefined && settings.autoCompact.estimate !== null
          ? h('p', { className: 'twt-hint' },
            tf('当前会话 {} tok；压缩一次会读 {} tok，之后每轮约省 {} tok，约 {} 轮回本（缓存价约为输入价的 1/10，实际花费远低于这些数字）',
              settings.autoCompact.tokens,
              settings.autoCompact.estimate.readTokens,
              settings.autoCompact.estimate.savedPerTurn,
              settings.autoCompact.estimate.turnsToBreakEven))
          : null,
        settingRow({
          key: 'autoCompactAboveTokens',
          label: t('自动压缩阈值'),
          hint: t('对话 token 超过这个值就主动压缩（0 = 关闭）。这是唯一能真正减少 input 的手段，代价是丢失细节'),
          control: h('input', {
            type: 'number',
            min: 0,
            step: 1000,
            defaultValue: String(effective.autoCompactAboveTokens === undefined ? 0 : effective.autoCompactAboveTokens),
            disabled: busy,
            style: { width: '92px' },
            onBlur: function (event) {
              var next = Number(event.target.value)
              if (!Number.isFinite(next) || next < 0) {
                event.target.value = String(effective.autoCompactAboveTokens === undefined ? 0 : effective.autoCompactAboveTokens)
                return
              }
              saveSetting('autoCompactAboveTokens', Math.round(next))
            },
          }),
        }),
        settingRow({
          key: 'toolDeny',
          label: t('隐藏工具'),
          hint: t('逗号分隔。工具 schema 是 prompt 的大头：实测隐藏 9 个工具可省 3,377 token/轮（−32%），且每轮都省。名字必须存在，否则整批被拒'),
          control: h('input', {
            type: 'text',
            defaultValue: ((settings && settings.overrides && Array.isArray(settings.overrides.toolDeny))
              ? settings.overrides.toolDeny.join(', ')
              : ''),
            disabled: busy,
            placeholder: 'workflow, schedule_create, ...',
            style: { width: '260px' },
            onBlur: function (event) {
              var raw = String(event.target.value || '')
              var names = raw.split(',').map(function (entry) { return entry.trim() }).filter(function (entry) { return entry !== '' })
              saveSetting('toolDeny', names.length === 0 ? null : names)
            },
          }),
        }),
        settings && settings.toolRestriction && settings.toolRestriction.applied === false && settings.toolRestriction.error
          ? h('p', { className: 'twt-hint twt-err' }, t('上次隐藏失败：') + settings.toolRestriction.error)
          : null,
        settingRow({
          key: 'foldAboveTokens',
          label: t('折叠历史阈值'),
          hint: t('超过这个 token 数就把旧的工具输出从模型视野里折叠掉（0 = 关闭）。用 surfaceOp replace，不调模型；原文留在日志与树里'),
          control: h('input', {
            type: 'number',
            min: 0,
            step: 1000,
            defaultValue: String(effective.foldAboveTokens === undefined ? 0 : effective.foldAboveTokens),
            disabled: busy,
            style: { width: '92px' },
            onBlur: function (event) {
              var next = Number(event.target.value)
              if (!Number.isFinite(next) || next < 0) {
                event.target.value = String(effective.foldAboveTokens === undefined ? 0 : effective.foldAboveTokens)
                return
              }
              saveSetting('foldAboveTokens', Math.round(next))
            },
          }),
        }),
        settingRow({
          key: 'foldScope',
          label: t('折叠范围'),
          hint: t('工具输出：只折叠旧的 tool/result。整轮：把整轮对话换成一个占位行（工具调用与结果一起消失，不会只剩一半）'),
          control: h('select', {
            className: 'twt-action',
            defaultValue: effective.foldScope === 'turns' ? 'turns' : 'tools',
            disabled: busy,
            onChange: function (event) { saveSetting('foldScope', event.target.value) },
          },
            h('option', { value: 'tools' }, t('工具输出')),
            h('option', { value: 'turns' }, t('整轮对话'))),
        }),
        settingRow({
          key: 'foldKeepTurns',
          label: t('保留最近轮数'),
          hint: t('最近这么多轮的工具输出不折叠，保证正在用的上下文完整'),
          control: h('input', {
            type: 'number',
            min: 0,
            step: 1,
            defaultValue: String(effective.foldKeepTurns === undefined ? 2 : effective.foldKeepTurns),
            disabled: busy,
            style: { width: '76px' },
            onBlur: function (event) {
              var next = Number(event.target.value)
              if (!Number.isFinite(next) || next < 0) {
                event.target.value = String(effective.foldKeepTurns === undefined ? 2 : effective.foldKeepTurns)
                return
              }
              saveSetting('foldKeepTurns', Math.round(next))
            },
          }),
        }),
        settings && settings.fold && settings.fold.folded > 0
          ? h('p', { className: 'twt-hint' },
            settings.foldScope === 'tools'
              ? tf('上次折叠：{} 条工具输出（会话 {} tok，阈值 {}）', settings.fold.folded, settings.fold.tokens, settings.fold.threshold)
              : tf('上次折叠：{} 轮对话（会话 {} tok，阈值 {}）', settings.fold.folded, settings.fold.tokens, settings.fold.threshold))
          : null,
        settings && settings.fold && settings.fold.error
          ? h('p', { className: 'twt-hint twt-err' }, tf('上次折叠被拒：{}', settings.fold.error))
          : null,
        settingRow({
          key: 'locale',
          label: t('界面语言'),
          hint: t('「自动」跟随浏览器/系统语言；选择后只影响这个插件，不影响宿主'),
          control: h('select', {
            defaultValue: (settings && typeof settings.locale === 'string') ? settings.locale : 'auto',
            disabled: busy,
            style: { width: '150px' },
            onChange: function (event) {
              var next = String(event.target.value || 'auto')
              setLocalePreference(next)
              saveSetting('locale', next === 'auto' ? null : next)
            },
          },
            h('option', { value: 'auto' }, t('自动')),
            h('option', { value: 'zh' }, t('中文')),
            h('option', { value: 'en' }, t('English'))),
        }),
        note === '' ? null : h('p', { className: 'twt-flash' }, note))
    } else {
      settingsPanel = h('div', { className: 'twt-settings' }, h('p', { className: 'twt-note' }, t('读取设置中…')), note === '' ? null : h('p', { className: 'twt-flash' }, note))
    }

    // Conversation mode is a live surface: new turns must appear without a click.
    React.useEffect(function () {
      if (!conversation) return undefined
      var timer = setInterval(load, 2000)
      return function () { clearInterval(timer) }
    }, [conversation, sessionId, mode])

    function anchor(nodeId) {
      setBusy(true)
      setNote('')
      focusRequest(sessionId, nodeId)
        .then(function (result) {
          setNote('已锚定 ' + nodeId + '（' + result.anchored.kind + '）：回到输入框提问，新问题会挂成它的子节点。')
          load()
          if (typeof onChanged === 'function') onChanged()
        })
        .catch(function (error) { setNote('锚定失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    function clearAnchor() {
      setBusy(true)
      setNote('')
      focusRequest(sessionId, null)
        .then(function () {
          setNote('已取消锚定，下一轮回到自动挂接。')
          load()
          if (typeof onChanged === 'function') onChanged()
        })
        .catch(function (error) { setNote('取消失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    /**
     * Enter two-click move mode for one branch.
     * @param {string} nodeId - branch to move.
     */
    function startMove(nodeId) {
      setMoveSource(nodeId)
      setPicked(nodeId)
      setNote('移动模式：点另一个节点作为它的新父节点（再按一次「取消移动」退出）。')
    }

    /** Leave two-click move mode without changing anything. */
    function cancelMove() {
      setMoveSource(null)
      setNote('已取消移动。')
    }

    /**
     * Complete two-click move mode.
     * @param {string} parentId - node clicked as the new parent.
     */
    function completeMove(parentId) {
      var source = moveSource
      setMoveSource(null)
      if (source === null || source === parentId) {
        setNote('没有移动：目标与源相同。')
        return
      }
      moveUnder(source, parentId)
    }

    /**
     * Move one branch under another node, remembering where it came from.
     *
     * The previous parent is captured from the payload before the request, so one
     * undo can put the branch back. The move itself is recorded in the durable edit
     * log, so the undo is simply the opposite reparent.
     * @param {string} source - node being moved.
     * @param {string} parentId - node it should hang under.
     */
    function moveUnder(source, parentId) {
      var known = nodeById[source] !== undefined ? nodeById[source] : byId[source]
      var previous = known === undefined ? undefined : known.parentId
      setBusy(true)
      setNote('')
      editRequest(sessionId, { action: 'reparent', nodeId: source, parentId: parentId })
        .then(function (result) {
          setNote('已把 ' + source + ' 移到 ' + parentId + ' 下（新入边代价 ' + result.moved.cost + '）。')
          if (previous !== undefined && previous !== null && previous !== parentId) {
            setLastMove({ nodeId: source, from: previous })
          } else {
            setLastMove(null)
          }
          setPicked(source)
          load()
          if (typeof onChanged === 'function') onChanged()
        })
        .catch(function (error) { setNote('移动失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    /** Undo the last move by reparenting back to where the branch came from. */
    function undoMove() {
      var move = lastMove
      if (move === null) return
      setLastMove(null)
      setNote('正在撤销移动…')
      moveUnder(move.nodeId, move.from)
    }

    /**
     * Hide one branch after a confirmation. The server keeps it, so undo is real:
     * the branch is marked deleted and comes back on restore.
     */
    function removeBranch(nodeId) {
      if (typeof window === 'undefined' || typeof window.confirm !== 'function') return
      if (!window.confirm('隐藏 ' + nodeId + ' 及其整个子树？之后可以点「撤销删除」恢复。')) return
      setBusy(true)
      setNote('')
      editRequest(sessionId, { action: 'remove', nodeId: nodeId })
        .then(function (result) {
          setNote('已隐藏 ' + nodeId + ' 分支（共 ' + result.removed.removed + ' 个节点），可撤销。')
          setRemoved(nodeId)
          setPicked(null)
          load()
          if (typeof onChanged === 'function') onChanged()
        })
        .catch(function (error) { setNote('删除失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    /** Undo the last delete by restoring the hidden branch. */
    function restoreBranch(nodeId) {
      setBusy(true)
      setNote('')
      editRequest(sessionId, { action: 'restore', nodeId: nodeId })
        .then(function () {
          setNote('已恢复 ' + nodeId + ' 分支。')
          setRemoved(null)
          setPicked(nodeId)
          load()
          if (typeof onChanged === 'function') onChanged()
        })
        .catch(function (error) { setNote('恢复失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    /** Restore every hidden branch in the bin, one at a time. */
    function restoreAll() {
      var ids = hiddenRows.map(function (row) { return row.id })
      if (ids.length === 0) return
      setBusy(true)
      setNote('')
      var chain = Promise.resolve()
      ids.forEach(function (id) {
        chain = chain.then(function () {
          return editRequest(sessionId, { action: 'restore', nodeId: id })
        })
      })
      chain
        .then(function () {
          setNote(tf('已恢复 {} 个分支。', ids.length))
          setRemoved(null)
          load()
          if (typeof onChanged === 'function') onChanged()
        })
        .catch(function (error) { setNote(tf('恢复失败：{}', error.message)) })
        .finally(function () { setBusy(false) })
    }

    /** The recycle bin: every hidden branch root, with a restore action. */
    function renderBasket() {
      if (hiddenRows.length === 0) {
        return h('p', { className: 'twt-note' }, t('回收站是空的：没有已隐藏的分支。'))
      }
      var rows = hiddenRows.map(function (row) {
        return h('div', { key: row.id, className: 'twt-erow twt-basket-row', title: row.preview },
          h('span', { className: 'twt-ekind', 'data-kind': row.kind }, kindLabel(row.kind)),
          h('span', { className: 'twt-id' }, row.id),
          h('span', { className: 'twt-q' }, row.preview || t('（空）')),
          h('span', { className: 'twt-count' }, tf('{} 节点 · {} tok', row.subtreeSize, row.tokens)),
          h('button', {
            className: 'twt-action',
            disabled: busy,
            onClick: function () { restoreBranch(row.id) },
          }, t('恢复此分支')))
      })
      var head = h('div', { className: 'twt-basket-head' },
        h('span', { className: 'twt-hint' }, tf('{} 个已隐藏分支 · 恢复后回到原位置', hiddenRows.length)),
        h('button', {
          className: 'twt-action',
          disabled: busy,
          onClick: function () { restoreAll() },
        }, t('全部恢复')))
      return h('div', { className: 'twt-basket' },
        head,
        h('div', { className: 'twt-elist twt-basket-list' }, rows))
    }

    /** Toggle a pin on one node. */
    function togglePin(nodeId, pinned) {
      setBusy(true)
      setNote('')
      editRequest(sessionId, { action: 'mark', nodeId: nodeId, pinned: pinned })
        .then(function () {
          setNote(pinned ? '已置顶 ' + nodeId + '：检索时更容易被召回。' : '已取消置顶 ' + nodeId + '。')
          load()
          if (typeof onChanged === 'function') onChanged()
        })
        .catch(function (error) { setNote('置顶失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    /** Toggle "ignore" on one node: retrieval drops it. */
    function toggleIgnore(nodeId, ignored) {
      setBusy(true)
      setNote('')
      editRequest(sessionId, { action: 'mark', nodeId: nodeId, ignored: ignored })
        .then(function () {
          setNote(ignored ? '已忽略 ' + nodeId + '：检索不再把它带回上下文。' : '已取消忽略 ' + nodeId + '。')
          load()
          if (typeof onChanged === 'function') onChanged()
        })
        .catch(function (error) { setNote('忽略失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    var data = view.data
    var byId = {}
    var nodeById = {}
    var entries = []

    if (data !== null && mode !== 'blocks' && data.nodes !== undefined) {
      data.nodes.forEach(function (node) {
        nodeById[node.id] = node
        if (hideTools && node.kind === 'tool_result') return
        entries.push({
          id: node.id,
          kind: node.kind,
          label: node.preview,
          depth: node.depth,
          cost: node.cost,
          tokens: node.tokens,
          pinned: node.pinned,
          ignored: node.ignored,
          origin: node.attached,
          turn: node.turn,
        })
      })
    } else if (data !== null && data.blocks !== undefined) {
      data.blocks.forEach(function (block) { byId[block.id] = block })
      var kids = { __root__: [] }
      data.blocks.forEach(function (block) {
        var parent = block.parentId !== null && byId[block.parentId] !== undefined ? block.parentId : '__root__'
        if (kids[parent] === undefined) kids[parent] = []
        kids[parent].push(block)
      })
      var seen = {}
      function walk(block, depth) {
        if (seen[block.id] === true || depth > 40) return
        seen[block.id] = true
        entries.push({
          id: block.id,
          kind: 'question',
          label: block.question,
          depth: depth,
          cost: block.cost,
          tokens: block.tokens,
          pinned: block.pinned,
          ignored: block.ignored,
          origin: block.origin,
          turn: block.turn,
        })
        var children = kids[block.id] || []
        for (var index = 0; index < children.length; index++) walk(children[index], depth + 1)
      }
      var roots = kids.__root__ || []
      for (var index = 0; index < roots.length; index++) walk(roots[index], 0)
    }

    /**
     * Select one entry and jump the transcript to it.
     * @param {object} entry - row from the active view (block or node).
     */
    /**
     * Select an entry. Kept separate from jumping: selecting is the common action.
     * @param {object} entry - list entry.
     */
    function pickEntry(entry) {
      // In move mode a click on a row picks the new parent, same as the graph.
      if (moveSource !== null) {
        completeMove(entry.id)
        return
      }
      setPicked(entry.id)
    }

    /**
     * Jump to an entry's turn, then close the editor so the transcript is visible.
     * @param {object} entry - list entry.
     */
    function jumpToEntry(entry) {
      if (moveSource !== null) return
      setPicked(entry.id)
      revealDeep(entry.label, entry.turn).then(function (found) {
        if (found && typeof onClose === 'function') onClose()
        if (!found) setNote(t('这条不在对话区当前渲染范围内（列表虚拟化），原文见右侧详情。'))
      })
    }

    /**
     * Select graph nodes by id and jump to them, same as the list.
     * @param {string} id - node id.
     */
    function pickNode(id) {
      if (moveSource !== null) {
        completeMove(id)
        return
      }
      setPicked(id)
    }

    /**
     * Jump from the graph to a node's turn and close the editor.
     * @param {string} id - node id.
     */
    function jumpToNodeById(id) {
      if (moveSource !== null) return
      var preview = ''
      var turn
      for (var index = 0; index < graphNodes.length; index++) {
        if (graphNodes[index].id === id) {
          preview = graphNodes[index].preview || ''
          turn = graphNodes[index].turn
          break
        }
      }
      setPicked(id)
      revealDeep(preview, turn).then(function (found) {
        if (found && typeof onClose === 'function') onClose()
        if (!found) setNote(t('这条不在对话区当前渲染范围内（列表虚拟化），原文见右侧详情。'))
      })
    }

    var anchoredId = data !== null && data.anchoredId !== undefined ? data.anchoredId : null
    var graphNodes = []
    var folded = {}
    if (data !== null && data.nodes !== undefined) {
      // Fold each answer into its question: one box per exchange, question as the
      // title and answer as the body. Children of the answer hang off the question,
      // so a tool result under an answer stays under the merged box.
      var graphById = {}
      data.nodes.forEach(function (node) { graphById[node.id] = node })
      data.nodes.forEach(function (node) {
        if (node.kind !== 'answer') return
        var parent = node.parentId === null ? undefined : graphById[node.parentId]
        if (parent !== undefined && parent.kind === 'question') folded[node.id] = parent.id
      })
      data.nodes.forEach(function (node) {
        if (folded[node.id] !== undefined) return
        if (hideTools && node.kind === 'tool_result') return
        var parentId = node.parentId
        while (parentId !== null && folded[parentId] !== undefined) parentId = folded[parentId]
        graphNodes.push({
          id: node.id,
          kind: node.kind,
          preview: node.preview,
          detail: node.detail,
          parentId: parentId,
          pinned: node.pinned,
          ignored: node.ignored,
          pathCost: node.pathCost,
          turn: node.turn,
        })
      })
    }
    // Hidden branch roots, newest first; the payload already filters inherited hides.
    var hiddenRows = (data !== null && Array.isArray(data.hidden)) ? data.hidden : []

    var selected = picked === null ? null : (byId[picked] !== undefined ? byId[picked] : (nodeById[picked] !== undefined ? nodeById[picked] : null))
    var selectedKind = selected === null ? '' : (selected.kind !== undefined ? selected.kind : 'question')

    var list = entries.map(function (entry) {
      return h('div', {
        key: entry.id,
        className: 'twt-erow',
        'data-picked': String(picked === entry.id),
        'data-anchored': String(anchoredId === entry.id),
        'data-drop': String(dropId === entry.id),
        'data-drag': String(dragId === entry.id),
        'data-ignored': String(entry.ignored === true),
        'data-kind': entry.kind,
        style: { marginLeft: (entry.depth * 12) + 'px' },
        draggable: true,
        onClick: function () { pickEntry(entry) },
        onDoubleClick: function () { jumpToEntry(entry) },
        title: t('单击选中；双击跳到对话中的这一轮'),
        onDragStart: function (event) {
          dragId = entry.id
          setDragId(entry.id)
          if (event.dataTransfer !== undefined) {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', entry.id)
          }
        },
        onDragOver: function (event) {
          if (dragId === null || dragId === entry.id) return
          event.preventDefault()
          if (event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
          if (dropId !== entry.id) setDropId(entry.id)
        },
        onDragLeave: function () { if (dropId === entry.id) setDropId(null) },
        onDrop: function (event) {
          event.preventDefault()
          var source = dragId
          dragId = null
          setDragId(null)
          setDropId(null)
          if (source !== null && source !== entry.id) moveUnder(source, entry.id)
        },
        onDragEnd: function () { dragId = null; setDragId(null); setDropId(null) },
        title: entry.label + '（拖到另一行可改父节点）',
      },
        h('span', { className: 'twt-ekind', 'data-kind': entry.kind }, kindLabel(entry.kind)),
        h('span', { className: 'twt-id' }, entry.id),
        h('span', { className: 'twt-q' }, entry.label),
        h('span', { className: 'twt-meta' },
          entry.origin === 'manual' ? h('span', { className: 'twt-ebadge' }, '手动') : null,
          entry.pinned === true ? h('span', { className: 'twt-ebadge' }, t('置顶')) : null,
          entry.ignored === true ? h('span', { className: 'twt-ebadge', style: { color: '#e06c75' } }, t('忽略')) : null,
          anchorTagged(anchoredId === entry.id),
          h('span', { className: 'twt-count' }, entry.tokens + 't'))
      )
    })

    var detail
    if (selected === null) {
      detail = h('p', { className: 'twt-hint' }, t('在左边选一个节点，然后点「从这里继续」。下一轮你输入的问题会成为它的子节点。'))
    } else if (mode !== 'blocks') {
      // Node view: every node type can be selected, so the detail shows the node's
      // own text and counters instead of a question/answer pair.
      detail = h(React.Fragment, null,
        h('div', { className: 'twt-dtitle' }, kindLabel(selectedKind) + ' ' + selected.id),
        h('div', { className: 'twt-dtext' }, selected.preview || t('（空）')),
        h('div', { className: 'twt-dgrid' },
          h('span', null, h('b', null, t('入边代价')), String(selected.cost)),
          h('span', null, h('b', null, t('距当前')), String(selected.pathCost)),
          h('span', null, h('b', null, t('深度')), String(selected.depth)),
          h('span', null, h('b', null, 'tokens'), String(selected.tokens)),
          h('span', null, h('b', null, t('父节点')), selected.parentId === null ? t('根') : String(selected.parentId)),
          h('span', null, h('b', null, t('状态')), selected.ignored === true ? t('已忽略') : (selected.pinned === true ? t('已置顶') : t('普通')))),
        h('div', { className: 'twt-actions' },
          h('button', {
            className: 'twt-action',
            'data-kind': 'primary',
            disabled: busy,
            onClick: function () { anchor(selected.id) },
          }, anchoredId === selected.id ? t('已锚定（重新确认）') : t('从这里继续')),
          anchoredId === null ? null : h('button', { className: 'twt-action', disabled: busy, onClick: clearAnchor }, t('取消锚定')),
          h('button', {
            className: 'twt-action',
            disabled: busy,
            onClick: function () { togglePin(selected.id, selected.pinned !== true) },
          }, selected.pinned === true ? t('取消置顶') : t('置顶')),
          h('button', {
            className: 'twt-action',
            disabled: busy,
            onClick: function () { toggleIgnore(selected.id, selected.ignored !== true) },
          }, selected.ignored === true ? t('取消忽略') : t('忽略')),
          h('button', {
            className: 'twt-action',
            disabled: busy,
            'data-kind': moveSource === selected.id ? 'primary' : undefined,
            onClick: function () {
              if (moveSource === selected.id) cancelMove()
              else startMove(selected.id)
            },
          }, moveSource === selected.id ? t('取消移动') : '移动此分支'),
          lastMove === null ? null : h('button', {
            className: 'twt-action',
            disabled: busy,
            onClick: undoMove,
            title: '把 ' + lastMove.nodeId + ' 移回 ' + lastMove.from,
          }, t('撤销移动')),
          removedId === null ? null : h('button', {
            className: 'twt-action',
            disabled: busy,
            onClick: function () { restoreBranch(removedId) },
            title: t('把刚才隐藏的分支恢复回来'),
          }, '撤销删除 ' + removedId),
          h('button', {
            className: 'twt-action',
            disabled: busy,
            onClick: function () { removeBranch(selected.id) },
          }, t('隐藏此分支'))))
    } else {
      // A block selected from the block view. Guard every field: a node row that
      // slipped into this branch used to throw and take the whole header down.
      var blockTools = selected.tools === undefined ? [] : selected.tools
      detail = h(React.Fragment, null,
        h('div', { className: 'twt-dtitle' }, '问题 ' + selected.id),
        h('div', { className: 'twt-dtext' }, selected.question || ''),
        h('div', { className: 'twt-dtitle' }, '回答'),
        h('div', { className: 'twt-dtext' }, selected.answer || '（还没有回答）'),
        h('div', { className: 'twt-dgrid' },
          h('span', null, h('b', null, '来源'), originLabel(selected.origin)),
          h('span', null, h('b', null, t('入边代价')), String(selected.cost)),
          h('span', null, h('b', null, t('距当前')), String(selected.pathCost)),
          h('span', null, h('b', null, t(t('工具'))), blockTools.length === 0 ? t('无') : String(blockTools.length))),
        blockTools.length === 0 ? null : h('div', { className: 'twt-tools' },
          blockTools.map(function (tool, index) {
            return h('span', { key: index, className: 'twt-tool', 'data-ok': String(tool.ok) }, tool.name)
          })),
        h('div', { className: 'twt-actions' },
          h('button', {
            className: 'twt-action',
            'data-kind': 'primary',
            disabled: busy,
            onClick: function () { anchor(selected.id) },
          }, anchoredId === selected.id ? t('已锚定（重新确认）') : t('从这里继续')),
          anchoredId === null ? null : h('button', {
            className: 'twt-action',
            disabled: busy,
            onClick: clearAnchor,
          }, t('取消锚定')),
          h('button', {
            className: 'twt-action',
            disabled: busy,
            onClick: function () { togglePin(selected.id, selected.pinned !== true) },
          }, selected.pinned === true ? t('取消置顶') : t('置顶')),
          h('button', {
            className: 'twt-action',
            disabled: busy,
            onClick: function () { toggleIgnore(selected.id, selected.ignored !== true) },
          }, selected.ignored === true ? t('取消忽略') : t('忽略')),
          h('button', {
            className: 'twt-action',
            disabled: busy,
            onClick: function () { removeBranch(selected.id) },
          }, '删除此分支')))
    }

    // The same workbench renders either inline (docked above the composer) or as a
    // modal. Inline is the point: sending, reading and editing happen in one view.
    var card = h('div', {
      className: (conversation ? 'twt-editor twt-editor-conv' : 'twt-editor') + (props.docked ? ' twt-editor-docked' : ''),
      role: 'dialog',
      'aria-label': '盆栽编辑器',
    },
        h('div', { className: 'twt-editor-head' },
          h('b', null, conversation ? t('盆栽') : t('盆栽（树编辑器）')),
          data === null ? null : h('span', { className: 'twt-count' }, mode === 'nodes'
            ? data.stats.nodes + ' 节点 · ' + data.stats.questions + ' 问 · ' + data.stats.answers + ' 答 · ' + data.stats.tools + ' 工具'
            : data.stats.blocks + ' 块 · ' + data.stats.branches + ' 分支 · ' + data.stats.tokens + ' tok'),
          anchoredId === null ? null : h('span', { className: 'twt-ebadge', style: { color: '#e0a458' } }, '锚定中 ' + anchoredId),
          h('button', {
            className: 'twt-action',
            style: { marginLeft: 'auto', padding: '3px 10px' },
            'data-kind': mode === 'blocks' ? 'primary' : undefined,
            onClick: function () { setMode('blocks'); setPicked(null) },
          }, t('对话块')),
          h('button', {
            className: 'twt-action',
            style: { padding: '3px 10px' },
            'data-kind': mode === 'nodes' ? 'primary' : undefined,
            onClick: function () { setMode('nodes'); setPicked(null) },
          }, t('完整树')),
          h('button', {
            className: 'twt-action',
            style: { padding: '3px 10px' },
            'data-kind': mode === 'recycle' ? 'primary' : undefined,
            onClick: function () { setMode('recycle'); setPicked(null) },
          }, t('回收站') + (hiddenRows.length === 0 ? '' : ' ' + hiddenRows.length)),
          h('button', {
            className: 'twt-action',
            style: { padding: '3px 10px' },
            'data-kind': mode === 'graph' ? 'primary' : undefined,
            onClick: function () { setMode('graph'); setPicked(null) },
          }, t('图形')),

          h('button', {
            className: 'twt-action',
            style: { padding: '3px 10px' },
            'data-kind': mode === 'settings' ? 'primary' : undefined,
            onClick: function () { setMode('settings'); setPicked(null) },
          }, t('设置')),
          mode !== 'blocks' ? h('label', { className: 'twt-hint', style: { display: 'flex', alignItems: 'center', gap: '4px' } },
            h('input', {
              type: 'checkbox',
              checked: hideTools,
              onChange: function (event) { setHideTools(event.target.checked) },
            }), t('隐藏工具结果')) : null,
          h('button', { className: 'twt-action', style: { padding: '3px 10px' }, onClick: load }, t('刷新')),
          h('button', { className: 'twt-close', onClick: onClose, title: t('关闭') }, '✕')),
        h('div', { className: 'twt-editor-body' },
          mode === 'settings'
            ? settingsPanel
            : h(React.Fragment, null,
              h('div', {
                className: mode === 'graph' ? 'twt-elist twt-elist-graph' : 'twt-elist',
              },
                view.loading ? h('p', { className: 'twt-note' }, t('读取中…'))
                  : view.error ? h('p', { className: 'twt-note twt-err' }, view.error)
                    : mode === 'recycle'
                      ? renderBasket()
                      : mode === 'graph'
                      ? h(TreeGraph, {
                        nodes: graphNodes,
                        selectedId: picked,
                        anchoredId: anchoredId,
                        focusId: data === null ? '' : (folded[data.focusId] === undefined ? data.focusId : folded[data.focusId]),
                        moveSource: moveSource,
                        onMoveTarget: completeMove,
                        onPick: pickNode,
                        onJump: jumpToNodeById,
                      })
                      : entries.length === 0 ? h('p', { className: 'twt-note' }, mode === 'nodes' ? t('这个会话还没有节点。') : t('这个会话还没有对话块。'))
                        : list),
              h('div', { className: 'twt-edetail' },
                detail,
                h(BranchList, {
                  nodes: data === null ? [] : data.nodes,
                  parent: picked,
                  anchoredId: anchoredId,
                  busy: busy,
                  onAnchor: anchor,
                  onPick: setPicked,
                }),
                h('p', { className: 'twt-hint' },
                  t('拖动一行到另一行可以改父节点（整棵子树一起移动）；删除只是隐藏，可撤销。')
                  + t('锚定只影响下一轮：你回到对话输入框发出的那条问题会挂到锚定节点下。')),
                note === '' ? null : h('p', { className: 'twt-flash' }, note)))))
    if (props.docked) return card
    return h('div', {
      className: conversation ? 'twt-eoverlay twt-eoverlay-conv' : 'twt-eoverlay',
      onClick: function (event) { if (event.target === event.currentTarget) onClose() },
    }, card)
  }

  /**
   * Truncate text to the pixel width of a box, ending with an ellipsis.
   *
   * SVG text does not clip itself, and a fixed character count overflows as soon as
   * a label mixes CJK (about one em per glyph) with Latin (about half an em).
   * @param {string} text - source text.
   * @param {number} fontSize - rendered size in px.
   * @param {number} maxWidth - available width in px.
   * @returns {string} text that fits, or text + '…'.
   */
  function fitText(text, fontSize, maxWidth) {
    var source = String(text === undefined || text === null ? '' : text)
    if (source.length === 0) return ''
    var width = 0
    var out = ''
    for (var index = 0; index < source.length; index++) {
      var char = source.charAt(index)
      // Full-width glyphs (CJK, full-width punctuation) occupy roughly one em.
      var charWidth = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(char)
        ? fontSize
        : fontSize * 0.56
      if (width + charWidth > maxWidth - fontSize) return out + '…'
      width += charWidth
      out += char
    }
    return out
  }

  /** Short label for a node kind. */
  function kindLabel(kind) {
    if (kind === 'question') return t(t('问'))
    if (kind === 'answer') return t(t('答'))
    if (kind === 'tool_result') return '具'
    if (kind === 'reflection') return '思'
    if (kind === 'note') return '记'
    if (kind === 'goal') return '标'
    return '·'
  }

  /** Small "锚定" badge, or nothing. */
  function anchorTagged(on) {
    return on ? h('span', { className: 'twt-ebadge', style: { color: '#e0a458' } }, '锚定') : null
  }

  /** Human label for a block origin. */
  function originLabel(origin) {
    if (origin === 'manual') return '用户手动'
    if (origin === 'auto') return '系统自动'
    if (origin === 'topic') return '新话题'
    return '顺接上一轮'
  }

  /**
   * The tree, seated in the conversation column right above the composer.
   *
   * This is the answer to "don't make me switch between the graph and the chat":
   * one line while collapsed (current branch path), and an in-place expansion that
   * pushes the transcript up instead of covering it with a floating window. Every
   * action — continue from here, pin, ignore, reparent, delete — writes through the
   * same `/api/token-tree/*` routes the full editor uses, so both surfaces agree.
   * @param {object} props - `{ session, input }` from the input dock slot.
   * @returns {object} rendered element.
   */
  function TreeDock(props) {
    ensureStyles()
    // The dock slot is session-scoped, but which prop carries the session depends on
    // the host: the composer dock passes `sessionId`, an input dock passed `session`.
    var session = props === undefined ? undefined : (props.session === undefined ? props.sessionId : props.session)
    var sessionId = typeof session === 'string'
      ? session
      : session !== null && typeof session === 'object'
        ? (session.id || session.sessionId || '')
        : ''

    // The host drops this slot while the transcript is momentarily "blank" (which is
    // exactly what a jump to an old turn causes), so the component remounts. Remember
    // whether the user had it open, or a jump would silently collapse it.
    var openKey = 'twt-dock-open:' + sessionId
    var openState = React.useState(function () {
      try {
        return window.sessionStorage.getItem(openKey) === '1'
      } catch (error) {
        return false
      }
    })
    var isOpen = openState[0]
    var setOpen = openState[1]
    React.useEffect(function () {
      try {
        window.sessionStorage.setItem(openKey, isOpen ? '1' : '0')
      } catch (error) {
        // Private mode or storage disabled: the dock just opens collapsed each time.
      }
    }, [isOpen, openKey])
    var viewState = React.useState({ loading: true, data: null, error: null })
    var view = viewState[0]
    var setView = viewState[1]
    // Bumped when the interface language changes; the dock renders its own strings.
    var dockLocaleState = React.useState(0)
    var dockLocaleTick = dockLocaleState[0]
    var setDockLocale = dockLocaleState[1]
    var pickState = React.useState(null)
    var picked = pickState[0]
    var setPicked = pickState[1]
    var anchorState = React.useState(null)
    var anchoredId = anchorState[0]
    var setAnchored = anchorState[1]

    // Last hidden branch, so one click can restore it.
    var removedState = React.useState(null)
    var removedId = removedState[0]
    var setRemoved = removedState[1]
    var moveState = React.useState(null)
    var moveSource = moveState[0]
    var setMoveSource = moveState[1]
    var noteState = React.useState('')
    var note = noteState[0]
    var setNote = noteState[1]
    var busyState = React.useState(false)
    var busy = busyState[0]
    var setBusy = busyState[1]
    var tickState = React.useState(0)
    var tick = tickState[0]
    var setTick = tickState[1]
    // Graph first: that is the point of the dock. The list stays available for a
    // dense, text-first read.
    var modeState = React.useState('graph')
    var mode = modeState[0]
    var setMode = modeState[1]
    // Node boxes are id-only unless the user asks for the full two-line cards.
    var compactState = React.useState(true)
    var compact = compactState[0]
    var setCompact = compactState[1]
    var lastMoveState = React.useState(null)
    var lastMove = lastMoveState[0]
    var setLastMove = lastMoveState[1]

    // Expanded state only drives the spacing rule around the dock.
    var rootRef = React.useRef(null)

    // Expanded state only drives the widening rule. Hiding the host's composer stats
    // is deliberately gone: two attempts, one broke the restore on collapse, and the
    // right-hand context meter was never reachable from our container.
    React.useEffect(function () {
      if (typeof document === 'undefined') return undefined
      document.body.classList.toggle('twt-dock-expanded', isOpen)
      return function () { document.body.classList.remove('twt-dock-expanded') }
    }, [isOpen])

    function load() {
      var params = sessionId === '' ? [] : ['session=' + encodeURIComponent(sessionId)]
      params.push('view=nodes')
      var url = ROUTE + '?' + params.join('&')
      fetch(url, { credentials: 'same-origin' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        })
        .then(function (data) {
          setView({ loading: false, data: data, error: null })
          if (data.anchoredId !== undefined && data.anchoredId !== null) setAnchored(data.anchoredId)
        })
        .catch(function (error) { setView({ loading: false, data: null, error: '读取失败：' + error.message }) })
    }

    // One fetch on mount so the collapsed line can show counts; while expanded it
    // keeps polling, because turns finish without the dock being touched.
    React.useEffect(function () {
      load()
      if (!isOpen) return undefined
      var timer = setInterval(load, 3000)
      return function () { clearInterval(timer) }
    }, [isOpen, sessionId, tick])

    /** Anchor the next message on one block, or clear the anchor. */
    function anchor(id) {
      setBusy(true)
      setNote('')
      focusRequest(sessionId, id)
        .then(function () {
          setAnchored(id)
          setNote(id === null ? '已取消锚定，下一轮回到自动挂接。' : '已锚定 ' + id + '：下一条消息会挂成它的子节点。')
          setTick(tick + 1)
        })
        .catch(function (error) { setNote('锚定失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    /** Toggle a pin: pinned blocks are recalled more readily. */
    function togglePin(id, pinned) {
      setBusy(true)
      setNote('')
      editRequest(sessionId, { action: 'mark', nodeId: id, pinned: pinned })
        .then(function () {
          setNote(pinned ? '已置顶 ' + id + '。' : '已取消置顶 ' + id + '。')
          setTick(tick + 1)
        })
        .catch(function (error) { setNote('置顶失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    /** Toggle "ignore": retrieval stops bringing the block back. */
    function toggleIgnore(id, ignored) {
      setBusy(true)
      setNote('')
      editRequest(sessionId, { action: 'mark', nodeId: id, ignored: ignored })
        .then(function () {
          setNote(ignored ? '已忽略 ' + id + '。' : '已取消忽略 ' + id + '。')
          setTick(tick + 1)
        })
        .catch(function (error) { setNote('忽略失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    /** Remove one branch, with the same confirmation the editor asks for. */
    /** Hide one branch; the server keeps it, so the side rail can restore it. */
    function removeBranch(id) {
      if (typeof window === 'undefined' || typeof window.confirm !== 'function') return
      if (!window.confirm('隐藏 ' + id + ' 及其整个子树？之后可以点「撤销删除」恢复。')) return
      setBusy(true)
      setNote('')
      editRequest(sessionId, { action: 'remove', nodeId: id })
        .then(function (result) {
          setNote('已隐藏 ' + id + ' 分支（' + result.removed.removed + ' 个节点），可撤销。')
          setRemoved(id)
          setPicked(null)
          setTick(tick + 1)
        })
        .catch(function (error) { setNote('删除失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    /** Undo the last hide. */
    function restoreBranch(id) {
      setBusy(true)
      setNote('')
      editRequest(sessionId, { action: 'restore', nodeId: id })
        .then(function () {
          setNote('已恢复 ' + id + ' 分支。')
          setRemoved(null)
          setPicked(id)
          setTick(tick + 1)
        })
        .catch(function (error) { setNote('恢复失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    /** Second click of the two-click move: hang the source under this node. */
    function completeMove(parentId) {
      var source = moveSource
      setMoveSource(null)
      if (source === null || source === parentId) {
        setNote('没有移动：目标与源相同。')
        return
      }
      reparent(source, parentId)
    }

    /**
     * Reparent one node and remember the old parent for one undo.
     * @param {string} source - node to move.
     * @param {string} parentId - new parent.
     */
    function reparent(source, parentId) {
      var previous = nodeById[source] === undefined ? undefined : nodeById[source].parentId
      setBusy(true)
      setNote('')
      editRequest(sessionId, { action: 'reparent', nodeId: source, parentId: parentId })
        .then(function (result) {
          setNote('已把 ' + source + ' 挂到 ' + parentId + ' 下（新入边代价 ' + result.moved.cost + '）。')
          if (previous !== undefined && previous !== null && previous !== parentId) {
            setLastMove({ nodeId: source, from: previous })
          } else {
            setLastMove(null)
          }
          setPicked(source)
          setTick(tick + 1)
        })
        .catch(function (error) { setNote('移动失败：' + error.message) })
        .finally(function () { setBusy(false) })
    }

    /** Click one row or graph box: select it and jump the transcript to its turn. */
    /**
     * Mark a node as selected. Selecting must not scroll the transcript: the host remounts
     * this slot while it pages history, so a jump used to close the dock on every click.
     * @param {object} node - node payload.
     */
    function pickNode(node) {
      if (moveSource !== null) {
        completeMove(node.id)
        return
      }
      setPicked(node.id)
    }

    /**
     * Scroll the transcript to the node's turn. Bound to a double click.
     * @param {object} node - node payload.
     */
    function jumpToNode(node) {
      if (moveSource !== null) return
      revealDeep(node.preview || '', node.turn).then(function (found) {
        if (!found) setNote('已选中 ' + node.id + '；这条不在对话区当前渲染范围内（列表虚拟化）。')
      })
    }

    var data = view.data
    var nodes = data !== null && data.nodes !== undefined ? data.nodes : []
    var nodeById = {}
    nodes.forEach(function (node) { nodeById[node.id] = node })
    var focusId = data === null ? '' : data.focusId

    // Answers fold into their question, exactly like the full editor's graph, so the
    // dock draws one box per exchange. Declared outside the `data !== null` branch:
    // the first render has no payload yet, and reading it there used to throw and
    // take the whole dock down.
    var graphNodes = []
    var folded = {}
    if (data !== null) {
      nodes.forEach(function (node) {
        if (node.kind !== 'answer') return
        var parent = node.parentId === null ? undefined : nodeById[node.parentId]
        if (parent !== undefined && parent.kind === 'question') folded[node.id] = parent.id
      })
      nodes.forEach(function (node) {
        if (folded[node.id] !== undefined) return
        var parentId = node.parentId
        while (parentId !== null && folded[parentId] !== undefined) parentId = folded[parentId]
        graphNodes.push({
          id: node.id,
          kind: node.kind,
          preview: node.preview,
          detail: node.detail,
          parentId: parentId,
          pinned: node.pinned,
          ignored: node.ignored,
          pathCost: node.pathCost,
          turn: node.turn,
        })
      })
    }

    var pickedNode = picked === null ? undefined : nodeById[picked]

    // Where the focus sits, in one line: the ancestor chain of the current node.
    var path = []
    var cursor = focusId === '' ? undefined : nodeById[focusId]
    var guard = 0
    while (cursor !== undefined && guard < 200) {
      path.unshift(cursor.id)
      cursor = cursor.parentId === null ? undefined : nodeById[cursor.parentId]
      guard++
    }

    var bar = h('div', {
      className: 'twt-dockbar',
      onClick: function () { setOpen(!isOpen) },
      title: isOpen ? t('收起（输入框始终可用）') : t('就地展开盆栽（对话树），不离开对话区'),
    },
      h('span', { className: 'twt-docktitle' }, t(t('🌳 盆栽'))),
      h('span', { className: 'twt-count' }, data === null
        ? (view.loading ? t('读取中…') : '')
        : data.stats.nodes + ' 节点 · ' + data.stats.questions + ' 问'),
      // The full ancestor chain is unreadable in one line; keep the last few hops.
      h('span', { className: 'twt-dockpath', title: path.join(' › ') },
        path.length === 0
          ? '（还没有块）'
          : (path.length > 5 ? '… › ' + path.slice(-4).join(' › ') : path.join(' › '))),
      h('button', {
        className: 'twt-action',
        style: { padding: '2px 8px' },
        'data-kind': mode === 'graph' ? 'primary' : undefined,
        onClick: function (event) { event.stopPropagation(); setMode('graph') },
      }, t('图形')),
      h('button', {
        className: 'twt-action',
        style: { padding: '2px 8px' },
        'data-kind': mode === 'list' ? 'primary' : undefined,
        onClick: function (event) { event.stopPropagation(); setMode('list') },
      }, t('列表')),
      mode === 'graph' ? h('button', {
        className: 'twt-action',
        style: { padding: '2px 8px' },
        'data-kind': compact ? undefined : 'primary',
        title: t('在只显示节点号和显示问题/回答摘要之间切换'),
        onClick: function (event) { event.stopPropagation(); setCompact(!compact) },
      }, compact ? t('详细') : t('精简')) : null,
      h('span', { className: 'twt-hint' }, isOpen ? t('收起') : t('展开')))

    var rows = nodes.map(function (node) {
      return h('div', {
        key: node.id,
        className: 'twt-dockrow',
        style: { paddingLeft: 6 + node.depth * 12 },
        'data-picked': String(picked === node.id),
        'data-focus': String(node.id === focusId),
        'data-future': String(moveSource !== null && moveSource !== node.id),
        'data-ignored': String(node.ignored === true),
        onClick: function () { pickNode(node) },
        onDoubleClick: function () { jumpToNode(node) },
        title: t('单击选中（操作在右侧）；双击跳到对话中的这一轮'),
      },
        h('span', { className: 'twt-ekind', 'data-kind': node.kind }, kindLabel(node.kind)),
        h('span', { className: 'twt-id' }, node.id),
        h('span', { className: 'twt-q' }, node.preview || t('（空）')),
        node.pinned === true ? h('span', { className: 'twt-ebadge' }, t('置顶')) : null,
        node.ignored === true ? h('span', { className: 'twt-ebadge', style: { color: '#e06c75' } }, t('忽略')) : null)
    })

    // Right rail: the selected node and every action, stacked, so the graph keeps the
    // whole width while the buttons stay in one predictable column.
    var side = h('div', { className: 'twt-dockside' },
      pickedNode === undefined
        ? h('p', { className: 'twt-hint' }, t('在左边点一个节点，操作会出现在这里。'))
        : h(React.Fragment, null,
          h('div', { className: 'twt-dtitle' }, kindLabel(pickedNode.kind) + ' ' + pickedNode.id),
          h('div', { className: 'twt-dtext' }, pickedNode.detail === undefined ? (pickedNode.preview || '') : (pickedNode.preview + '\n\n' + pickedNode.detail)),
          h('div', { className: 'twt-dgrid' },
            h('span', null, h('b', null, '代价'), String(pickedNode.cost)),
            h('span', null, h('b', null, 'turn'), String(pickedNode.turn === undefined ? '-' : pickedNode.turn))),
          h('div', { className: 'twt-dockactions twt-dockactions-vertical' },
            h('button', {
              className: 'twt-action',
              'data-kind': 'primary',
              disabled: busy,
              onClick: function () { anchor(picked) },
            }, anchoredId === picked ? '重新锚定' : '在这里继续'),
            anchoredId === null ? null : h('button', {
              className: 'twt-action',
              disabled: busy,
              onClick: function () { setAnchored(null); anchor(null) },
            }, t('取消锚定')),
            h('button', {
              className: 'twt-action',
              disabled: busy,
              onClick: function () { togglePin(picked, pickedNode.pinned !== true) },
            }, pickedNode.pinned === true ? t('取消置顶') : t('置顶')),
            h('button', {
              className: 'twt-action',
              disabled: busy,
              onClick: function () { toggleIgnore(picked, pickedNode.ignored !== true) },
            }, pickedNode.ignored === true ? t('取消忽略') : t('忽略')),
            h('button', {
              className: 'twt-action',
              disabled: busy,
              onClick: function () { setMoveSource(moveSource === picked ? null : picked) },
            }, moveSource === picked ? t('取消移动') : '改挂…'),
            lastMove === null ? null : h('button', {
              className: 'twt-action',
              disabled: busy,
              onClick: function () { var move = lastMove; setLastMove(null); reparent(move.nodeId, move.from) },
            }, t('撤销移动')),
            removedId === null ? null : h('button', {
              className: 'twt-action',
              disabled: busy,
              onClick: function () { restoreBranch(removedId) },
              title: t('把刚才隐藏的分支恢复回来'),
            }, '撤销删除 ' + removedId),
            h('button', {
              className: 'twt-action',
              disabled: busy,
              onClick: function () { removeBranch(picked) },
            }, t('隐藏此分支')))),
      note === '' ? null : h('p', { className: 'twt-flash' }, note))

    var main = mode === 'graph'
      ? h(TreeGraph, {
        nodes: graphNodes,
        selectedId: picked,
        anchoredId: anchoredId,
        // The current node is often an answer, which folds into its question; centre
        // on the surviving box instead of a node that is not drawn.
        focusId: folded[focusId] === undefined ? focusId : folded[focusId],
        // Compact by default in the dock: the conversation column is narrow, and the
        // full text already sits in the right rail.
        compact: compact !== false,
        moveSource: moveSource,
        onMoveTarget: completeMove,
        onPick: function (id) { pickNode(nodeById[id] === undefined ? { id: id } : nodeById[id]) },
        onJump: function (id) { jumpToNode(nodeById[id] === undefined ? { id: id } : nodeById[id]) },
      })
      : h('div', { style: { overflow: 'auto', flex: 1, minHeight: 0 } }, rows)

    var body = isOpen ? h('div', { className: 'twt-dockbody' },
      h('div', { className: 'twt-dockmain' },
        view.error === null ? null : h('p', { className: 'twt-note twt-err' }, view.error),
        main),
      side) : null

    // The bar always renders: a failure inside the body must not take the whole dock
    // (and therefore the tree button) off the screen. `.twt-dock-panel` is the piece
    // that becomes the overlay when expanded, so it can cover the composer stats
    // sitting on both sides of this row.
    return h('div', { className: 'twt-dock', ref: rootRef, 'data-locale-tick': String(dockLocaleTick) },
      h('div', { className: 'twt-dock-panel' }, bar, h(DockBoundary, null, body)))
  }

  /**
   * Keeps one bad render inside the dock body from unmounting the whole dock.
   *
   * The host has no boundary around slot content, so an exception here used to make
   * the dock disappear entirely — exactly what happened when the first render read a
   * variable that only exists once the payload arrives.
   */
  class DockBoundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { failed: false }
    }

    static getDerivedStateFromError() {
      return { failed: true }
    }

    componentDidCatch(error) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-token-tree] dock body failed:', error && error.message ? error.message : error)
      }
    }

    render() {
      if (this.state.failed) {
        return h('div', { className: 'twt-dockbody' },
          h('p', { className: 'twt-note twt-err' }, '树面板渲染出错，已隔离；刷新页面可恢复。'))
      }
      return this.props.children
    }
  }

  /**
   * The single header entry point: detail and settings of this conversation's tree.
   *
   * There used to be two buttons — a floating preview and a graph overlay — but both
   * duplicated what the dock above the composer already offers, and three surfaces
   * competing for one feature is worse than one. This button opens the full editor,
   * which holds every view (blocks / full tree / graph) and the action pane.
   * @param {object} props - `{ sessionId }` from the header actions slot.
   * @returns {object} the button plus its editor portal.
   */
  function TreeButton(props) {
    ensureStyles()
    var sessionId = props.sessionId
    var editorState = React.useState(false)
    var editorOpen = editorState[0]
    var setEditorOpen = editorState[1]
    var tickState = React.useState(0)
    var tick = tickState[0]
    var setTick = tickState[1]

    var button = h('button', {
      className: 'twt-btn',
      'data-active': String(editorOpen),
      onClick: function () { setEditorOpen(!editorOpen) },
      title: t('盆栽：对话树的详细信息与设置'),
    }, h('span', null, t('盆栽')))

    var editor = null
    if (editorOpen && typeof document !== 'undefined') {
      editor = createPortal(h(TreeEditor, {
        sessionId: sessionId,
        onClose: function () { setEditorOpen(false) },
        onChanged: function () { setTick(tick + 1) },
      }), document.body)
    }
    // A render error anywhere below must cost the view, not the header button: the
    // shell unmounts a slot whose component throws.
    return h(TreeBoundary, null,
      h('span', { className: 'twt-actions-row' }, button),
      editor)
  }

  /**
   * Keeps one bad render from unmounting the whole header action.
   *
   * A node selected in the graph used to walk into the block-detail branch and
   * throw, which made React remove the slot component — and with it the "树" button.
   */
  class TreeBoundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { failed: false }
    }

    static getDerivedStateFromError() {
      return { failed: true }
    }

    componentDidCatch(error) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-token-tree] view failed:', error && error.message ? error.message : error)
      }
    }

    render() {
      if (this.state.failed) {
        return h('button', {
          className: 'twt-btn',
          onClick: function () { window.location.reload() },
          title: t('视图渲染出错，刷新页面可恢复'),
        }, '树（重载）')
      }
      return this.props.children
    }
  }

  // Only the slot registry is required: the panel reads the tree from the plugin's
  // exact `/api` route with the page's own cookie, so no RPC service is involved.
  // A throwing apply here must never take the shell down.
  exports.inject = ['slots']
  exports.apply = function apply(ctx) {
    try {
      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'token-tree',
          order: 30,
        }, TreeButton)
      })
    } catch (error) {
      // A slot that is absent, renamed, or already occupied must cost the button,
      // not the application shell.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-token-tree] client registration skipped:', error && error.message ? error.message : error)
      }
    }

    // The dock is the embedded surface: `conversation.composer.dock` is the
    // session-scoped list slot rendered inside the conversation column, directly
    // above the input. Registered separately from the header button so a host that
    // lacks one still keeps the other.
    try {
      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'token-tree',
          order: 10,
        }, TreeDock)
      })
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-token-tree] composer dock registration skipped:', error && error.message ? error.message : error)
      }
    }
  }

  return module.exports
} })
