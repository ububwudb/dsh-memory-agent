/**
 * 索引与记忆文件的读写。
 *
 * 关键约定：index.jsonl 只是索引，文件才是真相源。
 * rebuildIndex(root) 可以只靠 episodes/ raw/ topics/ 里的文件把索引重建出来。
 */
import { readFile, readdir, stat, writeFile, rename, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { IndexEntry, LedgerEvent, MemorySource, SourceKind } from '../types.js'
import { normalizeAnchors, parseAnchorsField, serializeAnchors } from './anchors.js'

export const INDEX_FILE = 'index.jsonl'
export const LEDGER_FILE = 'ledger.jsonl'
export const README_FILE = 'README.md'
export const DIR_INDEX_FILE = '_index.md'

/**
 * 索引 schema 版本。
 * - 1：初版（无 schema_version 字段）
 * - 2：加 schema_version；检索排除 superseded
 * 读到旧条目不会报错（normalizeEntry 补成 1），点「重建索引」即可整体升级。
 */
export const INDEX_SCHEMA_VERSION = 2

/** 记忆文件被扫描的目录（rebuildIndex 的输入）。 */
export const MEMORY_DIRS = ['episodes', 'raw', 'topics'] as const

/** 一行索引；坏行跳过，不整体崩溃。 */
export function parseIndexLines(text: string): { entries: IndexEntry[]; skipped: number } {
  const entries: IndexEntry[] = []
  let skipped = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        skipped += 1
        continue
      }
      const entry = normalizeEntry(parsed as Record<string, unknown>)
      if (entry === null) {
        skipped += 1
        continue
      }
      entries.push(entry)
    } catch {
      skipped += 1
    }
  }
  return { entries, skipped }
}

/** 把索引写成一行的 JSONL 文本。 */
export function serializeIndex(entries: readonly IndexEntry[]): string {
  if (entries.length === 0) return ''
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

/** 容忍历史数据的字段缺失/类型抖动。 */
export function normalizeEntry(raw: Record<string, unknown>): IndexEntry | null {
  const id = typeof raw.id === 'string' ? raw.id : ''
  const filePath = typeof raw.path === 'string' ? raw.path : ''
  if (id === '' || filePath === '') return null
  const sources = normalizeSources(raw.sources)
  const sessionId = typeof raw.session_id === 'string' && raw.session_id !== ''
    ? raw.session_id
    : sources[0]?.session_id ?? ''
  return {
    id,
    path: filePath,
    type: isEntryType(raw.type) ? raw.type : 'summary',
    title: typeof raw.title === 'string' ? raw.title : id,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    tags: stringArray(raw.tags),
    entities: stringArray(raw.entities),
    time: typeof raw.time === 'string' ? raw.time : new Date(0).toISOString(),
    sources,
    session_id: sessionId,
    confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? raw.confidence
      : 0.5,
    raw_ref: typeof raw.raw_ref === 'string' ? raw.raw_ref : undefined,
    vector_id: typeof raw.vector_id === 'string' ? raw.vector_id : undefined,
    status: isEntryStatus(raw.status) ? raw.status : 'active',
    fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : undefined,
    conflict_key: typeof raw.conflict_key === 'string' ? raw.conflict_key : undefined,
    variants: Array.isArray(raw.variants)
      ? (raw.variants as IndexEntry['variants'])
      : undefined,
    deleted_at: typeof raw.deleted_at === 'string' ? raw.deleted_at : undefined,
    deleted_by_session: typeof raw.deleted_by_session === 'string'
      ? raw.deleted_by_session
      : undefined,
    key: typeof raw.key === 'string' ? raw.key : undefined,
    // anchors 在 index.jsonl 里是对象数组（front-matter 里才是字符串），两种形状都容
    anchors: typeof raw.anchors === 'string'
      ? parseAnchorsField(raw.anchors)
      : normalizeAnchors(raw.anchors),
    supersedes: Array.isArray(raw.supersedes)
      ? raw.supersedes.filter((item): item is string => typeof item === 'string')
      : undefined,
    superseded_by: typeof raw.superseded_by === 'string' ? raw.superseded_by : undefined,
    hit_count: typeof raw.hit_count === 'number' ? raw.hit_count : undefined,
    last_used_at: typeof raw.last_used_at === 'string' ? raw.last_used_at : undefined,
    schema_version: typeof raw.schema_version === 'number' ? raw.schema_version : 2,
  }
}

function normalizeSources(raw: unknown): MemorySource[] {
  if (!Array.isArray(raw)) return []
  const out: MemorySource[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const sessionId = typeof record.session_id === 'string' ? record.session_id : ''
    if (sessionId === '') continue
    const kind: SourceKind = record.kind === 'plugin' || record.kind === 'user'
      ? record.kind
      : 'session'
    out.push({ session_id: sessionId, kind })
  }
  return out
}

function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string')
}

