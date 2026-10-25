#!/usr/bin/env node
/**
 * 客户端 UI 的离线断言：不打开浏览器也能证明这块面板能注册、能渲染、按钮真的发请求。
 *
 * 做法：给 client/client.js 喂一个迷你 React（只实现本插件用到的 hooks）
 * + 假 document / 假 fetch，然后把渲染树里的输入框填上、按钮「点」一下，
 * 看它到底发了什么 op、带了什么参数。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT = path.join(ROOT, 'client/client.js')

const problems = []
const fail = (msg) => problems.push(msg)
const checks = []
const ok = (msg) => checks.push(msg)

/* ------------------------------- 迷你 React ------------------------------- */

function createMiniReact() {
  const runtime = {
    states: [],
    memos: [],
    effectCache: [],
    hooks: 0,
    pendingEffects: [],
    dirty: false,
  }

  const sameDeps = (a, b) => {
    if (a === undefined || b === undefined) return false
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    return a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
  }

  const react = {
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const slot = runtime.hooks++
      if (!(slot in runtime.states)) {
        runtime.states[slot] = typeof initial === 'function' ? initial() : initial
      }
      const set = (next) => {
        const value = typeof next === 'function' ? next(runtime.states[slot]) : next
        if (Object.is(value, runtime.states[slot])) return
        runtime.states[slot] = value
        runtime.dirty = true
      }
      return [runtime.states[slot], set]
    },
    useEffect(fn, deps) {
      const slot = runtime.hooks++
      runtime.pendingEffects.push({ slot, fn, deps })
    },
    useCallback(fn, deps) {
      const slot = runtime.hooks++
      const cached = runtime.memos[slot]
      if (cached !== undefined && sameDeps(cached.deps, deps)) return cached.fn
      runtime.memos[slot] = { fn, deps }
      return fn
    },
    useMemo(fn) {
      runtime.hooks++
      return fn()
    },
    useRef(initial) {
      const slot = runtime.hooks++
      if (!(slot in runtime.memos)) runtime.memos[slot] = { current: initial }
      return runtime.memos[slot]
    },
  }

  function render(Component, props) {
    runtime.hooks = 0
    runtime.pendingEffects = []
    const tree = Component(props)
    for (const effect of runtime.pendingEffects) {
      const cached = runtime.effectCache[effect.slot]
      if (cached !== undefined && sameDeps(cached.deps, effect.deps)) continue
      runtime.effectCache[effect.slot] = { deps: effect.deps }
      effect.fn()
    }
    return tree
  }

  return { react, runtime, render }
}

/* ------------------------------ 假 document ------------------------------ */

const styleTags = []
const fakeDocument = {
  head: { appendChild: (node) => styleTags.push(node) },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
}

/* -------------------------------- 假 fetch -------------------------------- */

const fetchCalls = []
const STATUS_PAYLOAD = {
  root: 'C:/work/.agent/memory',
  config: {
    requireConfirmation: false,
    defaultBudget: 1200,
    maxTopK: 200,
    redactSecrets: true,
    injectEnabled: true,
    injectBudgetChars: 1500,
  },
  counts: { total: 4, active: 1, suggested: 1, superseded: 0, conflict: 1, deleted_pending: 1, orphaned: 0 },
  entries: [
    { id: 'mem_1', path: 'topics/one.md', type: 'topic', title: '第一条记忆', summary: 's1', status: 'suggested', time: '2026-01-01T00:00:00.000Z' },
    { id: 'mem_2', path: 'topics/two.md', type: 'topic', title: '第二条记忆', summary: 's2', status: 'active', time: '2026-01-02T00:00:00.000Z' },
    { id: 'mem_3', path: 'topics/three.md', type: 'topic', title: '第三条记忆', summary: 's3', status: 'conflict', time: '2026-01-03T00:00:00.000Z' },
    { id: 'mem_4', path: 'topics/four.md', type: 'topic', title: '第四条记忆', summary: 's4', status: 'deleted_pending', time: '2026-01-04T00:00:00.000Z' },
  ],
  sessions: [{ session_id: 'sess-a', entries: 2, active: 1, deleted: 1 }],
  facets: {
    total: 4,
    retrievable: 1,
    types: { topic: 4 },
    tags: [{ name: 'workflow', count: 2 }, { name: 'backend', count: 1 }],
    newest: '2026-01-04T00:00:00.000Z',
  },
  list_limit: 300,
}

