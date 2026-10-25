#!/usr/bin/env node
/**
 * UI 宿主半身（/memory-agent/api）的离线断言：
 * 用假 req/res 直接打 handler，验证来源校验、op 分发、配置落盘与实际副作用。
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const { createFileBackend } = await load('lib/store/file-backend.js')
const { createApiHandler, createRuntimeConfig, API_PATH } = await load('lib/host/api.js')
const { writeHandler } = await load('lib/tools/write.js')

const problems = []
const checks = []
const fail = (msg) => problems.push(msg)
const ok = (msg) => checks.push(msg)

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-memory-agent-api-'))
const backend = createFileBackend(root)
await backend.init()
const runtime = createRuntimeConfig(root, { defaultBudget: 1200, maxTopK: 200 })
const handler = createApiHandler({ backend, config: runtime })

/** 假 req：注册 on() 之后用 microtask 回放 body，模拟流。 */
function makeReq(options = {}) {
  const {
    method = 'POST',
    body,
    remote = '127.0.0.1',
    headers = {
      host: '127.0.0.1:43120',
      origin: 'http://127.0.0.1:43120',
      'content-type': 'application/json',
    },
  } = options
  const listeners = {}
  const request = {
    method,
    headers,
    socket: { remoteAddress: remote },
    on(event, callback) {
      ;(listeners[event] ??= []).push(callback)
      return request
    },
  }
  queueMicrotask(() => {
    if (body !== undefined) for (const callback of listeners.data ?? []) callback(body)
    for (const callback of listeners.end ?? []) callback()
  })
  return request
}

function makeRes() {
  const state = { code: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(code, headers) {
      state.code = code
      state.headers = headers
    },
    end(body) {
      state.body = body ?? ''
    },
    json() {
      return JSON.parse(state.body)
    },
  }
}

async function call(payload, options = {}) {
  const res = makeRes()
  await handler(makeReq({ body: JSON.stringify(payload), ...options }), res)
  return { code: res.state.code, body: res.json() }
}

/* --------------------------------- 断言 --------------------------------- */

const pathCheck = API_PATH === '/memory-agent/api'
pathCheck ? ok(`路由路径 = ${API_PATH}`) : fail(`路由路径不对：${API_PATH}`)

const notPost = await call({ op: 'status' }, { method: 'GET' })
notPost.code === 405 ? ok('GET → 405') : fail(`GET 应 405，实际 ${notPost.code}`)

const nonLoopback = await call({ op: 'status' }, { remote: '10.1.2.3' })
nonLoopback.code === 403 ? ok('非回环来源 → 403') : fail(`非回环应 403，实际 ${nonLoopback.code}`)

const crossOrigin = await call(
  { op: 'status' },
  { headers: { host: '127.0.0.1:43120', origin: 'https://evil.example', 'content-type': 'application/json' } },
)
crossOrigin.code === 403 ? ok('跨域 Origin → 403') : fail(`跨域应 403，实际 ${crossOrigin.code}`)

const noOrigin = await call(
  { op: 'status' },
  { headers: { host: '127.0.0.1:43120', 'content-type': 'application/json' } },
)
noOrigin.code === 403
  ? ok('无 Origin 且无面板头（curl 那种）→ 403')
  : fail(`无 Origin 应 403，实际 ${noOrigin.code}`)