function isEntryType(value: unknown): value is IndexEntry['type'] {
  return value === 'summary' || value === 'episode' || value === 'raw' || value === 'topic'
}

function isEntryStatus(value: unknown): value is IndexEntry['status'] {
  return value === 'active'
    || value === 'suggested'
    || value === 'superseded'
    || value === 'conflict'
    || value === 'deleted_pending'
    || value === 'orphaned'
}

/**
 * 记忆文件正文：front-matter + 标题 + 摘要 + 可选正文。
 * `skipSummary` 用于 raw/ 原文文件：摘要就等于原文，再写一遍就是重复。
 */
export function renderMemoryFile(
  entry: IndexEntry,
  body?: string,
  options: { skipSummary?: boolean } = {},
): string {
  const lines: string[] = ['---']
  lines.push(`id: ${entry.id}`)
  lines.push(`type: ${entry.type}`)
  lines.push(`title: ${oneLine(entry.title)}`)
  lines.push(`time: ${entry.time}`)
  lines.push(`status: ${entry.status}`)
  lines.push(`session_id: ${entry.session_id}`)
  lines.push(`confidence: ${entry.confidence}`)
  if (entry.tags.length > 0) lines.push(`tags: ${entry.tags.join(', ')}`)
  if (entry.entities.length > 0) lines.push(`entities: ${entry.entities.join(', ')}`)
  if (entry.sources.length > 0) {
    lines.push(`sources: ${entry.sources.map((s) => `${s.session_id}:${s.kind}`).join(', ')}`)
  }
  if (entry.raw_ref !== undefined) lines.push(`raw_ref: ${entry.raw_ref}`)
  if (entry.conflict_key !== undefined) lines.push(`conflict_key: ${entry.conflict_key}`)
  // 槽位键与取代指针必须落盘：这三个字段决定 rebuild 之后「版本演进」链还在不在
  if (entry.key !== undefined) lines.push(`key: ${entry.key}`)
  if (entry.superseded_by !== undefined) lines.push(`superseded_by: ${entry.superseded_by}`)
  if (entry.supersedes !== undefined && entry.supersedes.length > 0) {
    lines.push(`supersedes: ${entry.supersedes.join(', ')}`)
  }
  // anchors 是单行 JSON，值里天然含逗号/冒号——parseMemoryFile 只按**第一个**冒号切 key，
  // 冒号之后的整段 JSON 都算 value，也不像 sources 那样按逗号切分，所以这些字符不会被截断。
  if (entry.anchors !== undefined && entry.anchors.length > 0) {
    lines.push(`anchors: ${serializeAnchors(entry.anchors)}`)
  }
  lines.push('---', '', `# ${oneLine(entry.title)}`)
  if (options.skipSummary !== true) lines.push('', entry.summary.trim())
  const tail = body === undefined ? '' : body.trimEnd()
  if (tail.length > 0) lines.push('', tail)
  return lines.join('\n') + '\n'
}

/** 解析记忆文件：拿回 front-matter 字段和正文。 */
export function parseMemoryFile(text: string): {
  fields: Record<string, string>
  body: string
} {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { fields: {}, body: normalized }
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return { fields: {}, body: normalized }
  const head = normalized.slice(4, end)
  const bodyStart = normalized.indexOf('\n', end + 1)
  const body = bodyStart < 0 ? '' : normalized.slice(bodyStart + 1)
  const fields: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    if (key !== '') fields[key] = value
  }
  return { fields, body }
}

/**
 * 只改 front-matter 的若干字段，正文原样保留。
 *
 * 状态变更（active→suggested/conflict/deleted_pending/orphaned）必须同时落到文件里，
 * 否则 rebuildIndex 会把状态改回去——文件是真相源，这条不能只在索引里改。
 */
