/**
 * write_memory：写入一条记忆（摘要 + 可选原文 + 来源 + 时间 + 标签 + 实体）。
 *
 * 四条不可妥协的行为：
 * 1. 查重：完全重复 / 高度近似（Jaccard ≥ 0.9）都直接返回既有条目，不再产第二份文件。
 * 2. 冲突不覆盖：同槽位不同内容 → 双方都标 conflict，旧值/新值都留在 variants 里。
 * 3. 确认闸门：requireConfirmation=true 时先写 suggested，不进入检索，需 memory_confirm。
 * 4. 并发安全：整段「读索引 → 改 → 写回」在索引锁里做，两个并发写不会互相吃掉对方。
 */
import { createHash, randomBytes } from 'node:crypto'
import type { MemoryBackend } from '../store/backend.js'
import type {
  ConflictVariant,
  EntryStatus,
  IndexEntry,
  MemorySource,
  SourceKind,
} from '../types.js'
import { INDEX_SCHEMA_VERSION, renderMemoryFile } from '../store/index-store.js'
import { mutateIndex, patchEntryFile } from '../store/file-backend.js'
import { redactSecrets } from '../store/redact.js'
import { normalizeAnchors } from '../store/anchors.js'
import { tokenize } from '../retrieve/keyword.js'

export interface WriteInput {
  summary: string
  raw?: string
  tags?: string[]
  entities?: string[]
  title?: string
  /** 来源；字符串等价于 { session_id, kind }。 */
  source?: MemorySource | SourceKind
  /** 追加来源（多来源场景）。 */
  sources?: MemorySource[]
  session_id?: string
  confidence?: number
  /** 覆盖插件级 config.requireConfirmation。 */
  requireConfirmation?: boolean
  /**
   * 稳定槽位键（版本演进）：同 key 的旧版本会被转成 superseded，不再与新版并存。
   * 不给则用归一化标题充当槽位。
   */
  key?: string
  /**
   * 显式声明「这两条我判不清谁对」：保留 conflict 语义等裁决，不走自动演进。
   * 默认 false——改主意是常态，应该产生新版本而不是制造冲突。
   */
  expectConflict?: boolean
  /** 写入前是否脱敏（内部字段，由插件配置注入，不暴露给模型）。 */
  redactSecrets?: boolean
  /** 强制落库目录：episode（episodes/）或 topic（topics/）。 */
  type?: 'episode' | 'topic'
  /**
   * 记忆锚点（原始输入，形状不归本层管）：handler 里过 normalizeAnchors 白名单，
   * 只留 kind 受控、value 非空的条目，全部非法视为没给。
   */
  anchors?: unknown
}

export interface WriteOutput {
  path: string
  id: string
  status: EntryStatus
  /** 命中了哪条既有记忆（完全重复 / 近似重复）时给出。 */
  dedupe?: 'exact' | 'near'
  similarity?: number
  /** 落盘前被脱敏的凭证类别（有值就说明动过手）。 */
  redactions?: string[]
  /** 本次取代了哪些旧版本（它们已转 superseded，退出检索）。 */
  supersedes?: string[]
}

const RAW_SUMMARY_LIMIT = 200
/** 近似重复阈值：低于它才算「新记忆」。 */
const NEAR_DUPLICATE_RATIO = 0.9

