/**
 * UI 面板的宿主半身：一个 HTTP 路由，按 `op` 分发。
 *
 * 只给「设置页里那块记忆面板」用，不是新的公开 API：
 * - 只接受 POST + JSON，只放行本机回环来源；
 * - op 白名单，不认识的一律拒绝；
 * - 配置只能改 TUNABLE_CONFIG_KEYS 里那三个字段（否则小白能把库写坏）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { MemoryBackend } from '../store/backend.js'
import type { IndexEntry, MemoryConfig, MemoryRuntimeConfig } from '../types.js'
import { DEFAULT_BUDGET, DEFAULT_INJECT_BUDGET_CHARS, MAX_TOP_K, RUNTIME_CONFIG_FILE } from '../types.js'
import { recallPreview } from './injection.js'
import {
  atomicWriteAbsolute,
  memoryFileBody,
  rebuildIndex,
} from '../store/index-store.js'
import { mutateIndex, patchEntryFile } from '../store/file-backend.js'
import { confirmHandler } from '../tools/confirm.js'
import { forgetHandler } from '../tools/forget.js'
import { resolveHandler } from '../tools/resolve.js'
import { sweepHandler } from '../tools/sweep.js'
import { buildSearchGuidance, searchHandler } from '../tools/search.js'
import { buildFacets } from '../store/facets.js'
import { loadUsage, mergeUsage } from '../store/usage.js'
import { loadQueryLog, QUERY_LOG_LIMIT } from '../store/query-log.js'
import { writeHandler } from '../tools/write.js'
import { listSlots, rebuildDigest, slotEntriesOf } from '../tools/digest.js'

/** 前端固定调用这个路径。 */
export const API_PATH = '/memory-agent/api'

/** 面板一次最多列多少条，避免把整库塞进浏览器。 */
const LIST_LIMIT = 300
/** 请求体上限。 */
const BODY_LIMIT = 64 * 1024
/** 详情里原文预览的上限（想看全文还是走 memory_nav 下钻）。 */
const RAW_PREVIEW_LIMIT = 4000
/** 导出备份的总字节上限，避免一次把几百 MB 塞进浏览器。 */
const EXPORT_BYTE_LIMIT = 8 * 1024 * 1024

export const DEFAULT_RUNTIME_CONFIG: MemoryRuntimeConfig = {
  requireConfirmation: false,
  defaultBudget: DEFAULT_BUDGET,
  maxTopK: MAX_TOP_K,
  redactSecrets: true,
  injectEnabled: true,
  injectBudgetChars: DEFAULT_INJECT_BUDGET_CHARS,
  autoSettleEnabled: false,
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** 只认白名单字段，其余丢弃；数值做范围收敛。 */
export function normalizeRuntimeConfig(raw: Record<string, unknown>): Partial<MemoryRuntimeConfig> {
  const out: Partial<MemoryRuntimeConfig> = {}
  if (typeof raw.requireConfirmation === 'boolean') out.requireConfirmation = raw.requireConfirmation
  if (typeof raw.redactSecrets === 'boolean') out.redactSecrets = raw.redactSecrets
  if (typeof raw.injectEnabled === 'boolean') out.injectEnabled = raw.injectEnabled
  if (typeof raw.defaultBudget === 'number' && Number.isFinite(raw.defaultBudget)) {
    out.defaultBudget = clampInt(raw.defaultBudget, 50, 20000)
  }
  if (typeof raw.maxTopK === 'number' && Number.isFinite(raw.maxTopK)) {
    out.maxTopK = clampInt(raw.maxTopK, 1, MAX_TOP_K)
  }
  if (typeof raw.injectBudgetChars === 'number' && Number.isFinite(raw.injectBudgetChars)) {
    out.injectBudgetChars = clampInt(raw.injectBudgetChars, 200, 8000)
  }
  if (typeof raw.autoSettleEnabled === 'boolean') out.autoSettleEnabled = raw.autoSettleEnabled
  return out
}

/** 启动时算初始配置：cordis 配置打底，<root>/config.json 覆盖。 */
export function createRuntimeConfig(
  root: string,
  patch: MemoryConfig | undefined,
): MemoryRuntimeConfig {
  const base: MemoryRuntimeConfig = {
    requireConfirmation: patch?.requireConfirmation === true,
    redactSecrets: patch?.redactSecrets !== false,
    injectEnabled: patch?.injectEnabled !== false,
    defaultBudget: typeof patch?.defaultBudget === 'number'
      ? clampInt(patch.defaultBudget, 50, 20000)
      : DEFAULT_RUNTIME_CONFIG.defaultBudget,
    maxTopK: typeof patch?.maxTopK === 'number'
      ? clampInt(patch.maxTopK, 1, MAX_TOP_K)
      : DEFAULT_RUNTIME_CONFIG.maxTopK,
    injectBudgetChars: typeof patch?.injectBudgetChars === 'number'
      ? clampInt(patch.injectBudgetChars, 200, 8000)
      : DEFAULT_RUNTIME_CONFIG.injectBudgetChars,
    autoSettleEnabled: patch?.lifecycle?.autoSettle?.enabled === true,
  }
  try {
    const text = readFileSync(path.join(root, RUNTIME_CONFIG_FILE), 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...base, ...normalizeRuntimeConfig(parsed as Record<string, unknown>) }
    }
  } catch {
    // 没有 config.json / 内容坏了 → 退回 cordis 配置
  }
  return base
}