export function patchFrontMatter(
  text: string,
  changes: Record<string, string | undefined>,
): string {
  const normalized = text.replace(/\r\n/g, '\n')
  const keys = Object.keys(changes)
  if (!normalized.startsWith('---\n')) {
    const head = keys
      .filter((key) => changes[key] !== undefined)
      .map((key) => `${key}: ${changes[key]}`)
    return ['---', ...head, '---', '', normalized].join('\n')
  }
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return normalized
  const headLines = normalized.slice(4, end).split('\n')
  const pending = new Map(keys.map((key) => [key, changes[key]]))
  const patched = headLines.map((line) => {
    const sep = line.indexOf(':')
    if (sep <= 0) return line
    const key = line.slice(0, sep).trim()
    if (!pending.has(key)) return line
    const value = pending.get(key)
    pending.delete(key)
    return value === undefined ? line : `${key}: ${value}`
  }).filter((line) => line.trim() !== '' || headLines.length === 1)
  for (const [key, value] of pending) {
    if (value !== undefined) patched.push(`${key}: ${value}`)
  }
  const body = normalized.slice(end + 4)
  return ['---', ...patched, '---', body].join('\n')
}

/**
 * 取记忆文件的「正文」：去掉 front-matter 和首行 `# 标题`。
 * assemble 拼原文片段时用它，避免把 YAML 头当成原文塞进上下文。
 */
export function memoryFileBody(text: string): string {
  const { body } = parseMemoryFile(text)
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  if (lines.length > 0 && lines[0].startsWith('# ')) {
    lines.shift()
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  }
  return lines.join('\n').trimEnd()
}

/** 目录页：父目录 _index.md 的内容（写入时同步刷新）。 */
export function renderDirIndex(dir: string, entries: readonly IndexEntry[]): string {
  const rows = entries
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => `| ${entry.id} | ${entry.status} | ${oneLine(entry.title)} | ${oneLine(entry.summary)} | ${entry.time} |`)
  const lines = [
    `# ${dir}/ 索引`,
    '',
    `条目数：${entries.length}（由 dsh-memory-agent 自动维护，勿手改）`,
    '',
    '| id | status | title | summary | time |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ]
  return lines.join('\n')
}

/** 根 README 骨架。 */
export function renderRootReadme(): string {
  return [
    '# Memory 存储',
    '',
    '由 `dsh-memory-agent` 维护的文件式长上下文记忆。',
    '',
    '- `index.jsonl`：索引，一行一条；坏了可以 `rebuildIndex()` 从文件重建。',
    '- `ledger.jsonl`：只追加的审计事件。',
    '- `episodes/`：会话情节（带 session_id 来源标记）。',
    '- `raw/`：原文，只能通过 `raw_ref` 显式下钻。',
    '- `topics/`：共享/主题记忆，可多来源。',
    '',
    '文件是真相源，索引只是缓存。',
    '',
  ].join('\n')
}

/**
 * 从文件重建索引（不依赖 index.jsonl）。
 * 只读 `<root>/{episodes,raw,topics}/*.md`，写完索引后顺手刷新父目录 _index.md。
 */
export async function rebuildIndex(root: string): Promise<{
  entries: IndexEntry[]
  scanned: number
  skipped: number
}> {
  const entries: IndexEntry[] = []
  let scanned = 0
  let skipped = 0
  for (const dir of MEMORY_DIRS) {
    const abs = path.join(root, dir)
    let names: string[]
    try {
      names = await readdir(abs)
    } catch {
      continue
    }
    for (const fileName of names.sort()) {
      if (!fileName.endsWith('.md') || fileName === DIR_INDEX_FILE) continue
      scanned += 1
      const relPath = `${dir}/${fileName}`
      let text: string
      try {
        text = await readFile(path.join(root, relPath), 'utf8')
      } catch {
        skipped += 1
        continue
      }
      const entry = entryFromFile(relPath, dir, text, await mtimeOf(path.join(root, relPath)))
      if (entry === null) {
        skipped += 1
        continue
      }
      entries.push(entry)
    }
  }
  await atomicWriteAbsolute(path.join(root, INDEX_FILE), serializeIndex(entries))
  await syncDirIndexes(root, entries)
  return { entries, scanned, skipped }
}