export async function writeHandler(
  backend: MemoryBackend,
  input: WriteInput,
): Promise<WriteOutput> {
  await backend.init()
  // 落盘前脱敏：记忆是明文 markdown，写进去就跟着备份/云盘到处走
  const shouldRedact = input.redactSecrets !== false
  const summaryRedaction = shouldRedact
    ? redactSecrets(typeof input.summary === 'string' ? input.summary : '')
    : { text: typeof input.summary === 'string' ? input.summary : '', kinds: [] }
  const summary = summaryRedaction.text.trim()
  if (summary === '') throw new Error('write_memory: `summary` must be a non-empty string')

  const rawInput = typeof input.raw === 'string' && input.raw.trim() !== '' ? input.raw : undefined
  const rawRedaction = rawInput !== undefined && shouldRedact
    ? redactSecrets(rawInput)
    : { text: rawInput ?? '', kinds: [] }
  const rawText = rawInput === undefined ? undefined : rawRedaction.text
  const redactions = [...new Set([...summaryRedaction.kinds, ...rawRedaction.kinds])]
  const type: 'episode' | 'topic' = input.type ?? (rawText === undefined ? 'topic' : 'episode')
  if (type === 'episode' && rawText === undefined) {
    throw new Error('write_memory: episode entries require `raw`')
  }

  const sources = normalizeSources(input)
  if (type === 'episode' && input.session_id === undefined && sources.length === 0) {
    throw new Error('write_memory: raw 原文必须带 session_id（episodes/ 与 raw/ 需要来源标记）')
  }

  const title = (typeof input.title === 'string' && input.title.trim() !== '')
    ? input.title.trim()
    : deriveTitle(summary)
  const tags = normalizeList(input.tags)
  const entities = normalizeList(input.entities)
  const confidence = normalizeConfidence(input.confidence)
  // 锚点归一化：kind 白名单、value 非空、截断去重封顶；全非法返回 undefined（视为没给）
  const anchors = normalizeAnchors(input.anchors)
  const now = backend.now()

  const fingerprint = sha1(`${type}|${normalizeText(summary)}`)
  const conflictKey = sha1(`${type}|${normalizeText(title)}`)
  const summaryTokens = tokenSet(summary)
  // 槽位键：显式给就小写原样用；不给则回落到标题（老数据只有 conflict_key，故双条件兼容）
  const explicitKey = normalizeKey(input.key)
  const slotKey = explicitKey ?? `title:${normalizeText(title)}`
  const sameSlot = (entry: IndexEntry): boolean => (explicitKey !== undefined
    ? entry.key === explicitKey
    : entry.key === slotKey || entry.conflict_key === conflictKey)

  return mutateIndex(backend, async (entries) => {
    const exact = entries.find(
      (entry) => entry.fingerprint === fingerprint
        && entry.status !== 'deleted_pending'
        && entry.status !== 'superseded',
    )
    if (exact !== undefined) {
      await backend.appendLedger({
        at: now,
        type: 'memory/duplicate',
        id: exact.id,
        path: exact.path,
        status: exact.status,
        fingerprint,
      })
      return { path: exact.path, id: exact.id, status: exact.status, dedupe: 'exact' as const }
    }

    // 近似重复：同一主题（同 conflict_key）下措辞改了半个词、加了个标点，
    // 不该变成第二条记忆；不同标题则是不同记忆，不做合并。
    let nearHit: { entry: IndexEntry; similarity: number } | undefined
    for (const candidate of entries) {
      if (candidate.status === 'deleted_pending' || candidate.status === 'superseded') continue
      if (candidate.type === 'raw') continue
      if (candidate.type !== type) continue
      if (candidate.conflict_key !== conflictKey) continue
      const similarity = jaccard(summaryTokens, tokenSet(candidate.summary))
      if (similarity >= NEAR_DUPLICATE_RATIO && (nearHit === undefined || similarity > nearHit.similarity)) {
        nearHit = { entry: candidate, similarity }
      }
    }
    if (nearHit !== undefined) {
      await backend.appendLedger({
        at: now,
        type: 'memory/near-duplicate',
        id: nearHit.entry.id,
        path: nearHit.entry.path,
        similarity: round(nearHit.similarity),
      })
      return {
        path: nearHit.entry.path,
        id: nearHit.entry.id,
        status: nearHit.entry.status,
        dedupe: 'near' as const,
        similarity: round(nearHit.similarity),
      }
    }

    // 同槽位 = 同一件事实的两次说法。默认走「版本演进」：旧的转 superseded，新的 active；
    // 只有调用方显式声明「这两条我判不了谁对」（expectConflict）时才留 conflict 等裁决。
    const slotMatches = entries.filter(
      (entry) => entry.type !== 'raw'
        && entry.fingerprint !== fingerprint
        && entry.status !== 'deleted_pending'
        && sameSlot(entry),
    )
    const evolving = slotMatches.filter((entry) => entry.status !== 'superseded')
    const conflicts = input.expectConflict === true ? evolving : []
    const superseded = input.expectConflict === true ? [] : evolving
    const requireConfirmation = input.requireConfirmation === true
    const status: EntryStatus = conflicts.length > 0
      ? 'conflict'
      : requireConfirmation
        ? 'suggested'
        : 'active'

    const id = newId(new Set(entries.map((entry) => entry.id)))
    const rawRef = rawText === undefined ? undefined : `raw/${id}.md`
    const path = type === 'episode'
      ? `episodes/${now.slice(0, 10)}-${id}.md`
      : `topics/${slugify(title)}-${id}.md`

    const variants: ConflictVariant[] = conflicts.map((entry) => ({
      value: entry.summary,
      time: entry.time,
      source: entry.sources[0] ?? { session_id: entry.session_id, kind: 'session' },
    }))

    const entry: IndexEntry = {
      id,
      path,
      type,
      title,
      summary,
      tags,
      entities,
      time: now,
      sources,
      session_id: sources[0]?.session_id ?? '',
      confidence,
      raw_ref: rawRef,
      status,
      fingerprint,
      conflict_key: conflictKey,
      key: slotKey,
      schema_version: INDEX_SCHEMA_VERSION,
      ...(anchors !== undefined ? { anchors } : {}),
      ...(variants.length > 0 ? { variants } : {}),
      ...(superseded.length > 0 ? { supersedes: superseded.map((item) => item.id) } : {}),
    }

    const body = rawRef === undefined || rawText === undefined
      ? undefined
      : `## 原文指针\n\n${rawRef}（${rawText.length} 字，仅可通过 raw_ref 显式下钻）`
    await backend.writeFileAtomic(entry.path, renderMemoryFile(entry, body))

    if (rawRef !== undefined && rawText !== undefined) {
      const rawEntry: IndexEntry = {
        id: `${id}-raw`,
        path: rawRef,
        type: 'raw',
        title: `${title}（原文）`,
        summary: clip(rawText.replace(/\s+/g, ' ').trim(), RAW_SUMMARY_LIMIT),
        tags,
        entities,
        time: now,
        sources,
        session_id: entry.session_id,
        confidence,
        status,
        fingerprint: `${fingerprint}:raw`,
        conflict_key: conflictKey,
        schema_version: INDEX_SCHEMA_VERSION,
      }
      // 原文文件的摘要就等于原文，不再重复写一遍
      await backend.writeFileAtomic(rawRef, renderMemoryFile(rawEntry, rawText, { skipSummary: true }))
      entries.push(rawEntry)
    }
    entries.push(entry)

    // 版本演进：旧版本转 superseded（退出检索但留档），并把指针写在两个方向上，
    // 这样「这条事实是怎么变的」可以直接顺着指针走，而不是靠摘要猜。
    for (const old of superseded) {
      const target = entries.find((item) => item.id === old.id)
      if (target === undefined) continue
      target.status = 'superseded'
      target.superseded_by = id
      // 状态要落进文件，否则 rebuildIndex 会把 superseded 洗回 active
      await patchEntryFile(backend, target.path, { status: 'superseded', superseded_by: id })
      // 旧版本的原文兄弟条目也要跟着退场，否则原文还能被检索到
      if (target.raw_ref !== undefined) {
        const rawSibling = entries.find((item) => item.path === target.raw_ref)
        if (rawSibling !== undefined) {
          rawSibling.status = 'superseded'
          rawSibling.superseded_by = id
          await patchEntryFile(backend, rawSibling.path, { status: 'superseded', superseded_by: id })
        }
      }
    }

    // 冲突不覆盖：把新值作为一条 variant 追加到旧条目，旧值原样保留。
    for (const old of conflicts) {
      const target = entries.find((item) => item.id === old.id)
      if (target === undefined) continue
      target.status = 'conflict'
      target.variants = [
        ...(target.variants ?? []),
        { value: summary, time: now, source: sources[0] ?? { session_id: entry.session_id, kind: 'session' } },
      ]
      // 状态要落进文件，否则 rebuildIndex 会把 conflict 洗回 active
      await patchEntryFile(backend, target.path, { status: 'conflict' })
    }

    await backend.appendLedger({
      at: now,
      type: conflicts.length > 0
        ? 'memory/conflict'
        : superseded.length > 0 ? 'memory/supersede' : 'memory/write',
      id,
      path,
      status,
      key: slotKey,
      supersedes: superseded.map((item) => item.id),
      session_id: entry.session_id,
      sources,
      raw_ref: rawRef ?? null,
      redactions,
      anchor_count: anchors?.length ?? 0,
    })

    return {
      path: entry.path,
      id: entry.id,
      status: entry.status,
      ...(superseded.length > 0 ? { supersedes: superseded.map((item) => item.id) } : {}),
      ...(redactions.length > 0 ? { redactions } : {}),
    }
  })
}

