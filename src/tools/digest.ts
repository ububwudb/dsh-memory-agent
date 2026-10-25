/**
 * 当前认知（P1 分层蒸馏）：`<root>/digests/<slotKey>.md`。
 *
 * 每个槽位（write_memory 的 key，缺省回落标题）一段 200~400 token 的「当前认知」，
 * 带 updated_at 与来源 id 列表。规则版提炼：按时间抽最新 + 标注未裁决冲突 + 报历史版本数。
 * LLM 提炼以后再接（build 与 handler 已拆开）。
 *
 * 约定：
 * - digest 是**缓存**不是真相源：条目文件才是；stale（updated_at 落后于槽位最新条目）时读操作自动重建；
 * - memory_assemble 命中槽位时优先用 digest（见 tools/assemble.ts），缺失/过期回退碎片；
 * - 常驻注入给有 digest 的槽位排序加权（见 host/injection.ts）；
 * - digests/ 不在 MEMORY_DIRS 里，rebuildIndex 不会把它当条目扫描。
 */
import { createHash } from 'node:crypto'
import type { MemoryBackend } from '../store/backend.js'
import type { IndexEntry } from '../types.js'
import { memoryFileBody, parseMemoryFile } from '../store/index-store.js'

/** digest 存储目录（相对 backend.root）。 */
export const DIGESTS_DIR = 'digests'

/** 认知主体的字符上限（目标 200~400 token ≈ 320~640 字符，口径同 CHARS_PER_TOKEN=1.6）。 */
const BODY_MAIN_LIMIT = 400
/** 冲突说法单行的字符上限。 */
const VARIANT_LINE_LIMIT = 80
/** 最多列多少个冲突说法。 */
const MAX_VARIANT_LINES = 3
/** 槽位清单展示上限（重建「全部」不受此限）。 */
const LIST_LIMIT = 50

export interface DigestRecord {
  slot: string
  path: string
  updated_at: string
  status: 'active' | 'conflict'
  /** 参与提炼的条目 id（当前 active/conflict 版本）。 */
  sources: string[]
  /** 正文（当前认知，不含 front-matter 与标题行）。 */
  text: string
}

export interface DigestInput {
  /** 槽位键；留空 = 列出槽位清单（refresh=true 时顺带全量重建）。 */
  key?: string
  /** 强制重建：key 给了只重建该槽位，没给重建全部槽位。 */
  refresh?: boolean
}

export interface DigestOutput {
  /** 按 key 查询时给出。 */
  slot?: string
  path?: string
  text?: string
  updated_at?: string
  status?: 'active' | 'conflict'
  /** 本次是否真的重建（false = 命中未过期的缓存）。 */
  rebuilt?: boolean
  /** 未给 key 时的槽位清单。 */
  slots?: SlotDigestStatus[]
}

export interface SlotDigestStatus {
  slot: string
  path: string
  /** '' = 还没有 digest 文件。 */
  updated_at: string
  /** digest 落后于槽位最新条目（下次读取会自动重建）。 */
  stale: boolean
  /** 槽位下 active/conflict 条目数（不含 raw 与历史版本）。 */
  entries: number
  /** 槽位里有未裁决冲突。 */
  conflict: boolean
  /** 被取代的历史版本数。 */
  history: number
  /** withText=true 时带上正文（面板直接展示）。 */
  text?: string
}

/* ------------------------------- 槽位工具 ------------------------------- */

/** 与 write.ts 的 normalizeText 保持一致：去空白/标点/符号、小写。 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 条目的槽位键：显式 key 优先，否则回落 `title:<归一化标题>`（write.ts 同款规则）。 */
export function slotOfEntry(entry: Pick<IndexEntry, 'key' | 'title'>): string {
  if (entry.key !== undefined && entry.key !== '') return entry.key
  return `title:${normalizeText(entry.title)}`
}

/** 槽位键归一化（与 write.ts 的 normalizeKey 同口径）。 */
function normalizeSlot(raw: string): string {
  return raw.trim().toLowerCase()
}

/** 槽位 → digest 文件相对路径。encodeURIComponent 挡掉 `/` 与 `..`，超长加哈希防文件名超限。 */
export function digestPathFor(slot: string): string {
  let name = encodeURIComponent(slot)
    .replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  if (name.length > 120) name = `${name.slice(0, 60)}-${sha1(slot).slice(0, 12)}`
  return `${DIGESTS_DIR}/${name}.md`
}

