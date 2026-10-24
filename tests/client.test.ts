import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const React = require('react')
const ReactDOMClient = require('react-dom/client')

/**
 * The browser half is a script that registers itself on `window.__ModuleLoader__`, so the
 * harness supplies that registry, a `require` for the two platform modules, jsdom globals
 * and a fetch stub. Everything after that is the real component code: no component mocks,
 * which is the point of testing this at all.
 */

/** Tree payload: one exchange, then two sibling branches under it. */
function treePayload() {
  return {
    sessionId: 'session-1',
    focusId: 'n4',
    anchoredId: null,
    stats: { nodes: 6, questions: 3, answers: 2, tools: 1, blocks: 3, branches: 2, tokens: 120 },
    hidden: [{ id: 'n5', kind: 'question', preview: '分支 B：直接换哈希表呢？', parentId: 'n2', subtreeSize: 1, tokens: 14 }],
    constraints: [{ id: 'rule-1', text: '发布前必须先问我', createdAt: 1, source: 'manual' }],
    nodes: [
      { id: 'n1', kind: 'note', preview: 'session root', detail: 'session root', parentId: null, tokens: 3, cost: 0, pathCost: 0, depth: 0, turn: 0 },
      { id: 'n2', kind: 'question', preview: '第一个问题：布隆过滤器的误判率由什么决定？', detail: '第一个问题', parentId: 'n1', tokens: 30, cost: 1, pathCost: 1, depth: 1, turn: 1 },
      { id: 'n3', kind: 'answer', preview: '由位数组大小和哈希函数个数共同决定。', detail: '由位数组大小和哈希函数个数共同决定。', parentId: 'n2', tokens: 24, cost: 1, pathCost: 2, depth: 2, turn: 1 },
      { id: 'n4', kind: 'question', preview: '分支 A：换成计数布隆过滤器会怎样？', detail: '', parentId: 'n2', tokens: 18, cost: 1, pathCost: 3, depth: 2, turn: 2 },
      { id: 'n5', kind: 'question', preview: '分支 B：直接换哈希表呢？', detail: '', parentId: 'n2', tokens: 14, cost: 1, pathCost: 3, depth: 2, turn: 2 },
      { id: 'n6', kind: 'tool_result', preview: 'ran probe: exit 0', detail: 'ran probe: exit 0', parentId: 'n4', tokens: 9, cost: 1, pathCost: 4, depth: 3, turn: 2 },
    ],
  }
}

/** Settings payload as the host serves it, including the dropdown choices. */
function settingsPayload(preset = null) {
  const aggressive = preset === 'aggressive'
  const balanced = preset === 'balanced'
  return {
    path: 'C:/tmp/settings.json',
    overrides: aggressive
      ? { toolDeny: ['workflow'], foldAboveTokens: 20000 }
      : Array.isArray(settingsPayload.hiddenTools)
        ? { toolDeny: settingsPayload.hiddenTools }
        : {},
    base: { autoInject: false, retrievalHint: true, autoReflect: true, hintMinNodes: 40, hintAboveTokens: 12000, admitRelevance: 0.3, summaryMatch: true },
    effective: {
      autoInject: false,
      retrievalHint: true,
      autoReflect: true,
      hintMinNodes: 40,
      hintAboveTokens: 12000,
      admitRelevance: 0.3,
      summaryMatch: true,
      tokenizerVersion: 'auto',
      ...(aggressive
        ? { foldAboveTokens: 20000, foldKeepTurns: 2, foldScope: 'turns' }
        : balanced
          ? { foldAboveTokens: 40000, foldKeepTurns: 3, foldScope: 'turns' }
          : {}),
    },
    tokenizer: {
      path: null,
      state: 'ready',
      name: 'deepseek_v4_tokenizer',
      version: 4,
      available: ['deepseek_v3_tokenizer (v3)', 'deepseek_v4_tokenizer (v4)'],
      requested: 'auto',
      choices: [
        { id: 'auto', label: '自动（最新一代）' },
        { id: '3', label: 'DeepSeek v3' },
        { id: '4', label: 'DeepSeek v4' },
        { id: 'off', label: '自主学习（不用词表）' },
      ],
    },
    ratio: { wide: 0.6, narrow: 0.2, observations: 0 },
    billing: { wide: 0.6, narrow: 0.2, overhead: 0, observations: 0, active: false },
    budget: { factor: 0.85, conservative: 0.85 },
    drift: { samples: 0, ratio: null },
    lastHint: null,
    availableTools: Array.isArray(settingsPayload.hiddenTools) && settingsPayload.hiddenTools.includes('workflow')
      ? [{ name: 'pwsh', chars: 3495 }, { name: 'schedule_create', chars: 3143 }]
      : [{ name: 'pwsh', chars: 3495 }, { name: 'workflow', chars: 3389 }, { name: 'schedule_create', chars: 3143 }],
    toolRestriction: null,
  }
}