/** 槽位键归一化：去空白、小写；空串视为未给。 */
function normalizeKey(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const key = raw.trim().toLowerCase()
  return key === '' ? undefined : key
}

/** 归一化来源：主来源（session_id + source.kind）+ 追加 sources，去重保序。 */
function normalizeSources(input: WriteInput): MemorySource[] {
  const out: MemorySource[] = []
  const push = (source: MemorySource): void => {
    if (source.session_id === '') return
    const exists = out.some(
      (item) => item.session_id === source.session_id && item.kind === source.kind,
    )
    if (!exists) out.push(source)
  }

  const kind: SourceKind = typeof input.source === 'string'
    ? input.source
    : (input.source?.kind ?? 'session')
  const primaryId = input.session_id
    ?? (typeof input.source === 'object' ? input.source?.session_id : undefined)
    ?? ''
  push({ session_id: primaryId, kind })

  if (Array.isArray(input.sources)) {
    for (const source of input.sources) {
      if (source === null || typeof source !== 'object') continue
      if (typeof source.session_id !== 'string') continue
      push({ session_id: source.session_id, kind: normalizeKind(source.kind) })
    }
  }
  return out
}

function normalizeKind(raw: unknown): SourceKind {
  return raw === 'plugin' || raw === 'user' ? raw : 'session'
}

function normalizeList(raw: readonly string[] | undefined): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

function normalizeConfidence(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0.6
  return Math.min(1, Math.max(0, raw))
}

/** 用于查重/冲突键：去空白、去标点、小写。 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text).filter((token) => token.length >= 2))
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function deriveTitle(summary: string): string {
  const firstLine = summary.split('\n')[0] ?? summary
  return clip(firstLine.trim(), 40)
}

function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const cjk = title.replace(/[^\u4e00-\u9fff]+/g, '').slice(0, 16)
  // 纯数字的 ascii 片段没有信息量，优先用中文
  const base = ascii.length >= 3 ? ascii : (cjk !== '' ? cjk : ascii)
  const cleaned = clip(base === '' ? 'mem' : base, 48).replace(/[^\w\u4e00-\u9fff-]+/g, '')
  return cleaned === '' ? 'mem' : cleaned
}

function newId(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `mem_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
    if (!taken.has(candidate)) return candidate
  }
  return `mem_${randomBytes(8).toString('hex')}`
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 1) return ''
  return `${text.slice(0, max - 1).trimEnd()}…`
}