/** 落盘运行期配置（原子写）。 */
export async function writeRuntimeConfig(
  backend: MemoryBackend,
  config: MemoryRuntimeConfig,
): Promise<void> {
  await atomicWriteAbsolute(
    path.join(backend.root, RUNTIME_CONFIG_FILE),
    `${JSON.stringify(config, null, 2)}\n`,
  )
}

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
  }): () => void
}

export interface MemoryApiDeps {
  backend: MemoryBackend
  config: MemoryRuntimeConfig
}

/**
 * 注册面板路由；宿主没提供 webServer 时安静跳过（工具照常可用）。
 * 返回 disposer，调用方用 ctx.effect 兜住。
 */
export function registerMemoryApi(
  ctx: { get?: (name: string) => unknown; webServer?: unknown },
  deps: MemoryApiDeps,
): (() => void) | undefined {
  const server = resolveWebServer(ctx)
  if (server === undefined) return undefined
  try {
    return server.register({ kind: 'exact', path: API_PATH, handler: createApiHandler(deps) })
  } catch {
    return undefined
  }
}

function resolveWebServer(
  ctx: { get?: (name: string) => unknown; webServer?: unknown },
): WebServerLike | undefined {
  // 属性访问优先（cordis 服务挂在 ctx 属性上，这是宿主插件的通行写法）；ctx.get 作兜底
  const candidate = (ctx.webServer
    ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)) as Partial<WebServerLike> | undefined
  if (candidate === undefined || candidate === null) {
    console.warn('[dsh-memory-agent] webServer 服务不可用，UI 面板 API 未注册（工具不受影响）')
    return undefined
  }
  if (typeof candidate.register !== 'function') {
    console.warn('[dsh-memory-agent] webServer 形状不对（缺 register），UI 面板 API 未注册')
    return undefined
  }
  return candidate as WebServerLike
}

interface HttpRequestLike {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string }
  on?: (event: string, cb: (chunk?: unknown) => void) => void
}

interface HttpResponseLike {
  writeHead: (code: number, headers: Record<string, string>) => void
  end: (body?: string) => void
}

