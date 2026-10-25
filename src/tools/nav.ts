/**
 * memory_nav：固定阅读预算的第一层——只看摘要层元数据。
 *
 * 两条硬约定：
 * 1. 默认绝不返回 raw 全文；只有把 path 显式指到一个具体文件时，才把该文件全文放进 readme。
 * 2. **默认分页**（limit=50）：库大了也不会一次把摘要层全糊进上下文，
 *    用 offset 翻页、用 has_more 判断还有没有。
 */
import type { MemoryBackend } from '../store/backend.js'
import type { EntryType, IndexEntry } from '../types.js'
import { README_FILE } from '../store/index-store.js'
import { loadIndex } from '../retrieve/index-cache.js'
import { buildFacets } from '../store/facets.js'
import type { LibraryFacets } from '../store/facets.js'

export interface NavInput {
  /** 目录前缀（如 "topics/"）或具体文件路径（如 "raw/mem_x.md"）。 */
  path?: string
  /** 一次返回多少条，默认 50，上限 500。 */
  limit?: number
  /** 跳过多少条（翻页）。 */
  offset?: number
  /** 排序：path（默认，稳定）或 recent（最近写入优先，想「看看最近记了什么」时用）。 */
  sort?: 'path' | 'recent'
}

/** 摘要层元数据：不含正文、不含 raw 内容。 */
export interface NavEntry {
  id: string
  path: string
  type: EntryType
  title: string
  summary: string
  time: string
}

export interface NavOutput {
  entries: NavEntry[]
  /** 命中范围内的总条数（不是本次返回的条数）。 */
  total: number
  offset: number
  limit: number
  has_more: boolean
  /** 库画像：标签分布、类型分布、最新/最旧时间（按当前 path 范围统计）。 */
  facets?: LibraryFacets
  /** 无 path 时是根 README；path 指向具体文件时是该文件全文。 */
  readme?: string
}

export const DEFAULT_NAV_LIMIT = 50
export const MAX_NAV_LIMIT = 500

export async function navHandler(backend: MemoryBackend, input: NavInput): Promise<NavOutput> {
  await backend.init()
  const entries = (await loadIndex(backend)).entries
  const wanted = normalizePath(input.path)
  const limit = clampLimit(input.limit)
  const offset = clampOffset(input.offset)
  const sort = input.sort === 'recent' ? 'recent' : 'path'

  if (wanted === '') {
    const readme = await backend.readFile(README_FILE)
    return paginate(entries, entries, limit, offset, sort, readme)
  }

  // 显式下钻到具体文件：这一条永远是「就给你这一条」，不分页
  const exact = entries.find((entry) => entry.path === wanted || entry.id === wanted)
  if (exact !== undefined) {
    const content = await backend.readFile(exact.path)
    const output: NavOutput = {
      entries: [toNavEntry(exact)],
      total: 1,
      offset: 0,
      limit,
      has_more: false,
      facets: buildFacets([exact]),
    }
    if (content !== null && content !== '') output.readme = content
    return output
  }

  const prefix = wanted.endsWith('/') ? wanted : `${wanted}/`
  const scoped = entries.filter((entry) => entry.path.startsWith(prefix))
  const dirIndex = await backend.readFile(`${prefix}_index.md`)
  return paginate(scoped, entries, limit, offset, sort, dirIndex)
}

function paginate(
  scoped: readonly IndexEntry[],
  all: readonly IndexEntry[],
  limit: number,
  offset: number,
  sort: 'path' | 'recent',
  readme: string | null,
): NavOutput {
  const sorted = toNavEntries(scoped, sort)
  const page = sorted.slice(offset, offset + limit)
  const output: NavOutput = {
    entries: page,
    total: sorted.length,
    offset,
    limit,
    has_more: offset + page.length < sorted.length,
    // 库画像按「整个库」统计，而不是当前分页——这样模型一眼知道库里有什么
    facets: buildFacets(all),
  }
  if (readme !== null && readme !== '') output.readme = readme
  return output
}

/** 只投摘要层字段；默认按 path 排序保证确定性，`recent` 按写入时间倒序。 */
export function toNavEntries(
  entries: readonly IndexEntry[],
  sort: 'path' | 'recent' = 'path',
): NavEntry[] {
  const sorted = [...entries].sort((a, b) => {
    if (sort === 'recent') {
      const byTime = b.time.localeCompare(a.time)
      if (byTime !== 0) return byTime
    }
    return a.path.localeCompare(b.path)
  })
  return sorted.map(toNavEntry)
}

function toNavEntry(entry: IndexEntry): NavEntry {
  return {
    id: entry.id,
    path: entry.path,
    type: entry.type,
    title: entry.title,
    summary: entry.summary,
    time: entry.time,
  }
}

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_NAV_LIMIT
  return Math.min(MAX_NAV_LIMIT, Math.max(1, Math.floor(raw)))
}

function clampOffset(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
  return Math.max(0, Math.floor(raw))
}

function normalizePath(raw: string | undefined): string {
  if (typeof raw !== 'string') return ''
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}