function fakeFetch(url, init) {
  const body = JSON.parse(init.body)
  fetchCalls.push({ url, body, headers: init.headers ?? {} })
  let data
  if (body.op === 'status') data = STATUS_PAYLOAD
  else if (body.op === 'search') {
    data = body.query === '不存在的东西'
      ? { hits: [], guidance: '没有直接命中（BM25 只认字面相同的词）。库里有 4 条；常用标签：workflow / backend。' }
      : {
        hits: [{ id: 'mem_2', path: 'topics/two.md', type: 'topic', title: '第二条记忆', summary: 's2', score: 3.5, reason: 'alias' }],
        guidance: '',
      }
  } else if (body.op === 'detail') {
    data = {
      entry: {
        id: body.id,
        path: 'topics/one.md',
        type: 'topic',
        title: '第一条记忆',
        summary: '这是详情里的摘要',
        status: 'active',
        time: '2026-01-01T00:00:00.000Z',
        tags: ['demo'],
        entities: [],
        sources: [{ session_id: 'sess-a', kind: 'session' }],
        confidence: 0.6,
        raw_ref: null,
        variants: [{ value: '另一种说法', time: '2026-01-01T00:00:00.000Z', source: { session_id: 'sess-b', kind: 'session' } }],
      },
      raw: '原文预览内容',
    }
  } else if (body.op === 'config.set') data = { config: body.config }
  else if (body.op === 'create') data = { path: 'topics/created.md', id: 'mem_new', status: 'active' }
  else if (body.op === 'resolve') data = { id: body.id, status: 'active', superseded: ['mem_1'] }
  else if (body.op === 'restore') data = { id: body.id, status: 'active' }
  else if (body.op === 'forgetSession') {
    data = { deleted_episode_count: 1, deleted_raw_count: 1, unlinked_topic_count: 0, orphaned_topic_count: 0, affected_paths: [], status_changes: [] }
  } else if (body.op === 'injectPreview') {
    data = {
      enabled: true,
      budget: 1500,
      chars: 61,
      included: 1,
      omitted: 0,
      total: 1,
      text: '## 记忆（自动注入）\n- 测试标题｜这是预览里的摘要',
    }
  } else if (body.op === 'digestList') {
    data = {
      slots: [
        { slot: 'demo.slot', path: 'digests/demo.slot.md', updated_at: '2026-10-25T00:00:00.000Z', stale: false, entries: 2, conflict: false, history: 1, text: '这是当前认知正文' },
        { slot: 'title:旧标题', path: 'digests/x.md', updated_at: '', stale: true, entries: 1, conflict: false, history: 0 },
      ],
    }
  } else if (body.op === 'digestRebuild') {
    data = { rebuilt: body.key === undefined ? 2 : 1 }
  } else if (body.op === 'queryLog') {
    data = {
      entries: [
        { at: '2026-10-25T00:00:00.000Z', query: '订单缓存', hits: 3 },
        { at: '2026-10-25T00:01:00.000Z', query: '不存在的词', hits: 0 },
      ],
      limit: 200,
    }
  } else if (body.op === 'rebuild') data = { entry_count: 4, scanned: 4, skipped: 0 }
  else if (body.op === 'purgeDeleted') data = { removed_count: 1, removed_paths: ['raw/x.md'] }
  else if (body.op === 'export') {
    data = {
      bundle: {
        format: 'dsh-memory-agent/export',
        version: 1,
        exported_at: '2026-10-25T00:00:00.000Z',
        root: STATUS_PAYLOAD.root,
        entries: STATUS_PAYLOAD.entries,
        files: [],
        truncated: false,
      },
    }
  }
  else data = { id: body.id ?? '', status: 'active' }
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, data }) })
}