/** 参与当前认知的条目：非 raw 且 active/conflict（superseded 是历史，只计数）。 */
function isDigestCandidate(entry: IndexEntry): boolean {
  return entry.type !== 'raw' && (entry.status === 'active' || entry.status === 'conflict')
}

/** 槽位分组：current 按时间倒序（[0] 最新），history 是 superseded 计数。 */
export function slotEntriesOf(
  entries: readonly IndexEntry[],
  slot: string,
): { current: IndexEntry[]; history: number } {
  const current: IndexEntry[] = []
  let history = 0
  for (const entry of entries) {
    if (entry.type === 'raw') continue
    if (slotOfEntry(entry) !== slot) continue
    if (entry.status === 'superseded') {
      history += 1
      continue
    }
    if (isDigestCandidate(entry)) current.push(entry)
  }
  current.sort((a, b) => b.time.localeCompare(a.time) || a.id.localeCompare(b.id))
  return { current, history }
}

/* ------------------------------- 提炼与读写 ------------------------------- */

/**
 * 规则版提炼：最新条目的摘要是「当前认知」主体；同槽有 conflict 就标注未裁决并列出别的说法；
 * 被取代的版本只报数量（历史在检索里仍可顺 supersedes 链追溯）。
 */
export function buildDigestText(
  current: readonly IndexEntry[],
  history: number,
): { text: string; status: 'active' | 'conflict'; sources: string[] } {
  const newest = current[0]
  const main = clip(oneLine(newest.summary), BODY_MAIN_LIMIT)
  const lines = [main === '' ? '（这条槽位的最新条目没有摘要）' : main]

  const conflictEntries = current.filter((entry) => entry.status === 'conflict')
  const variants: Array<{ value: string; time: string; who: string }> = []
  for (const entry of conflictEntries) {
    for (const variant of entry.variants ?? []) {
      if (oneLine(variant.value) === oneLine(newest.summary)) continue
      variants.push({
        value: variant.value,
        time: variant.time,
        who: variant.source?.session_id ?? '',
      })
    }
  }
  const status: 'active' | 'conflict' = conflictEntries.length > 0 ? 'conflict' : 'active'
  if (variants.length > 0) {
    lines.push(
      `⚠ 未裁决冲突：同槽位还有别的说法待 memory_resolve 裁决（共 ${variants.length} 条，下列最多 ${MAX_VARIANT_LINES} 条）`,
    )
    const seen = new Set<string>()
    for (const variant of variants) {
      const value = clip(oneLine(variant.value), VARIANT_LINE_LIMIT)
      if (value === '' || seen.has(value)) continue
      seen.add(value)
      if (seen.size > MAX_VARIANT_LINES) break
      lines.push(`· ${value}（${variant.time.slice(0, 10)}${variant.who === '' ? '' : `，${variant.who}`}）`)
    }
  }
  if (history > 0) {
    lines.push(`另有 ${history} 个历史版本留档（superseded，可顺 supersedes 链追溯）。`)
  }
  return {
    text: lines.join('\n'),
    status,
    sources: current.map((entry) => entry.id),
  }
}

/** 覆盖写一个 digest 文件（原子写）。 */
export async function writeDigest(
  backend: MemoryBackend,
  slot: string,
  current: readonly IndexEntry[],
  history: number,
  now: string,
): Promise<DigestRecord> {
  const { text, status, sources } = buildDigestText(current, history)
  const path = digestPathFor(slot)
  const file = [
    '---',
    `type: digest`,
    `slot: ${oneLine(slot)}`,
    `updated_at: ${now}`,
    `status: ${status}`,
    `sources: ${sources.join(', ')}`,
    '---',
    '',
    `# 当前认知 · ${oneLine(slot)}`,
    '',
    text,
    '',
  ].join('\n')
  await backend.writeFileAtomic(path, file)
  return { slot, path, updated_at: now, status, sources, text }
}

/** 读回 digest 文件；缺失/损坏返回 null（损坏的下次读取会被重建覆盖）。 */
export async function loadDigest(
  backend: MemoryBackend,
  slot: string,
): Promise<DigestRecord | null> {
  const path = digestPathFor(slot)
  let raw: string | null
  try {
    raw = await backend.readFile(path)
  } catch {
    return null
  }
  if (raw === null || raw.trim() === '') return null
  const { fields, body } = parseMemoryFile(raw)
  const text = memoryFileBody(raw)
  if (text.trim() === '') return null
  return {
    slot: fields.slot ?? slot,
    path,
    updated_at: fields.updated_at ?? '',
    status: fields.status === 'conflict' ? 'conflict' : 'active',
    sources: fields.sources === undefined
      ? []
      : fields.sources.split(',').map((id) => id.trim()).filter((id) => id !== ''),
    text,
  }
}