/** 单文件 → 索引条目（缺 front-matter 时退化为文件名/首标题）。 */
export function entryFromFile(
  relPath: string,
  dir: string,
  text: string,
  fallbackTime: string,
): IndexEntry | null {
  const { fields, body } = parseMemoryFile(text)
  const fileName = path.posix.basename(relPath)
  const id = fields.id ?? fileName.replace(/\.md$/, '')
  const title = fields.title ?? firstHeading(body) ?? id
  const summary = fields.summary ?? firstParagraph(body)
  const type = isEntryType(fields.type) ? fields.type : typeFromDir(dir)
  const sources = parseSourcesField(fields.sources)
  const sessionId = fields.session_id ?? sources[0]?.session_id ?? ''
  const confidence = fields.confidence === undefined ? 0.5 : Number(fields.confidence)
  return {
    id,
    path: relPath,
    type,
    title,
    summary,
    tags: splitList(fields.tags),
    entities: splitList(fields.entities),
    time: fields.time ?? fallbackTime,
    sources,
    session_id: sessionId,
    confidence: Number.isFinite(confidence) ? confidence : 0.5,
    raw_ref: fields.raw_ref,
    status: isEntryStatus(fields.status) ? fields.status : 'active',
    fingerprint: fields.fingerprint,
    conflict_key: fields.conflict_key,
    // anchors 随 front-matter 单行 JSON 往返；缺字段/坏 JSON/形状不对都解析成 undefined
    anchors: parseAnchorsField(fields.anchors),
    // 重建出来的条目一律是当前版本
    schema_version: INDEX_SCHEMA_VERSION,
  }
}

function typeFromDir(dir: string): IndexEntry['type'] {
  if (dir === 'episodes') return 'episode'
  if (dir === 'raw') return 'raw'
  if (dir === 'topics') return 'topic'
  return 'summary'
}

function parseSourcesField(raw: string | undefined): MemorySource[] {
  if (raw === undefined || raw.trim() === '') return []
  const out: MemorySource[] = []
  for (const part of raw.split(',')) {
    const item = part.trim()
    if (item === '') continue
    const sep = item.lastIndexOf(':')
    const sessionId = sep < 0 ? item : item.slice(0, sep).trim()
    const kindRaw = sep < 0 ? 'session' : item.slice(sep + 1).trim()
    if (sessionId === '') continue
    const kind: SourceKind = kindRaw === 'plugin' || kindRaw === 'user' ? kindRaw : 'session'
    out.push({ session_id: sessionId, kind })
  }
  return out
}

function splitList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return []
  return raw.split(',').map((item) => item.trim()).filter((item) => item !== '')
}

function firstHeading(body: string): string | null {
  for (const line of body.split('\n')) {
    if (line.startsWith('# ')) return line.slice(2).trim()
  }
  return null
}

function firstParagraph(body: string): string {
  const lines = body.split('\n').map((line) => line.trim())
  const buffer: string[] = []
  for (const line of lines) {
    if (line === '') {
      if (buffer.length > 0) break
      continue
    }
    if (line.startsWith('#')) continue
    buffer.push(line)
  }
  return buffer.join(' ')
}

/** 刷新 root 与各子目录的 _index.md。 */
export async function syncDirIndexes(root: string, entries: readonly IndexEntry[]): Promise<void> {
  const byDir = new Map<string, IndexEntry[]>()
  for (const entry of entries) {
    const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    const bucket = byDir.get(dir) ?? []
    bucket.push(entry)
    byDir.set(dir, bucket)
  }
  const targets = new Set<string>(['', ...MEMORY_DIRS])
  for (const dir of byDir.keys()) targets.add(dir)
  for (const dir of targets) {
    const bucket = byDir.get(dir) ?? []
    const rel = dir === '' ? DIR_INDEX_FILE : `${dir}/${DIR_INDEX_FILE}`
    await atomicWriteAbsolute(path.join(root, rel), renderDirIndex(dir === '' ? 'memory' : dir, bucket))
  }
}

/** 绝对路径的原子写：临时文件 + rename，Windows 上覆盖前先 unlink。 */
export async function atomicWriteAbsolute(absPath: string, text: string): Promise<void> {
  await mkdir(path.dirname(absPath), { recursive: true })
  const tmp = `${absPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, text, 'utf8')
  try {
    await rename(tmp, absPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') {
      await rm(tmp, { force: true })
      throw error
    }
    await rm(absPath, { force: true })
    await rename(tmp, absPath)
  }
}

async function mtimeOf(absPath: string): Promise<string> {
  try {
    const info = await stat(absPath)
    return info.mtime.toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 审计事件一行文本。 */
export function renderLedgerLine(event: LedgerEvent): string {
  return JSON.stringify(event) + '\n'
}