/* --------------------------------- 装载 --------------------------------- */

const source = readFileSync(CLIENT, 'utf8')
const mini = createMiniReact()
let loaded
const fakeWindow = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded = { id, exports: factory(requireStub) }
    },
  },
}

function requireStub(name) {
  if (name === 'react') return mini.react
  throw new Error(`客户端产物 require 了未预期的模块：${name}`)
}

const runner = new Function('window', 'document', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', source)
runner(fakeWindow, fakeDocument, fakeFetch, undefined, setTimeout, clearTimeout)

if (loaded === undefined) {
  fail('client.js 没有调用 window.__ModuleLoader__.load')
} else {
  if (loaded.id !== 'dsh-memory-agent') fail(`ModuleLoader id 必须是包名，实际 ${loaded.id}`)
  else ok('ModuleLoader id = dsh-memory-agent')
  if (typeof loaded.exports.apply !== 'function') fail('client.js 没有导出 apply')
  if (!Array.isArray(loaded.exports.inject) || !loaded.exports.inject.includes('slots')) {
    fail(`inject 必须包含 slots，实际 ${JSON.stringify(loaded.exports.inject)}`)
  } else ok('inject = ["slots"]')
}

/* ------------------------------- 注册 + 渲染 ------------------------------- */

const registrations = []
const disposers = []
const fakeSlots = {
  inject: (_slot, run) => {
    const disposer = run()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  register: (options, Component) => {
    registrations.push({ options, Component })
    return () => {
      const at = registrations.findIndex((item) => item.options.id === options.id)
      if (at >= 0) registrations.splice(at, 1)
    }
  },
}

const ctx = {
  slots: fakeSlots,
  effect: (run) => {
    const disposer = run()
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
}

loaded.exports.apply(ctx)

const section = registrations.find((item) => item.options.name === 'settings.section')
if (section === undefined) {
  fail('没有注册 settings.section')
} else {
  const options = section.options
  if (options.id !== 'memory-agent') fail(`section id 应为 memory-agent，实际 ${options.id}`)
  if (typeof options.label !== 'function' || options.label() !== '记忆') fail('section label 应为「记忆」')
  if (options.order !== 60) fail(`section order 应为 60，实际 ${options.order}`)
  ok('注册 settings.section（id=memory-agent, label=记忆, order=60）')
}

/* ------------------------------- 渲染工具 ------------------------------- */

const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return [textOf(node.props.children), ...(node.children ?? []).map(textOf)].join('')
}

const flatten = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out)
    return out
  }
  out.push(node)
  flatten(node.props.children, out)
  flatten(node.children, out)
  return out
}

/** 按「按钮文字完全等于」来找，避免「软删」误命中「清理已软删」。 */
const findButton = (tree, label) => flatten(tree)
  .filter((node) => node.type === 'button')
  .find((node) => textOf(node).trim() === label)

const findByPlaceholder = (tree, hint) => flatten(tree)
  .find((node) => typeof node.props.placeholder === 'string' && node.props.placeholder.includes(hint))

const lastCall = (op) => fetchCalls.filter((call) => call.body.op === op).pop()

async function settle(Component) {
  let current = mini.render(Component, {})
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!mini.runtime.dirty) break
    mini.runtime.dirty = false
    current = mini.render(Component, {})
  }
  return current
}

let tree = await settle(section.Component)
const pageText = textOf(tree)
for (const expected of ['记忆库', 'C:/work/.agent/memory', '待确认', '行为设置', '常驻注入', '当前认知', '检索日志', '搜索', '写一条记忆', '重建索引', '第一条记忆', '按会话忘却']) {
  if (!pageText.includes(expected)) fail(`面板文本缺少「${expected}」`)
}
if (!fetchCalls.some((call) => call.body.op === 'status')) fail('挂载后没有请求 op=status')
ok('挂载即拉状态并渲染概览/搜索/新建/列表/会话')