/** 单独暴露 handler，fixture 可以用假 req/res 直接打。 */
export function createApiHandler(deps: MemoryApiDeps) {
  return async (req: unknown, res: unknown): Promise<void> => {
    const request = req as HttpRequestLike
    const response = res as HttpResponseLike

    if (request.method !== 'POST') {
      send(response, 405, { ok: false, error: 'POST only' })
      return
    }
    if (!isTrustedRequest(request)) {
      send(response, 403, { ok: false, error: 'cross-origin or non-loopback request rejected' })
      return
    }

    let payload: Record<string, unknown>
    try {
      payload = await readJsonBody(request)
    } catch (error) {
      send(response, 400, { ok: false, error: error instanceof Error ? error.message : 'bad body' })
      return
    }

    try {
      send(response, 200, { ok: true, data: await dispatch(deps, payload) })
    } catch (error) {
      send(response, 200, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

async function dispatch(
  deps: MemoryApiDeps,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const op = typeof payload.op === 'string' ? payload.op : ''
  switch (op) {
    case 'status':
      return statusOf(deps)
    case 'config.set':
      return updateConfig(deps, payload)
    case 'rebuild':
      return rebuild(deps)
    case 'confirm':
      return confirmHandler(deps.backend, { id: String(payload.id ?? '') })
    case 'resolve':
      return resolveHandler(deps.backend, {
        id: String(payload.id ?? ''),
        action: payload.action === 'drop' ? 'drop' : 'keep',
      })
    case 'softDelete':
      return softDeleteEntry(deps, payload)
    case 'restore':
      return restoreEntry(deps, payload)
    case 'purgeDeleted':
      return purgeDeleted(deps)
    case 'search':
      return searchMemory(deps, payload)
    case 'detail':
      return detailOf(deps, payload)
    case 'create':
      return createMemory(deps, payload)
    case 'forgetSession':
      return forgetSession(deps, payload)
    case 'export':
      return exportBundle(deps)
    case 'injectPreview':
      return recallPreview(deps.backend.root, deps.config)
    case 'digestList':
      return digestList(deps)
    case 'digestRebuild':
      return digestRebuildFor(deps, payload)
    case 'sweep':
      return sweepHandler(deps.backend, { days: typeof payload.days === 'number' ? payload.days : undefined })
    case 'queryLog':
      return queryLogOf(deps)
    default:
      throw new Error(`unknown op ${JSON.stringify(op)}`)
  }
}

/**
 * 导出备份：把索引 + 每个记忆文件的正文打成一个 JSON bundle。
 * 小白最怕「数据只在某个文件夹里」，所以给一个能存到别处的整包。
 */
async function exportBundle(deps: MemoryApiDeps): Promise<unknown> {
  await deps.backend.init()
  const entries = await deps.backend.readIndex()
  const files: Array<{ path: string; text: string }> = []
  let bytes = 0
  let truncated = false
  for (const entry of entries) {
    const text = await deps.backend.readFile(entry.path)
    if (text === null) continue
    bytes += text.length
    if (bytes > EXPORT_BYTE_LIMIT) {
      truncated = true
      break
    }
    files.push({ path: entry.path, text })
  }
  return {
    bundle: {
      format: 'dsh-memory-agent/export',
      version: 1,
      exported_at: deps.backend.now(),
      root: deps.backend.root,
      entries,
      files,
      truncated,
      bytes,
    },
  }
}

async function statusOf(deps: MemoryApiDeps): Promise<unknown> {
  await deps.backend.init()
  const entries = await deps.backend.readIndex()
  const counts = {
    total: entries.length,
    active: 0,
    suggested: 0,
    superseded: 0,
    conflict: 0,
    deleted_pending: 0,
    orphaned: 0,
  }
  for (const entry of entries) counts[entry.status] = (counts[entry.status] ?? 0) + 1
  // 使用信号是旁路文件，展示前合并进来（不改索引、不影响检索排序）
  mergeUsage(entries, await loadUsage(deps.backend))
  const recent = entries
    .slice()
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, LIST_LIMIT)
    .map((entry) => ({
      id: entry.id,
      path: entry.path,
      type: entry.type,
      title: entry.title,
      summary: entry.summary,
      status: entry.status,
      time: entry.time,
      tags: entry.tags,
      session_id: entry.session_id,
      source_count: entry.sources.length,
      hit_count: entry.hit_count ?? 0,
      last_used_at: entry.last_used_at ?? null,
    }))
  // 会话汇总：小白不知道 session_id 是什么，但「按会话忘却」需要它
  const sessionMap = new Map<string, { entries: number; active: number; deleted: number }>()
  for (const entry of entries) {
    for (const source of entry.sources) {
      const bucket = sessionMap.get(source.session_id)
        ?? { entries: 0, active: 0, deleted: 0 }
      bucket.entries += 1
      if (entry.status === 'deleted_pending') bucket.deleted += 1
      else bucket.active += 1
      sessionMap.set(source.session_id, bucket)
    }
  }
  const sessions = [...sessionMap.entries()]
    .map(([session_id, bucket]) => ({ session_id, ...bucket }))
    .sort((a, b) => b.entries - a.entries)
    .slice(0, 50)

  return {
    root: deps.backend.root,
    config: { ...deps.config },
    counts,
    entries: recent,
    sessions,
    facets: buildFacets(entries),
    list_limit: LIST_LIMIT,
  }
}

async function updateConfig(
  deps: MemoryApiDeps,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const patchRaw = payload.config
  if (patchRaw === null || typeof patchRaw !== 'object' || Array.isArray(patchRaw)) {
    throw new Error('config 必须是对象')
  }
  const patch = normalizeRuntimeConfig(patchRaw as Record<string, unknown>)
  if (Object.keys(patch).length === 0) throw new Error('没有可用的配置字段')
  Object.assign(deps.config, patch)
  await writeRuntimeConfig(deps.backend, deps.config)
  await deps.backend.appendLedger({ at: deps.backend.now(), type: 'ui/config.set', patch })
  return { config: { ...deps.config } }
}

async function rebuild(deps: MemoryApiDeps): Promise<unknown> {
  await deps.backend.init()
  const result = await rebuildIndex(deps.backend.root)
  await deps.backend.appendLedger({
    at: deps.backend.now(),
    type: 'ui/rebuild',
    entry_count: result.entries.length,
    scanned: result.scanned,
    skipped: result.skipped,
  })
  return { entry_count: result.entries.length, scanned: result.scanned, skipped: result.skipped }
}

/** 面板上的「软删」：单条标 deleted_pending，文件保留、从检索里移除。 */
async function softDeleteEntry(
  deps: MemoryApiDeps,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const id = typeof payload.id === 'string' ? payload.id.trim() : ''
  if (id === '') throw new Error('id 必填')
  return mutateIndex(deps.backend, async (entries) => {
    const entry: IndexEntry | undefined = entries.find((item) => item.id === id)
    if (entry === undefined) throw new Error(`没有这条记忆：${id}`)
    const now = deps.backend.now()
    // 一条记忆可能带原文兄弟条目：软删要一起删，否则原文还会被检索到
    const targets = entries.filter((item) => item.id === entry.id
      || (entry.raw_ref !== undefined && item.path === entry.raw_ref))
    for (const target of targets) {
      if (target.status === 'deleted_pending') continue
      target.status = 'deleted_pending'
      target.deleted_at = now
      target.deleted_by_session = 'ui'
      await patchEntryFile(deps.backend, target.path, {
        status: 'deleted_pending',
        deleted_at: now,
        deleted_by_session: 'ui',
      })
    }
    await deps.backend.appendLedger({
      at: now,
      type: 'ui/soft-delete',
      id: entry.id,
      path: entry.path,
      also: targets.map((item) => item.id),
    })
    return { id: entry.id, status: entry.status }
  })
}

/** 撤销软删：deleted_pending → active（面板上的「恢复」）。 */
async function restoreEntry(
  deps: MemoryApiDeps,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const id = typeof payload.id === 'string' ? payload.id.trim() : ''
  if (id === '') throw new Error('id 必填')
  return mutateIndex(deps.backend, async (entries) => {
    const entry = entries.find((item) => item.id === id)
    if (entry === undefined) throw new Error(`没有这条记忆：${id}`)
    if (entry.status !== 'deleted_pending') {
      throw new Error(`只有「待清理」的条目能恢复（id=${id}, status=${entry.status}）`)
    }
    entry.status = 'active'
    delete entry.deleted_at
    delete entry.deleted_by_session
    await patchEntryFile(deps.backend, entry.path, {
      status: 'active',
      deleted_at: undefined,
      deleted_by_session: undefined,
    })
    await deps.backend.appendLedger({
      at: deps.backend.now(),
      type: 'ui/restore',
      id: entry.id,
      path: entry.path,
    })
    return { id: entry.id, status: entry.status }
  })
}

/** 把已标 deleted_pending 的 episodes/raw 文件真正删掉（topics 永不删）。 */
async function purgeDeleted(deps: MemoryApiDeps): Promise<unknown> {
  return mutateIndex(deps.backend, async (entries) => {
    const targets = entries.filter(
      (entry) => entry.status === 'deleted_pending' && (entry.type === 'episode' || entry.type === 'raw'),
    )
    const removed: string[] = []
    for (const entry of targets) {
      if (await deps.backend.removeFile(entry.path)) removed.push(entry.path)
    }
    const dropped = new Set(targets.map((entry) => entry.id))
    const kept = entries.filter((entry) => !dropped.has(entry.id))
    entries.splice(0, entries.length, ...kept)
    await deps.backend.appendLedger({
      at: deps.backend.now(),
      type: 'ui/purge',
      removed_count: removed.length,
      removed_paths: removed,
    })
    return { removed_count: removed.length, removed_paths: removed }
  })
}

/** 面板搜索框：复用同一个 BM25 handler，保证「面板搜到的 = 模型搜到的」。 */
async function searchMemory(
  deps: MemoryApiDeps,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const query = typeof payload.query === 'string' ? payload.query : ''
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((item): item is string => typeof item === 'string')
    : undefined
  const topK = typeof payload.top_k === 'number' ? payload.top_k : 20
  const hits = await searchHandler(deps.backend, {
    query,
    top_k: Math.min(topK, deps.config.maxTopK),
    ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
  })
  return { hits, guidance: await buildSearchGuidance(deps.backend, hits) }
}

/** 单条详情：摘要 + 冲突现场 + 原文预览（显式点开才给）。 */
async function detailOf(
  deps: MemoryApiDeps,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const id = typeof payload.id === 'string' ? payload.id.trim() : ''
  if (id === '') throw new Error('id 必填')
  const entries = await deps.backend.readIndex()
  const entry = entries.find((item) => item.id === id)
  if (entry === undefined) throw new Error(`没有这条记忆：${id}`)
  let raw: string | undefined
  if (entry.raw_ref !== undefined && payload.with_raw !== false) {
    const text = await deps.backend.readFile(entry.raw_ref)
    if (text !== null) raw = memoryFileBody(text).slice(0, RAW_PREVIEW_LIMIT)
  }
  return {
    entry: {
      id: entry.id,
      path: entry.path,
      type: entry.type,
      title: entry.title,
      summary: entry.summary,
      status: entry.status,
      time: entry.time,
      tags: entry.tags,
      entities: entry.entities,
      sources: entry.sources,
      confidence: entry.confidence,
      raw_ref: entry.raw_ref ?? null,
      variants: entry.variants ?? [],
    },
    raw: raw ?? null,
  }
}

/** 面板新建：用户亲手写的记忆直接 active（不再过确认闸门，否则要多点一次）。 */
async function createMemory(
  deps: MemoryApiDeps,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : ''
  if (summary === '') throw new Error('summary 不能为空')
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((item): item is string => typeof item === 'string')
    : []
  const result = await writeHandler(deps.backend, {
    summary,
    tags,
    session_id: 'ui-panel',
    source: { session_id: 'ui-panel', kind: 'user' },
    requireConfirmation: false,
  })
  return result
}

/** 按会话忘却：面板给出 session 列表，点一下就走 forget。 */
async function forgetSession(
  deps: MemoryApiDeps,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : ''
  if (sessionId === '') throw new Error('session_id 必填')
  return forgetHandler(deps.backend, {
    session_id: sessionId,
    scope: payload.scope === 'session_only' ? 'session_only' : 'include_shared_unlink',
    mode: payload.mode === 'hard' ? 'hard' : 'soft',
  })
}

/**
 * 面板「当前认知」清单：每个槽位一段合成认知（带正文，列表里直接展示）。
 * 只读不重建——过期槽位标记 stale，等读取/重建动作去刷新。
 */
async function digestList(deps: MemoryApiDeps): Promise<unknown> {
  await deps.backend.init()
  const entries = await deps.backend.readIndex()
  return { slots: await listSlots(deps.backend, entries, true) }
}

/**
 * 面板「重建当前认知」：key 归一化后非空就只重建该槽位，没给就全量重建。
 * 全量重建记一条 ledger（单槽位是常规刷新，不值得刷屏）。
 */
async function digestRebuildFor(
  deps: MemoryApiDeps,
  payload: Record<string, unknown>,
): Promise<unknown> {
  await deps.backend.init()
  const entries = await deps.backend.readIndex()
  const key = typeof payload.key === 'string' ? payload.key.trim().toLowerCase() : ''
  if (key !== '') {
    const { current } = slotEntriesOf(entries, key)
    if (current.length === 0) throw new Error(`没有这个槽位：${key}`)
    await rebuildDigest(deps.backend, key, entries, deps.backend.now())
    return { rebuilt: 1 }
  }
  const slots = await listSlots(deps.backend, entries, false)
  const now = deps.backend.now()
  for (const item of slots) {
    await rebuildDigest(deps.backend, item.slot, entries, now)
  }
  await deps.backend.appendLedger({ at: now, type: 'ui/digest-rebuild', count: slots.length })
  return { rebuilt: slots.length }
}

/**
 * 面板「检索日志」：entries 时间正序，面板自己取尾部展示；
 * limit 是日志的有界上限（QUERY_LOG_LIMIT=200），方便前端说明「最多留这么多条」。
 */
async function queryLogOf(deps: MemoryApiDeps): Promise<unknown> {
  await deps.backend.init()
  return { entries: await loadQueryLog(deps.backend), limit: QUERY_LOG_LIMIT }
}

/* ------------------------------- HTTP 小工具 ------------------------------- */

function send(response: HttpResponseLike, code: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body).toString(),
  })
  response.end(body)
}