/** digest 是否过期：落后于槽位最新条目，或没覆盖最新条目。 */
export function isDigestStale(record: DigestRecord, current: readonly IndexEntry[]): boolean {
  const newest = current[0]
  if (newest === undefined) return false
  return record.updated_at < newest.time || !record.sources.includes(newest.id)
}

/** 重建一个槽位的 digest（调用方保证 current 非空）。 */
export async function rebuildDigest(
  backend: MemoryBackend,
  slot: string,
  entries: readonly IndexEntry[],
  now: string,
): Promise<DigestRecord> {
  const { current, history } = slotEntriesOf(entries, slot)
  return writeDigest(backend, slot, current, history, now)
}

/**
 * 槽位清单（面板 + 工具 list 用）：按最新条目时间倒序，上限 LIST_LIMIT。
 * withText=true 时逐个读 digest 正文（一次 readFile，几十个槽位无压力）。
 */
export async function listSlots(
  backend: MemoryBackend,
  entries: readonly IndexEntry[],
  withText = false,
): Promise<SlotDigestStatus[]> {
  const bySlot = new Map<string, IndexEntry[]>()
  const historyBySlot = new Map<string, number>()
  for (const entry of entries) {
    if (entry.type === 'raw') continue
    const slot = slotOfEntry(entry)
    if (entry.status === 'superseded') {
      historyBySlot.set(slot, (historyBySlot.get(slot) ?? 0) + 1)
      continue
    }
    if (!isDigestCandidate(entry)) continue
    const bucket = bySlot.get(slot) ?? []
    bucket.push(entry)
    bySlot.set(slot, bucket)
  }
  const out: SlotDigestStatus[] = []
  for (const [slot, bucket] of bySlot) {
    bucket.sort((a, b) => b.time.localeCompare(a.time) || a.id.localeCompare(b.id))
    const path = digestPathFor(slot)
    const record = await loadDigest(backend, slot)
    const updated = record?.updated_at ?? ''
    out.push({
      slot,
      path,
      updated_at: updated,
      stale: record === null || isDigestStale(record, bucket),
      entries: bucket.length,
      conflict: bucket.some((entry) => entry.status === 'conflict'),
      history: historyBySlot.get(slot) ?? 0,
      ...(withText && record !== null ? { text: record.text } : {}),
    })
  }
  out.sort((a, b) => newestTimeOf(entries, b.slot).localeCompare(newestTimeOf(entries, a.slot)))
  return out.slice(0, LIST_LIMIT)
}

function newestTimeOf(entries: readonly IndexEntry[], slot: string): string {
  let newest = ''
  for (const entry of entries) {
    if (entry.type === 'raw' || entry.status === 'superseded') continue
    if (slotOfEntry(entry) !== slot) continue
    if (entry.time > newest) newest = entry.time
  }
  return newest
}

/* --------------------------------- 工具入口 --------------------------------- */

/**
 * memory_digest：
 * - `{ key }`：返回该槽位的当前认知（缺失/过期自动重建；`refresh: true` 强制重建）；
 * - `{}`：返回槽位清单；`{ refresh: true }` 全量重建后返回清单。
 */
export async function digestHandler(
  backend: MemoryBackend,
  input: DigestInput,
): Promise<DigestOutput> {
  await backend.init()
  const entries = await backend.readIndex()
  const key = typeof input.key === 'string' ? normalizeSlot(input.key) : ''
  const refresh = input.refresh === true

  if (key !== '') {
    const { current, history } = slotEntriesOf(entries, key)
    if (current.length === 0) {
      throw new Error(`没有这个槽位：${key}（先用 write_memory({ key: "${key}", ... }) 写入）`)
    }
    let record = await loadDigest(backend, key)
    let rebuilt = false
    if (record === null || refresh || isDigestStale(record, current)) {
      record = await writeDigest(backend, key, current, history, backend.now())
      rebuilt = true
    }
    return {
      slot: record.slot,
      path: record.path,
      text: record.text,
      updated_at: record.updated_at,
      status: record.status,
      rebuilt,
    }
  }

  if (refresh) {
    const slots = await listSlots(backend, entries, false)
    const now = backend.now()
    for (const item of slots) {
      await rebuildDigest(backend, item.slot, entries, now)
    }
  }
  return { slots: await listSlots(backend, entries, true) }
}

/* --------------------------------- 小工具 --------------------------------- */

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 1) return ''
  return `${text.slice(0, max - 1).trimEnd()}…`
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}