const firstCall = fetchCalls[0]
if (firstCall?.url !== '/memory-agent/api') fail(`请求路径不对：${firstCall?.url}`)
else if (firstCall.headers['x-dsh-memory-agent'] !== 'panel') fail('请求没有带面板头（宿主会 403）')
else if (firstCall.headers['content-type'] !== 'application/json') fail('请求没有带 JSON content-type（宿主会 403）')
else ok('请求带 content-type + x-dsh-memory-agent 面板头')

/* 改预算 → 保存设置 */
const numberInputs = flatten(tree).filter((node) => node.type === 'input' && node.props.type === 'number')
if (numberInputs.length !== 3) fail(`应有 3 个数字输入框（阅读预算/top_k/注入预算），实际 ${numberInputs.length}`)
else {
  numberInputs[0].props.onChange({ target: { value: '800' } })
  tree = await settle(section.Component)
  const saveButton = findButton(tree, '保存设置')
  if (saveButton === undefined) fail('找不到「保存设置」按钮')
  else {
    saveButton.props.onClick()
    tree = await settle(section.Component)
    const saved = lastCall('config.set')
    if (saved === undefined) fail('点保存没有发 config.set')
    else if (saved.body.config.defaultBudget !== 800) fail(`config.set 的 defaultBudget 应为 800，实际 ${saved.body.config.defaultBudget}`)
    else if (saved.body.config.injectBudgetChars !== 1500) fail(`config.set 应带上 injectBudgetChars=1500，实际 ${saved.body.config.injectBudgetChars}`)
    else ok('改预算并保存 → config.set{defaultBudget:800, injectBudgetChars:1500}')
  }
}

/* 常驻注入预览 */
const previewButton = findButton(tree, '预览注入')
if (previewButton === undefined) fail('找不到「预览注入」按钮')
else {
  previewButton.props.onClick()
  tree = await settle(section.Component)
  const call = lastCall('injectPreview')
  if (call === undefined) fail('点预览注入没有发 injectPreview')
  else if (!textOf(tree).includes('已启用 · 61/1500 字符')) fail('注入预览统计没有渲染')
  else if (!textOf(tree).includes('这是预览里的摘要')) fail('注入预览文本没有渲染')
  else ok('点「预览注入」→ injectPreview 并渲染统计与文本')
}

/* 当前认知 */
const digestButton = findButton(tree, '刷新槽位')
if (digestButton === undefined) fail('找不到「刷新槽位」按钮')
else {
  digestButton.props.onClick()
  tree = await settle(section.Component)
  const call = lastCall('digestList')
  if (call === undefined) fail('点刷新槽位没有发 digestList')
  else if (!textOf(tree).includes('demo.slot')) fail('当前认知槽位清单没有渲染')
  else if (!textOf(tree).includes('这是当前认知正文')) fail('当前认知正文没有渲染')
  else if (!textOf(tree).includes('还没有当前认知')) fail('未生成认知的槽位没有给提示')
  else ok('点「刷新槽位」→ digestList 并渲染槽位与正文')
}

const digestOneButton = findButton(tree, '重建')
if (digestOneButton === undefined) fail('槽位行没有「重建」小按钮')
else {
  digestOneButton.props.onClick()
  await settle(section.Component)
  const call = lastCall('digestRebuild')
  if (call === undefined || call.body.key !== 'demo.slot') {
    fail(`单槽位重建请求不对：${JSON.stringify(call && call.body)}`)
  } else ok('点行内「重建」→ digestRebuild{key:demo.slot}')
}

const digestAllButton = findButton(tree, '重建全部')
if (digestAllButton === undefined) fail('找不到「重建全部」按钮')
else {
  digestAllButton.props.onClick()
  await settle(section.Component)
  const call = lastCall('digestRebuild')
  if (call === undefined) fail('点重建全部没有发 digestRebuild')
  else if (call.body.key !== undefined) fail(`重建全部不该带 key：${JSON.stringify(call.body)}`)
  else ok('点「重建全部」→ digestRebuild 无 key')
}