const formPost = await call(
  { op: 'status' },
  { headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120', 'content-type': 'text/plain' } },
)
formPost.code === 403 ? ok('非 JSON content-type → 403') : fail(`非 JSON 应 403，实际 ${formPost.code}`)

const panelHeader = await call(
  { op: 'status' },
  {
    headers: {
      host: 'app://desktop',
      'content-type': 'application/json',
      'x-dsh-memory-agent': 'panel',
    },
  },
)
panelHeader.code === 200
  ? ok('自定义协议（无 Origin）带面板头 → 放行')
  : fail(`面板头请求应 200，实际 ${panelHeader.code}`)

const empty = await call({ op: 'status' })
empty.body.ok && empty.body.data.counts.total === 0
  ? ok('空库 status → total=0')
  : fail(`空库 status 不对：${JSON.stringify(empty.body)}`)

// 常驻注入：空库时 enabled 默认开但不注入任何文本
const previewEmpty = await call({ op: 'injectPreview' })
previewEmpty.body.ok && previewEmpty.body.data.enabled === true && previewEmpty.body.data.text === ''
  ? ok('injectPreview 空库：默认启用且文本为空')
  : fail(`injectPreview 空库不对：${JSON.stringify(previewEmpty.body).slice(0, 200)}`)

const written = await writeHandler(backend, {
  summary: '面板测试用记忆：pnpm 是默认包管理器',
  tags: ['ui-test'],
  session_id: 'ui-session',
})
const afterWrite = await call({ op: 'status' })
afterWrite.body.data.counts.active === 1 && afterWrite.body.data.entries.length === 1
  ? ok('写入一条后 status 里能看到（active=1）')
  : fail(`写入后统计不对：${JSON.stringify(afterWrite.body.data.counts)}`)
afterWrite.body.data.root === backend.root
  ? ok('status 回传 root')
  : fail('status 没有回传 root')

const configured = await call({ op: 'config.set', config: { defaultBudget: 800, maxTopK: 9999 } })
configured.body.ok && configured.body.data.config.defaultBudget === 800
  ? ok('config.set 生效（defaultBudget=800）')
  : fail(`config.set 失败：${JSON.stringify(configured.body)}`)
configured.body.data.config.maxTopK === 200
  ? ok('config.set 对 maxTopK 做上限收敛（9999 → 200）')
  : fail(`maxTopK 未收敛：${configured.body.data?.config?.maxTopK}`)

const savedFile = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'))
savedFile.defaultBudget === 800
  ? ok('config.json 已落盘')
  : fail(`config.json 内容不对：${JSON.stringify(savedFile)}`)

const reloaded = createRuntimeConfig(root, { defaultBudget: 1200 })
reloaded.defaultBudget === 800 && reloaded.maxTopK === 200
  ? ok('重启后 createRuntimeConfig 能读回覆盖值')
  : fail(`重启读回不对：${JSON.stringify(reloaded)}`)

const rebuilt = await call({ op: 'rebuild' })
rebuilt.body.ok && rebuilt.body.data.entry_count === 1
  ? ok('rebuild → entry_count=1')
  : fail(`rebuild 不对：${JSON.stringify(rebuilt.body)}`)

// 建议状态 → 面板确认
const suggested = await writeHandler(backend, {
  summary: '待确认的记忆：周五之前别动生产库',
  session_id: 'ui-session',
  requireConfirmation: true,
})
const afterSuggest = await call({ op: 'status' })
afterSuggest.body.data.counts.suggested === 1
  ? ok('requireConfirmation=true 写入 → suggested=1')
  : fail(`suggested 统计不对：${JSON.stringify(afterSuggest.body.data.counts)}`)

const confirmed = await call({ op: 'confirm', id: suggested.id })
confirmed.body.ok && confirmed.body.data.status === 'active'
  ? ok('confirm → active')
  : fail(`confirm 失败：${JSON.stringify(confirmed.body)}`)

// 软删 + 清理（用带原文的 episode：一条记忆 = episode + raw 两个文件）
const episodic = await writeHandler(backend, {
  summary: '面板测试用情节：WAL 让读写并行',
  raw: 'WAL 模式允许读写并行，checkpoint 负责回刷。',
  session_id: 'ui-session',
})
const soft = await call({ op: 'softDelete', id: episodic.id })
soft.body.ok && soft.body.data.status === 'deleted_pending'
  ? ok('softDelete → deleted_pending')
  : fail(`softDelete 失败：${JSON.stringify(soft.body)}`)

const stillThere = await stat(path.join(root, episodic.path)).then(() => true).catch(() => false)
stillThere ? ok('软删后文件仍在（可恢复）') : fail('软删不该删文件')

const purged = await call({ op: 'purgeDeleted' })
purged.body.ok && purged.body.data.removed_count === 2
  ? ok('purgeDeleted → 连原文一起清掉（2 个文件）')
  : fail(`purgeDeleted 不对：${JSON.stringify(purged.body)}`)

const gone = await stat(path.join(root, episodic.path)).then(() => false).catch(() => true)
gone ? ok('清理后文件真的没了') : fail('清理后文件仍在')

// 并发写：没有索引锁时这里会丢一条（读-改-写互相覆盖）
const totalBefore = (await call({ op: 'status' })).body.data.counts.total
await Promise.all([
  writeHandler(backend, { summary: '并发写 A：两个写同时进来不该丢条目', session_id: 'race' }),
  writeHandler(backend, { summary: '并发写 B：两个写同时进来不该丢条目', session_id: 'race' }),
])
const totalAfter = (await call({ op: 'status' })).body.data.counts.total
totalAfter === totalBefore + 2
  ? ok('并发写两条 → 索引里多了 2 条（写锁生效）')
  : fail(`并发写丢条目：${totalBefore} → ${totalAfter}`)

// 面板搜索 / 详情
const searched = await call({ op: 'search', query: '并发写', top_k: 10 })
searched.body.ok && searched.body.data.hits.length >= 2
  ? ok('search op 复用 BM25（命中 ≥ 2）')
  : fail(`search op 不对：${JSON.stringify(searched.body)}`)
searched.body.data.hits.every((hit) => hit.reason === 'bm25')
  ? ok('字面命中标 reason=bm25')
  : fail(`reason 标记不对：${JSON.stringify(searched.body.data.hits.map((h) => h.reason))}`)

const zeroHit = await call({ op: 'search', query: '完全不存在的关键词', top_k: 10 })
zeroHit.body.ok && zeroHit.body.data.hits.length === 0
  && zeroHit.body.data.guidance.includes('没有直接命中')
  ? ok('零命中 → guidance 给出下一步')
  : fail(`零命中引导不对：${JSON.stringify(zeroHit.body).slice(0, 200)}`)

const statusFacets = await call({ op: 'status' })
statusFacets.body.data.facets !== undefined
  && statusFacets.body.data.facets.total === statusFacets.body.data.counts.total
  ? ok('status 带库画像 facets（总数对齐）')
  : fail(`status 缺 facets：${JSON.stringify(statusFacets.body.data.facets)}`)

const detailed = await call({ op: 'detail', id: written.id })
detailed.body.ok && detailed.body.data.entry.id === written.id
  ? ok('detail op 返回条目详情')
  : fail(`detail op 不对：${JSON.stringify(detailed.body)}`)

// 面板新建
const created = await call({ op: 'create', summary: '面板新建：周五前别动生产库', tags: ['ui'] })
created.body.ok && created.body.data.status === 'active'
  ? ok('create op 直接落 active')
  : fail(`create op 不对：${JSON.stringify(created.body)}`)

// 冲突 → resolve keep → 旧说法退出检索
const conflictA = await writeHandler(backend, { summary: '缓存策略用互斥重建兜底', title: '缓存策略', session_id: 'c1' })
// 冲突必须显式声明：默认语义是「同槽位 = 版本演进」，不是「互相矛盾」
const conflictB = await writeHandler(backend, {
  summary: '缓存策略改用逻辑过期加异步刷新',
  title: '缓存策略',
  session_id: 'c2',
  expectConflict: true,
})
if (conflictB.status !== 'conflict') fail(`造冲突失败：${conflictB.status}`)
const beforeResolve = await call({ op: 'search', query: '缓存策略', top_k: 10 })
const resolved = await call({ op: 'resolve', id: conflictB.id, action: 'keep' })
const afterResolve = await call({ op: 'search', query: '缓存策略', top_k: 10 })
resolved.body.ok && resolved.body.data.status === 'active'
  && resolved.body.data.superseded.includes(conflictA.id)
  ? ok('resolve keep → 本条 active、旧说法 superseded')
  : fail(`resolve 不对：${JSON.stringify(resolved.body)}`)
beforeResolve.body.data.hits.length === 2 && afterResolve.body.data.hits.length === 1
  ? ok('裁决后旧说法退出检索（2 → 1）')
  : fail(`裁决后检索条数不对：${beforeResolve.body.data.hits.length} → ${afterResolve.body.data.hits.length}`)

// 版本演进：同 key 第二次写入取代第一次，旧版退出检索
const evolveA = await writeHandler(backend, { summary: '包管理器是 npm', key: 'project.pkg', session_id: 'e1' })
const evolveB = await writeHandler(backend, { summary: '包管理器改成 pnpm', key: 'project.pkg', session_id: 'e2' })
evolveB.supersedes?.includes(evolveA.id)
  ? ok('同 key 写入 → 旧版本被取代（supersedes 指回）')
  : fail(`版本演进没生效：${JSON.stringify(evolveB)}`)
const afterEvolve = await call({ op: 'status' })
afterEvolve.body.data.entries.find((entry) => entry.id === evolveA.id)?.status === 'superseded'
  ? ok('旧版本状态 = superseded')
  : fail('旧版本没转 superseded')
const evolveSearch = await call({ op: 'search', query: '包管理器', top_k: 10 })
!evolveSearch.body.data.hits.some((hit) => hit.id === evolveA.id)
  && evolveSearch.body.data.hits.some((hit) => hit.id === evolveB.id)
  ? ok('旧版本退出检索、新版可检索')
  : fail(`检索结果不对：${JSON.stringify(evolveSearch.body.data.hits.map((hit) => hit.id))}`)

// 体检接口（只读）
const sweep = await call({ op: 'sweep' })
sweep.body.ok && Array.isArray(sweep.body.data.longUnused)
  ? ok('sweep op 返回只读清单')
  : fail(`sweep op 不对：${JSON.stringify(sweep.body).slice(0, 160)}`)

// 软删 → 恢复
const restoreTarget = await writeHandler(backend, { summary: '恢复测试：这条会被软删再恢复', session_id: 'ui-session' })
await call({ op: 'softDelete', id: restoreTarget.id })
const restored = await call({ op: 'restore', id: restoreTarget.id })
restored.body.ok && restored.body.data.status === 'active'
  ? ok('restore → 软删可撤销（active）')
  : fail(`restore 不对：${JSON.stringify(restored.body)}`)

// 按会话忘却
const forgetTarget = await writeHandler(backend, {
  summary: 'ZetaOnly 专用短语：这条属于 sess-gone',
  raw: 'ZetaOnly 原文也会一起标删。',
  session_id: 'sess-gone',
})
const forgot = await call({ op: 'forgetSession', session_id: 'sess-gone' })
forgot.body.ok && forgot.body.data.deleted_episode_count === 1 && forgot.body.data.deleted_raw_count === 1
  ? ok('forgetSession → episodes/raw 各 1 条待清理')
  : fail(`forgetSession 不对：${JSON.stringify(forgot.body)}`)
const afterForgetSearch = await call({ op: 'search', query: 'ZetaOnly', top_k: 10 })
afterForgetSearch.body.data.hits.length === 0
  ? ok('忘却后搜不到')
  : fail(`忘却后仍能搜到 ${afterForgetSearch.body.data.hits.length} 条`)

// 脱敏：连接串密码在原文文件里必须已经打码
const secret = await writeHandler(backend, {
  summary: '生产库连接串示例（会被脱敏）',
  raw: 'DATABASE_URL=postgres://app:S3cretPwd@db.internal:5432/app',
  session_id: 'sec',
})
const rawText = await backend.readFile(`raw/${secret.id}.md`)
rawText !== null && !rawText.includes('S3cretPwd') && rawText.includes('[已脱敏:url-password]')
  ? ok('连接串密码在落盘前已打码')
  : fail(`连接串密码没有脱敏：${rawText === null ? 'raw 文件缺失' : rawText.slice(0, 120)}`)

// 导出备份
const exported = await call({ op: 'export' })
const bundle = exported.body.data?.bundle
exported.body.ok && bundle.format === 'dsh-memory-agent/export'
  && Array.isArray(bundle.entries) && Array.isArray(bundle.files)
  ? ok(`export op 打出整包（${bundle.entries.length} 条 / ${bundle.files.length} 个文件）`)
  : fail(`export op 不对：${JSON.stringify(exported.body).slice(0, 200)}`)
bundle.files.length === bundle.entries.length && bundle.entries.length > 0
  ? ok('导出文件数与条目数一致')
  : fail(`导出文件数不符：${bundle.files.length} vs ${bundle.entries.length}`)

// 常驻注入：有库时给标题行且 chars ≤ budget；开关可关；预算做范围收敛
const previewFull = await call({ op: 'injectPreview' })
previewFull.body.ok
  && previewFull.body.data.text.includes('## 记忆（自动注入）')
  && previewFull.body.data.chars <= previewFull.body.data.budget
  ? ok(`injectPreview 有库时非空且 chars=${previewFull.body.data.chars} ≤ budget=${previewFull.body.data.budget}`)
  : fail(`injectPreview 有库时不对：${JSON.stringify(previewFull.body).slice(0, 200)}`)

const toggled = await call({ op: 'config.set', config: { injectEnabled: false } })
toggled.body.ok && toggled.body.data.config.injectEnabled === false
  ? ok('config.set 能关闭常驻注入')
  : fail(`关闭注入失败：${JSON.stringify(toggled.body).slice(0, 160)}`)
const previewOff = await call({ op: 'injectPreview' })
previewOff.body.data.enabled === false && previewOff.body.data.text !== ''
  ? ok('开关关闭后预览仍能看到「会注入什么」，但标记为停用')
  : fail(`关闭后的预览不对：${JSON.stringify(previewOff.body).slice(0, 160)}`)
const budgetClamped = await call({ op: 'config.set', config: { injectBudgetChars: 99999 } })
budgetClamped.body.ok && budgetClamped.body.data.config.injectBudgetChars === 8000
  ? ok('注入预算收敛到上限 8000')
  : fail(`预算未收敛：${JSON.stringify(budgetClamped.body.data?.config)}`)
await call({ op: 'config.set', config: { injectEnabled: true, injectBudgetChars: 1500 } })

// 自动沉淀开关：面板能改（写 config.json），status 回读要能看到
const settleOn = await call({ op: 'config.set', config: { autoSettleEnabled: true } })
settleOn.body.ok && settleOn.body.data.config.autoSettleEnabled === true
  ? ok('config.set 能打开自动沉淀（面板可改）')
  : fail(`打开自动沉淀失败：${JSON.stringify(settleOn.body).slice(0, 160)}`)
const settleStatus = await call({ op: 'status' })
settleStatus.body.data?.config?.autoSettleEnabled === true
  ? ok('status 回读带 autoSettleEnabled（面板 draft 拿得到）')
  : fail(`status 未回传 autoSettleEnabled：${JSON.stringify(settleStatus.body.data?.config)}`)
await call({ op: 'config.set', config: { autoSettleEnabled: false } })

// 检索日志（P2）：前面已有若干 search op（含零命中「完全不存在的关键词」），都应已记入 query-log
const queryLog = await call({ op: 'queryLog' })
const logRecords = queryLog.body?.data?.entries
queryLog.body.ok === true && Array.isArray(logRecords) && logRecords.length >= 1
  ? ok('queryLog 返回检索日志')
  : fail(`queryLog op 不对：${JSON.stringify(queryLog.body).slice(0, 200)}`)
if (Array.isArray(logRecords) && logRecords.length >= 1) {
  logRecords.every(
    (record) => typeof record.at === 'string' && typeof record.query === 'string' && typeof record.hits === 'number',
  )
    ? ok('queryLog 每条都带 at/query/hits')
    : fail(`queryLog 字段形状不对：${JSON.stringify(logRecords[0])}`)
  logRecords.some((record) => record.hits === 0)
    ? ok('零命中搜索已入日志（hits=0 可反查该补的记忆）')
    : fail('日志里没有 hits=0 的记录（零命中搜索没被记下）')
}

// 当前认知（P1）：清单 → 单槽位重建 → 带正文清单 → 全量重建。
// 此前流程不会生成 digest 文件，正文断言要等单槽位重建落盘后才成立。
const digestFirst = await call({ op: 'digestList' })
digestFirst.body.ok && Array.isArray(digestFirst.body.data.slots) && digestFirst.body.data.slots.length >= 1
  ? ok(`digestList 返回槽位清单（${digestFirst.body.data.slots.length} 个）`)
  : fail(`digestList 不对：${JSON.stringify(digestFirst.body).slice(0, 160)}`)

const digestTop = digestFirst.body.data?.slots?.[0]
const digestOne = digestTop === undefined
  ? { body: { ok: false, error: '没有槽位可用' } }
  : await call({ op: 'digestRebuild', key: digestTop.slot })
digestOne.body.ok && digestOne.body.data?.rebuilt === 1
  ? ok('digestRebuild 单槽位 → rebuilt=1')
  : fail(`digestRebuild 单槽位不对：${JSON.stringify(digestOne.body).slice(0, 160)}`)

const digestListed = await call({ op: 'digestList' })
const digestWithText = digestListed.body.data?.slots?.[0]
typeof digestWithText?.text === 'string' && digestWithText.text !== ''
  ? ok('digestList 带「当前认知」正文')
  : fail(`digestList 正文不对：${JSON.stringify(digestListed.body).slice(0, 160)}`)

const digestAll = await call({ op: 'digestRebuild' })
digestAll.body.ok && digestAll.body.data?.rebuilt >= 1
  ? ok(`digestRebuild 全量 → rebuilt=${digestAll.body.data?.rebuilt}`)
  : fail(`digestRebuild 全量不对：${JSON.stringify(digestAll.body).slice(0, 160)}`)

const unknown = await call({ op: 'rm-rf' })
unknown.body.ok === false ? ok('未知 op 被拒绝') : fail('未知 op 竟然通过了')

// 宿主没给 webServer 时不能炸
const { registerMemoryApi } = await load('lib/host/api.js')
const skipped = registerMemoryApi({ get: () => undefined }, { backend, config: runtime })
skipped === undefined ? ok('没有 webServer 时安静跳过') : fail('没有 webServer 时不该注册成功')

// 有 webServer 时注册 + 返回 disposer
let disposed = false
const fakeServer = {
  register(route) {
    if (route.path !== API_PATH) fail(`注册路径不对：${route.path}`)
    return () => {
      disposed = true
    }
  },
}
const dispose = registerMemoryApi({ get: () => fakeServer }, { backend, config: runtime })
typeof dispose === 'function' ? ok('有 webServer 时返回 disposer') : fail('没有返回 disposer')
if (typeof dispose === 'function') {
  dispose()
  disposed ? ok('disposer 能注销路由') : fail('disposer 没有生效')
}

await rm(root, { recursive: true, force: true })

for (const line of checks) console.log(`  ✓ ${line}`)
if (problems.length === 0) {
  console.log(`api check: ${checks.length} 项通过`)
  process.exit(0)
}
console.error(`api check 失败（${problems.length} 项）：`)
for (const problem of problems) console.error(`  ✗ ${problem}`)
process.exit(1)