let cachedFactory
let registeredId

/**
 * Import the client bundle once; ESM caches it and it registers as a side effect.
 * @param {object} window - jsdom window that receives the registration.
 * @returns {Promise<Function|undefined>} The factory.
 */
async function loadFactory(window) {
  if (cachedFactory !== undefined) return cachedFactory
  const loaded = {}
  window.__ModuleLoader__ = { load: definition => { loaded.factory = definition.factory; registeredId = definition.id } }
  await import(pathToFileURL(join(process.cwd(), 'client', 'client.js')).href)
  cachedFactory = loaded.factory
  return cachedFactory
}

/**
 * Boot the browser half and mount one of its two registered components.
 * @param {'dock'|'header'} which - composer dock, or the header button that opens the editor.
 * @returns {Promise<object>} DOM handles plus `click` and `cleanup`.
 */
async function mountClient(which, locale = 'zh') {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  const { window } = dom
  globalThis.window = window
  globalThis.document = window.document
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
  globalThis.HTMLElement = window.HTMLElement
  globalThis.Node = window.Node
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // Pin the locale: the component reads it once, at load.
  window.__BONSAI_LOCALE__ = locale
  // The dock remembers its open state per session; open it so the body renders.
  window.sessionStorage.setItem('twt-dock-open:session-1', '1')

  const requests = []
  let activePreset = null
  const stubFetch = (url, options = {}) => {
    const target = String(url)
    requests.push({ url: target, method: options.method ?? 'GET', body: options.body })
    if (target.includes('/preset') && options.body) {
      try { activePreset = JSON.parse(String(options.body)).preset ?? null } catch {}
    }
    const payload = target.includes('/preset')
      ? { ok: true, preset: activePreset }
      : target.includes('/settings')
      ? settingsPayload(activePreset)
      : target.includes('/focus') || target.includes('/edit')
        ? { ok: true, anchored: { nodeId: 'n4', kind: 'question' }, tree: treePayload() }
        : treePayload()
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) })
  }
  window.fetch = stubFetch
  globalThis.fetch = stubFetch

  const factory = await loadFactory(window)
  assert.ok(registeredId === 'dsh-bonsai', 'client bundle registers under the published package name')
  assert.ok(factory !== undefined, 'client registered a factory')
  const platformRequire = name => (name === 'react' ? React : require('react-dom'))
  const exported = factory(platformRequire)

  const components = {}
  exported.apply({
    slots: {
      inject: (_name, body) => body(),
      register: (spec, component) => {
        components[spec.name] = component
        return () => {}
      },
    },
    on: () => () => {},
    effect: body => body(),
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    get: () => undefined,
  })

  const Component = which === 'dock'
    ? components['conversation.composer.dock']
    : which === 'bar'
      ? components['conversation.composer.bar']
      : components['conversation.session.header.actions']
  assert.ok(Component !== undefined, `${which} component registered`)

  const container = window.document.getElementById('root')
  const root = ReactDOMClient.createRoot(container)
  const flush = async () => {
    for (let index = 0; index < 8; index++) await React.act(async () => { await Promise.resolve() })
  }
  const props = which === 'dock'
    ? { sessionId: 'session-1', input: { text: '' }, variant: 'composer' }
    : which === 'bar'
      ? {}
      : { sessionId: 'session-1' }
  await React.act(async () => { root.render(React.createElement(Component, props)) })
  await flush()

  const click = async label => {
    const buttons = [...window.document.querySelectorAll('button')]
    const target = buttons.find(button => (button.textContent ?? '').includes(label))
    assert.ok(target !== undefined, `button "${label}" exists`)
    await React.act(async () => { target.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await flush()
  }

  const clickRow = async label => {
    const rows = [...window.document.querySelectorAll('.twt-erow, [data-id]')]
    const target = rows.find(row => (row.textContent ?? '').includes(label))
    assert.ok(target !== undefined, `row "${label}" exists`)
    await React.act(async () => { target.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await flush()
  }

  const cleanup = async () => {
    try {
      await React.act(async () => { root.unmount() })
    } finally {
      window.close()
    }
  }

  return { window, document: window.document, container, requests, click, clickRow, flush, cleanup }
}

test('the dock renders the conversation tree it fetched', { timeout: 30000 }, async t => {
  const client = await mountClient('dock')
  t.after(client.cleanup)
  assert.ok(client.requests.some(entry => entry.url.includes('/api/token-tree/tree')), 'fetched the tree')
  assert.ok(client.container.innerHTML.includes('盆栽'), 'the dock carries the product name')
  assert.ok(client.container.innerHTML.includes('6 节点'), 'header shows the node count')
  await client.click('列表')
  const html = client.container.innerHTML
  assert.ok(html.includes('布隆过滤器的误判率'), 'question text is rendered in the list view')
  assert.ok(html.includes('由位数组大小'), 'answer text is rendered')
})

test('the UI follows the host language, English included', { timeout: 30000 }, async t => {
  const client = await mountClient('dock', 'en')
  t.after(client.cleanup)
  assert.ok(client.container.innerHTML.includes('Bonsai'), 'product name in English')
  assert.ok(client.container.innerHTML.includes('Graph'), 'tab label translated')
  assert.ok(!client.container.innerHTML.includes('\u56fe\u5f62'), 'no Chinese tab label left in English mode')
})

test('the injected styles follow the host theme instead of forcing dark', { timeout: 30000 }, async t => {
  const client = await mountClient('dock')
  t.after(client.cleanup)
  const css = [...client.document.querySelectorAll('style')].map(node => node.textContent ?? '').join('\n')
  assert.ok(css.includes('--twt-surface'), 'theme tokens are defined')
  assert.ok(css.includes('var(--dsw-alias-bg-base'), 'surfaces resolve through the host design tokens')
  assert.ok(css.includes('prefers-color-scheme:light'), 'light scheme has its own fallbacks')
  assert.ok(css.includes('color-scheme:light dark'), 'native controls inherit the scheme')
  assert.ok(!css.includes('--dsw-surface'), 'no invented token names remain')
  // The dock must paint the same surface as the expanded editor, not a dark wash.
  assert.ok(!/background:rgba\(0,0,0,\.1[0-9]?\)/.test(css), 'no dark-wash fills remain on panels')
  assert.ok(css.includes('background:var(--twt-surface)'), 'panels paint the shared surface token')
})

test('clicking a row selects it without jumping, double-click jumps', { timeout: 30000 }, async t => {
  const client = await mountClient('dock')
  t.after(client.cleanup)
  await client.click('列表')
  const rows = [...client.document.querySelectorAll('.twt-dockrow')]
  assert.ok(rows.length > 0, 'dock rows rendered')
  // A single click marks the row selected; nothing scrolls, so the dock survives.
  await React.act(async () => { rows[0].dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()
  assert.equal(rows[0].getAttribute('data-picked'), 'true', 'row selected')
  assert.ok(client.container.innerHTML.includes('twt-dock'), 'dock still mounted after a click')
})

test('the recycle bin lists hidden branches and restores them', { timeout: 30000 }, async t => {
  const client = await mountClient('header')
  t.after(client.cleanup)
  await client.click('盆栽')
  await client.click('回收站')
  const rows = [...client.document.querySelectorAll('.twt-erow')]
  assert.equal(rows.length, 1, 'one hidden branch listed')
  assert.ok((rows[0].textContent ?? '').includes('直接换哈希表'), 'the row shows the original text')
  const restore = [...rows[0].querySelectorAll('button')].find(button => (button.textContent ?? '').includes('恢复'))
  assert.ok(restore !== undefined, 'restore button present')
  await React.act(async () => { restore.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()
  const call = client.requests.find(entry => entry.url.includes('/api/token-tree/edit') && entry.method === 'POST')
  assert.ok(call !== undefined, 'restore posts to the edit route')
  assert.ok(String(call.body).includes('"restore"'), 'using the restore action')
  assert.ok(String(call.body).includes('n5'), 'for the hidden node')
})

test('the recycle bin shows how much is hidden and can restore it all', { timeout: 30000 }, async t => {
  const client = await mountClient('header')
  t.after(client.cleanup)
  await client.click('盆栽')
  await client.click('回收站')
  const head = client.document.querySelector('.twt-basket-head')
  assert.ok(head !== null, 'the bin has a header')
  assert.ok((head.textContent ?? '').includes('1 个已隐藏分支'), 'the header counts the hidden branches')
  const restoreAll = [...head.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('全部恢复'))
  assert.ok(restoreAll !== undefined, 'restore-all is offered')
  await React.act(async () => { restoreAll.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()
  const call = client.requests.find(entry => entry.url.includes('/api/token-tree/edit') && entry.method === 'POST')
  assert.ok(call !== undefined, 'restore-all posts to the edit route')
  assert.ok(String(call.body).includes('"restore"'), 'using the restore action')
  assert.ok(String(call.body).includes('n5'), 'for the hidden node')
})

test('the settings tab offers the tokenizer dropdown from the payload', { timeout: 30000 }, async t => {
  const client = await mountClient('header')
  t.after(client.cleanup)
  await client.click('盆栽')
  await client.click('设置')
  const select = client.document.querySelector('select')
  assert.ok(select !== null, 'tokenizer select rendered')
  const options = [...select.querySelectorAll('option')].map(option => `${option.value}:${option.textContent}`)
  assert.deepEqual(options, ['auto:自动（最新一代）', '3:DeepSeek v3', '4:DeepSeek v4', 'off:自主学习（不用词表）'])
  assert.equal(select.value, '4', 'shows the generation actually in use')
})

test('the preset picker sits beside the mode chip', { timeout: 30000 }, async t => {
  const client = await mountClient('header')
  t.after(client.cleanup)
  // The hero row renders just the current mode, not a pair of options.
  const row = client.window.document.createElement('div')
  row.className = 'composer-row'
  const chip = client.window.document.createElement('button')
  chip.type = 'button'
  chip.textContent = '标准模式'
  row.appendChild(chip)
  client.window.document.body.appendChild(row)

  await new Promise(resolve => setTimeout(resolve, 700))
  await client.flush()

  const picker = row.querySelector('.twt-mode-preset select')
  assert.ok(picker !== null, 'the picker attached beside the chip')
  assert.equal(chip.nextElementSibling, picker.parentElement, 'it sits immediately to the right of the chip')
  const values = [...picker.options].map(option => option.value)
  assert.deepEqual(values, ['conservative', 'balanced', 'aggressive', 'custom'], 'three presets plus custom')

  picker.value = 'aggressive'
  await React.act(async () => { picker.dispatchEvent(new client.window.Event('change', { bubbles: true })) })
  await client.flush()
  const posted = client.requests.find(entry => entry.url.includes('/api/token-tree/preset') && entry.method === 'POST')
  assert.ok(posted !== undefined, 'the picker posts to the preset route')
  assert.ok(String(posted.body).includes('aggressive'), 'with the chosen preset')
  await client.flush()
  assert.equal(picker.value, 'aggressive', 'and the select settles on 节省 instead of 自定义')
})

test('the tool-result toggle sits on the right and only where it applies', { timeout: 30000 }, async t => {
  const client = await mountClient('header')
  t.after(client.cleanup)
  await client.click('盆栽')

  const byLabel = () => [...client.document.querySelectorAll('label')].find(label => (label.textContent ?? '').includes('隐藏工具结果'))
  // Tree mode: present, inside the right-hand column.
  await client.click('完整树')
  const toggle = byLabel()
  assert.ok(toggle !== undefined, 'tree mode offers the toggle')
  assert.ok(toggle.closest('.twt-edetail') !== null, 'it lives in the detail column, not the tab bar')

  // Settings mode: gone, because it controls nothing there.
  await client.click('设置')
  assert.equal(byLabel(), undefined, 'the settings panel does not show it')
})

test('rules show as chips and can be added from the bar', { timeout: 30000 }, async t => {
  const client = await mountClient('header')
  t.after(client.cleanup)
  await client.click('盆栽')
  await client.click('完整树')

  const bar = client.document.querySelector('.twt-constraints')
  assert.ok(bar !== null, 'the rule bar is rendered')
  const chips = [...bar.querySelectorAll('.twt-rule-chip')]
  assert.equal(chips.length, 1, 'one rule from the payload')
  assert.ok((chips[0].textContent ?? '').includes('发布前必须先问我'), 'the chip shows the rule text')

  const add = [...bar.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('规则'))
  assert.ok(add !== undefined, 'the bar offers adding one')
  await React.act(async () => { add.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()

  const input = client.document.querySelector('.twt-rule-input')
  assert.ok(input !== null, 'the dialog opens with an input')
  // React tracks the value, so set it through the native setter before dispatching input.
  const setter = Object.getOwnPropertyDescriptor(client.window.HTMLTextAreaElement.prototype, 'value').set
  await React.act(async () => {
    setter.call(input, '不要擅自发布')
    input.dispatchEvent(new client.window.Event('input', { bubbles: true }))
  })
  await client.flush()
  const save = [...client.document.querySelectorAll('.twt-modal-foot button')].find(button => (button.textContent ?? '').includes('保存'))
  assert.ok(save !== undefined, 'the dialog offers saving')
  await React.act(async () => { save.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()

  const posted = client.requests.find(entry => entry.url.includes('/api/token-tree/edit') && entry.method === 'POST')
  assert.ok(posted !== undefined, 'the rule is posted to the edit route')
  assert.ok(String(posted.body).includes('"action":"rule"'), 'using the rule action')
  assert.ok(String(posted.body).includes('不要擅自发布'), 'with the text')
})

test('an existing rule opens with its text and can be edited or deleted', { timeout: 30000 }, async t => {
  const client = await mountClient('header')
  t.after(client.cleanup)
  await client.click('盆栽')
  await client.click('完整树')

  const chip = client.document.querySelector('.twt-rule-chip')
  assert.ok(chip !== null, 'the rule chip is there')
  await React.act(async () => { chip.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()

  const input = client.document.querySelector('.twt-rule-input')
  assert.ok(input !== null, 'the dialog opened')
  assert.equal(input.value, '发布前必须先问我', 'with the existing text prefilled')

  // Edit it.
  const setter = Object.getOwnPropertyDescriptor(client.window.HTMLTextAreaElement.prototype, 'value').set
  await React.act(async () => {
    setter.call(input, '发布或推送前必须先问我')
    input.dispatchEvent(new client.window.Event('input', { bubbles: true }))
  })
  await client.flush()
  const save = [...client.document.querySelectorAll('.twt-modal-foot button')].find(button => (button.textContent ?? '').includes('保存'))
  await React.act(async () => { save.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()
  const update = client.requests.find(entry => entry.url.includes('/api/token-tree/edit') && String(entry.body).includes('"op":"update"'))
  assert.ok(update !== undefined, 'an update is posted')
  assert.ok(String(update.body).includes('rule-1'), 'for the existing rule')
  assert.ok(String(update.body).includes('发布或推送前必须先问我'), 'with the new text')

  // Delete it.
  client.requests.length = 0
  const chipAgain = client.document.querySelector('.twt-rule-chip')
  await React.act(async () => { chipAgain.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()
  const remove = [...client.document.querySelectorAll('.twt-modal-foot button')].find(button => (button.textContent ?? '').includes('删除'))
  assert.ok(remove !== undefined, 'the dialog offers delete')
  await React.act(async () => { remove.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()
  const removal = client.requests.find(entry => entry.url.includes('/api/token-tree/edit') && String(entry.body).includes('"op":"remove"'))
  assert.ok(removal !== undefined, 'a remove is posted')
  assert.ok(String(removal.body).includes('rule-1'), 'for the existing rule')
})

test('the settings panel offers the three presets', { timeout: 30000 }, async t => {
  const client = await mountClient('header')
  t.after(client.cleanup)
  await client.click('盆栽')
  await client.click('设置')
  const bar = client.document.querySelector('.twt-presets')
  assert.ok(bar !== null, 'the preset bar is present')
  const labels = [...bar.querySelectorAll('button')].map(button => button.textContent ?? '')
  assert.deepEqual(labels, ['保留', '平衡', '节省'], 'three presets, in order')
  const aggressive = [...bar.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('节省'))
  await React.act(async () => { aggressive.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()
  const posted = client.requests.find(entry => entry.url.includes('/api/token-tree/preset') && entry.method === 'POST')
  assert.ok(posted !== undefined, 'the preset route was called')
  assert.ok(String(posted.body).includes('aggressive'), 'with the chosen preset')
})

test('tools are hidden through a checklist, not a name field', { timeout: 30000 }, async t => {
  const client = await mountClient('header')
  t.after(client.cleanup)
  await client.click('盆栽')
  await client.click('设置')
  const open = [...client.document.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('选择工具'))
  assert.ok(open !== undefined, 'the settings row offers the picker')
  await React.act(async () => { open.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()
  const rows = [...client.document.querySelectorAll('.twt-tool-row')]
  assert.equal(rows.length, 3, 'every tool the host reported is listed')
  assert.ok((rows[0].textContent ?? '').includes('pwsh'), 'heaviest tool first')
  const workflow = rows.find(row => (row.textContent ?? '').includes('workflow'))
  assert.ok(workflow !== undefined, 'workflow is listed')
  const box = workflow.querySelector('input[type="checkbox"]')
  await React.act(async () => { box.click() })
  await client.flush()
  const checked = [...client.document.querySelectorAll('.twt-tool-row input:checked')]
  assert.equal(checked.length, 1, 'the row reacts to the click')
  const apply = [...client.document.querySelectorAll('.twt-modal-foot button')].find(button => (button.textContent ?? '').includes('应用'))
  assert.ok(apply !== undefined, 'apply is offered')
  await React.act(async () => { apply.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()
  const saved = client.requests.find(entry => entry.url.includes('/api/token-tree/settings') && entry.method === 'POST')
  assert.ok(saved !== undefined, 'settings POST issued')
  assert.ok(String(saved.body).includes('toolDeny'), 'the chosen names are persisted')
  assert.ok(String(saved.body).includes('workflow'), 'and it is the checked tool')
})

test('a hidden tool the host no longer reports still shows as checked', { timeout: 30000 }, async t => {
  // The catalogue no longer carries workflow: it is restricted, so the next assembly omits it.
  settingsPayload.hiddenTools = ['workflow']
  const client = await mountClient('header')
  t.after(() => { settingsPayload.hiddenTools = undefined; client.cleanup() })
  await client.click('盆栽')
  await client.click('设置')

  const open = [...client.document.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('选择工具'))
  await React.act(async () => { open.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()

  const rows = [...client.document.querySelectorAll('.twt-tool-row')]
  const workflow = rows.find(row => (row.textContent ?? '').includes('workflow'))
  assert.ok(workflow !== undefined, 'the hidden tool is still listed')
  assert.equal(workflow.querySelector('input').checked, true, 'and it is checked')
  assert.ok((workflow.textContent ?? '').includes('已隐藏'), 'marked as hidden rather than 0 chars')
})

test('the settings panel can switch the interface language', { timeout: 30000 }, async t => {
  const client = await mountClient('header', 'en')
  t.after(client.cleanup)
  await client.click('Bonsai')
  await client.click('Settings')
  const selects = [...client.document.querySelectorAll('select')]
  const language = selects.find(select => [...select.options].some(option => option.value === 'zh'))
  assert.ok(language !== undefined, 'language select rendered')
  const values = [...language.options].map(option => option.value)
  // The tokenizer dropdown's labels arrive in Chinese from the backend.
  const tokenizer = selects.find(select => [...select.options].some(option => option.value === '4'))
  assert.ok(tokenizer !== undefined, 'tokenizer select rendered')
  const tokenLabels = [...tokenizer.options].map(option => option.textContent ?? '')
  assert.ok(tokenLabels.some(label => label.includes('Auto')), 'tokenizer labels translated')
  assert.ok(tokenLabels.some(label => label.includes('Learned')), 'learned option translated')
  assert.deepEqual(values, ['auto', 'zh', 'en'], 'auto / Chinese / English')
  // Saving sends the choice to the settings route.
  await React.act(async () => {
    language.value = 'zh'
    language.dispatchEvent(new client.window.Event('change', { bubbles: true }))
  })
  await client.flush()
  const saved = client.requests.find(entry => entry.url.includes('/api/token-tree/settings') && entry.method === 'POST')
  assert.ok(saved !== undefined, 'settings POST issued')
  assert.ok(String(saved.body).includes('locale'), 'locale persisted')
})

test('selecting a forked node lists its branches beside it', { timeout: 30000 }, async t => {
  const client = await mountClient('header')
  t.after(client.cleanup)
  await client.click('盆栽')
  await client.click('完整树')
  // Pick the parent of the two branches.
  await client.clickRow('布隆过滤器的误判率')
  const rows = [...client.document.querySelectorAll('.twt-branch-row')]
  assert.equal(rows.length, 2, 'two branches, not the answer or the tool result')
  const labels = rows.map(row => row.textContent ?? '')
  assert.ok(labels[0].includes('计数布隆'), 'first branch question')
  assert.ok(labels[1].includes('直接换哈希表'), 'second branch question')
})

test('anchoring from a branch row calls the focus route', { timeout: 30000 }, async t => {
  const client = await mountClient('header')
  t.after(client.cleanup)
  await client.click('盆栽')
  await client.click('完整树')
  await client.clickRow('布隆过滤器的误判率')
  const rows = [...client.document.querySelectorAll('.twt-branch-row')]
  assert.ok(rows.length > 0, 'branch rows rendered')
  const button = [...rows[0].querySelectorAll('button')].find(entry => (entry.textContent ?? '').includes('从这里继续'))
  assert.ok(button !== undefined, 'continue button exists in the row')
  await React.act(async () => { button.dispatchEvent(new client.window.MouseEvent('click', { bubbles: true })) })
  await client.flush()
  const focusCall = client.requests.find(entry => entry.url.includes('/api/token-tree/focus') && entry.method === 'POST')
  assert.ok(focusCall !== undefined, 'focus route called')
  assert.ok(String(focusCall.body).includes('n4'), 'anchored to the branch node')
})