/**
 * 来源校验。三重条件，任一不满足就 403：
 * 1. 必须来自本机回环；
 * 2. 必须是 `content-type: application/json`（挡掉表单/纯文本的 CSRF 面）；
 * 3. 要么 Origin 与 Host 一致（浏览器正常情况），
 *    要么带我们自己的 `x-dsh-memory-agent: panel` 头（自定义协议下没有 Origin 时的兜底）。
 *    两者都没有 → 直接拒绝，所以 `curl -X POST` 打不进来。
 */
function isTrustedRequest(request: HttpRequestLike): boolean {
  const remote = String(request.socket?.remoteAddress ?? '')
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) return false

  if (!headerOf(request, 'content-type').toLowerCase().startsWith('application/json')) return false

  const host = headerOf(request, 'host')
  const origin = headerOf(request, 'origin')
  if (origin !== '') {
    if (origin === 'null') return true
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  return headerOf(request, 'x-dsh-memory-agent') === 'panel'
}

function headerOf(request: HttpRequestLike, name: string): string {
  const headers = request.headers ?? {}
  const raw = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(raw)) return String(raw[0] ?? '')
  return raw === undefined ? '' : String(raw)
}

function readJsonBody(request: HttpRequestLike): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (typeof request.on !== 'function') {
      reject(new Error('request stream unavailable'))
      return
    }
    const chunks: string[] = []
    let size = 0
    request.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      size += text.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        return
      }
      chunks.push(text)
    })
    request.on('end', () => {
      const raw = chunks.join('').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('body must be a JSON object'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    request.on('error', () => reject(new Error('request stream error')))
  })
}