/* 检索日志（P2） */
const logButton = findButton(tree, '刷新日志')
if (logButton === undefined) fail('找不到「刷新日志」按钮')
else {
  logButton.props.onClick()
  tree = await settle(section.Component)
  const call = lastCall('queryLog')
  if (call === undefined) fail('点刷新日志没有发 queryLog')
  else if (!textOf(tree).includes('订单缓存')) fail('检索日志没有渲染出「订单缓存」')
  else if (!textOf(tree).includes('不存在的词')) fail('检索日志没有渲染出「不存在的词」')
  else ok('点「刷新日志」→ queryLog 并渲染最近记录')
}

/* 零命中的行用 ma-pill conflict 突出（检查节点 props.className） */
const zeroLogRow = flatten(tree).find((node) =>
  node.type === 'div'
  && node.props.className === 'ma-item'
  && textOf(node).includes('不存在的词'))
if (zeroLogRow === undefined) {
  fail('检索日志里找不到「不存在的词」那一行')
} else {
  const pill = flatten(zeroLogRow).find((node) =>
    node.type === 'span'
    && typeof node.props.className === 'string'
    && node.props.className.includes('ma-pill'))
  if (pill === undefined) fail('零命中行没有 hits pill')
  else if (pill.props.className !== 'ma-pill conflict') {
    fail(`零命中 pill 应为 ma-pill conflict，实际「${pill.props.className}」`)
  } else ok('hits=0 的行用 ma-pill conflict 样式突出')
}
const hitLogRow = flatten(tree).find((node) =>
  node.type === 'div'
  && node.props.className === 'ma-item'
  && textOf(node).includes('订单缓存'))
if (hitLogRow === undefined) {
  fail('检索日志里找不到「订单缓存」那一行')
} else {
  const pill = flatten(hitLogRow).find((node) =>
    node.type === 'span'
    && typeof node.props.className === 'string'
    && node.props.className.includes('ma-pill'))
  if (pill !== undefined && pill.props.className === 'ma-pill conflict') {
    fail('hits>0 的行不该用 conflict 样式')
  } else ok('hits>0 的行用普通 pill')
}

/* 搜索 */
const searchInput = findByPlaceholder(tree, '搜索记忆')
if (searchInput === undefined) fail('找不到搜索输入框')
else {
  searchInput.props.onChange({ target: { value: '订单缓存' } })
  tree = await settle(section.Component)
  const searchButton = findButton(tree, '搜索')
  if (searchButton === undefined) fail('找不到「搜索」按钮')
  else {
    searchButton.props.onClick()
    tree = await settle(section.Component)
    const call = lastCall('search')
    if (call === undefined || call.body.query !== '订单缓存') fail(`搜索请求不对：${JSON.stringify(call && call.body)}`)
    else ok('搜索框输入并点搜索 → search{query:"订单缓存"}')
    if (!textOf(tree).includes('第二条记忆')) fail('搜索结果没有渲染出来')
    else ok('搜索结果正常渲染')
  }
}

/* 零命中：给引导 + 标签快捷搜索 */
const searchInput2 = findByPlaceholder(tree, '搜索记忆')
searchInput2.props.onChange({ target: { value: '不存在的东西' } })
tree = await settle(section.Component)
findButton(tree, '搜索').props.onClick()
tree = await settle(section.Component)
if (!textOf(tree).includes('没有直接命中')) fail('零命中时没有显示引导文案')
else ok('零命中 → 显示 guidance 引导')
const tagChip = findButton(tree, 'workflow(2)')
if (tagChip === undefined) fail('零命中时没有给出标签快捷搜索')
else {
  tagChip.props.onClick()
  tree = await settle(section.Component)
  const call = lastCall('search')
  if (call === undefined || call.body.query !== 'workflow') fail(`点标签没有用标签名重搜：${JSON.stringify(call && call.body)}`)
  else ok('点标签 → 用标签名重搜')
}

/* 新建记忆 */
const summaryBox = findByPlaceholder(tree, '一句话说清')
if (summaryBox === undefined) fail('找不到新建记忆的文本框')
else {
  summaryBox.props.onChange({ target: { value: '面板新建：周五前不要动生产库' } })
  tree = await settle(section.Component)
  const createButton = findButton(tree, '写入记忆')
  if (createButton === undefined) fail('找不到「写入记忆」按钮')
  else {
    createButton.props.onClick()
    tree = await settle(section.Component)
    const call = lastCall('create')
    if (call === undefined || call.body.summary !== '面板新建：周五前不要动生产库') {
      fail(`新建请求不对：${JSON.stringify(call && call.body)}`)
    } else ok('新建表单 → create{summary:…}')
  }
}

/* 详情 */
const detailButton = findButton(tree, '详情')
if (detailButton === undefined) fail('找不到「详情」按钮')
else {
  detailButton.props.onClick()
  tree = await settle(section.Component)
  const call = lastCall('detail')
  if (call === undefined) fail('点详情没有发 detail')
  else if (!textOf(tree).includes('这是详情里的摘要')) fail('详情内容没有展开')
  else ok('点详情 → detail{id} 并展开摘要/冲突现场')
}

/* 冲突收尾 */
const keepButton = findButton(tree, '保留这条')
if (keepButton === undefined) fail('冲突条目没有「保留这条」按钮')
else {
  keepButton.props.onClick()
  tree = await settle(section.Component)
  const call = lastCall('resolve')
  if (call === undefined || call.body.action !== 'keep' || call.body.id !== 'mem_3') {
    fail(`解决冲突请求不对：${JSON.stringify(call && call.body)}`)
  } else ok('点「保留这条」→ resolve{id:mem_3, action:keep}')
}

/* 撤销软删 */
const restoreButton = findButton(tree, '恢复')
if (restoreButton === undefined) fail('待清理条目没有「恢复」按钮')
else {
  restoreButton.props.onClick()
  tree = await settle(section.Component)
  const call = lastCall('restore')
  if (call === undefined || call.body.id !== 'mem_4') fail(`恢复请求不对：${JSON.stringify(call && call.body)}`)
  else ok('点「恢复」→ restore{id:mem_4}')
}

/* 软删 */
const softButton = findButton(tree, '软删')
if (softButton === undefined) fail('没有「软删」按钮')
else {
  softButton.props.onClick()
  await settle(section.Component)
  if (lastCall('softDelete') === undefined) fail('点软删没有发 softDelete')
  else ok('点软删 → softDelete')
}

/* 按会话忘却（两步确认） */
const forgetButton = findButton(tree, '忘却…')
if (forgetButton === undefined) fail('没有「忘却…」按钮')
else {
  forgetButton.props.onClick()
  tree = await settle(section.Component)
  const confirmForget = findButton(tree, '确认忘却')
  if (confirmForget === undefined) fail('点了忘却… 没有进入二次确认')
  else {
    confirmForget.props.onClick()
    await settle(section.Component)
    const call = lastCall('forgetSession')
    if (call === undefined || call.body.session_id !== 'sess-a') fail(`忘却请求不对：${JSON.stringify(call && call.body)}`)
    else ok('两次确认后 → forgetSession{session_id:sess-a}')
  }
}

/* 导出备份 */
const exportButton = findButton(tree, '导出备份')
if (exportButton === undefined) fail('没有「导出备份」按钮')
else {
  exportButton.props.onClick()
  await settle(section.Component)
  if (lastCall('export') === undefined) fail('点导出备份没有发 export')
  else ok('点导出备份 → export')
}

/* 卸载 */
for (const dispose of disposers) if (typeof dispose === 'function') dispose()
if (registrations.length !== 0) fail(`卸载后仍残留 ${registrations.length} 个注册`)
else ok('卸载后注册归零')

/* --------------------------------- 报告 --------------------------------- */

for (const line of checks) console.log(`  ✓ ${line}`)
if (problems.length === 0) {
  console.log(`client check: ${checks.length} 项通过`)
  process.exit(0)
}
console.error(`client check 失败（${problems.length} 项）：`)
for (const problem of problems) console.error(`  ✗ ${problem}`)
process.exit(1)
