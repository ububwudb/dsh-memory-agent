/**
 * memory_search_hybrid：先按 tags/time_range/entities 过滤，再 BM25 打分排序，最后截断 top_k。
 *
 * 不参与检索的状态：suggested（闸门未过）、superseded（被新说法取代）、
 * deleted_pending（已忘却）、orphaned（来源清空）。
 *
 * 体验相关的两件事：
 * - **别名词表**：查询命中「数据库」时，把 sqlite/postgres/mysql 作为低权重补充词参与打分，
 *   并允许它们构成命中（标 `reason: "alias"`）。这是没有向量时最有效的召回补丁。
 * - **性能**：走 index-cache，切词结果复用。
 */
import type { MemoryBackend } from '../store/backend.js'
import type { EntryType, IndexEntry } from '../types.js'
import { DEFAULT_TOP_K, MAX_TOP_K, isRetrievable } from '../types.js'
import {
  buildKeywordIndexFromTokens,
  bm25Scores,
  queryTerms,
  roundScore,
} from '../retrieve/keyword.js'
import { loadIndex, tokensOf } from '../retrieve/index-cache.js'
import { buildFacets, describeFacets } from '../store/facets.js'
import { recordHits } from '../store/usage.js'
import { recordQueryLog } from '../store/query-log.js'
import { ALIAS_TERM_WEIGHT, expandAliases, mergeAliasGroups } from '../retrieve/aliases.js'
import type { AliasTable } from '../retrieve/aliases.js'

export interface SearchInput {
  query: string
  tags?: string[]
  time_range?: { from?: string; to?: string }
  entities?: string[]
  /** 默认 10，硬上限 200。 */
  top_k?: number
}

export interface Hit {
  id: string
  path: string
  type: EntryType
  title: string
  summary: string
  /** BM25 分数（越高越相关）。 */
  score: number
  /** 命中来源：字面命中，还是靠别名词表推断出来的。 */
  reason?: 'bm25' | 'alias'
}

/** 别名表文件名（放在记忆库根目录，可手改）。 */
export const ALIAS_FILE = 'aliases.json'

/** 查询词正好等于某个 tag/entity 时的加成（精确标签比正文里提一句更可信）。 */
const EXACT_KEY_BOOST = 1.5

export async function searchHandler(backend: MemoryBackend, input: SearchInput): Promise<Hit[]> {
  await backend.init()
  const loaded = await loadIndex(backend)
  const candidates = filterEntries(loaded.entries, input)
  const limit = clampTopK(input.top_k)
  const query = typeof input.query === 'string' ? input.query.trim() : ''

  if (query === '') {
    // 只有过滤条件时，按时间倒序给一个稳定的浏览列表。
    return candidates
      .slice()
      .sort((a, b) => b.time.localeCompare(a.time) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(toHitWithScore(0, 'bm25'))
  }

  const index = buildKeywordIndexFromTokens(candidates.map((entry) => tokensOf(loaded, entry)))
  const table = await loadAliasTable(backend)
  const expansion = expandAliases(query, table, new Set(queryTerms(query)))

  // 两遍打分：一遍只用原查询（用来区分「字面命中」），一遍带别名补充词
  const literal = bm25Scores(index, query)
  const scores = expansion.extraTerms.length === 0
    ? literal
    : bm25Scores(index, query, {}, { extraTerms: expansion.extraTerms, extraWeight: ALIAS_TERM_WEIGHT })

  const byId = new Map(candidates.map((entry) => [entry.id, entry]))
  const exactKey = query.toLowerCase()

  const ranked = [...scores.entries()]
    .map(([id, score]) => {
      const entry = byId.get(id)
      if (entry === undefined) return { entry, score, reason: 'bm25' as const }
      const exact = [...entry.tags, ...entry.entities]
        .some((keyword) => keyword.toLowerCase() === exactKey)
      return {
        entry,
        score: exact ? score * EXACT_KEY_BOOST : score,
        reason: literal.has(id) ? ('bm25' as const) : ('alias' as const),
      }
    })
    .filter((item): item is { entry: IndexEntry; score: number; reason: 'bm25' | 'alias' } => item.entry !== undefined)
    .sort((a, b) => (b.score === a.score ? a.entry.id.localeCompare(b.entry.id) : b.score - a.score))
    .slice(0, limit)
    .map((item) => toHitWithScore(item.score, item.reason)(item.entry))

  // 使用信号在这里记，而不是在工具层：任何入口（模型/面板）的检索都算一次「用过」，
  // 否则面板搜索不会进 hit_count，体检就会误判「这条没人用」。
  await recordHits(backend, ranked.map((hit) => hit.id), backend.now())
  // 每次真实检索都记（模型与面板同源），供反查「问了但没命中」；
  // query 为空的纯浏览分支在上面已 early return，不进这条日志。
  await recordQueryLog(backend, query, ranked.length, backend.now())
  return ranked
}

/**
 * 零命中/弱命中时给模型的下一步。
 *
 * 没有语义检索时，模型最常犯的错是「不换词再试」就告诉用户「没记过」。
 * 这段引导把「库里有几条、常用标签、最近记了什么」摊开，让它自己换词或改走 nav。
 */
export async function buildSearchGuidance(
  backend: MemoryBackend,
  hits: readonly Hit[],
): Promise<string> {
  if (hits.length > 0) {
    const aliasCount = hits.filter((hit) => hit.reason === 'alias').length
    return aliasCount === 0
      ? ''
      : `其中 ${aliasCount} 条是靠别名词表推断的（reason=alias），不对就换更具体的说法。`
  }
  try {
    const entries = (await loadIndex(backend)).entries
    const facets = buildFacets(entries)
    if (facets.total === 0) return '记忆库还是空的，还没有任何记忆。'
    const recent = entries
      .slice()
      .sort((a, b) => b.time.localeCompare(a.time))
      .slice(0, 3)
      .map((entry) => `「${entry.title}」`)
      .join('、')
    const tagText = facets.tags.length === 0
      ? ''
      : `常用标签：${facets.tags.slice(0, 6).map((tag) => tag.name).join(' / ')}。`
    return [
      '没有直接命中（BM25 只认字面相同的词，别名词表也没兜住）。',
      describeFacets(facets),
      tagText,
      `最近记的是：${recent}。`,
      '可以换更具体的名词再搜，或者用 memory_nav({ sort: "recent" }) 看最近条目。',
    ].filter((line) => line !== '').join('\n')
  } catch {
    return '没有直接命中。可以换更具体的词再搜，或用 memory_nav 浏览。'
  }
}

/** 读别名表：`<root>/aliases.json` 与内置表合并；坏文件直接忽略（不因为配置写错就搜不了）。 */
export async function loadAliasTable(backend: MemoryBackend): Promise<AliasTable> {
  try {
    const text = await backend.readFile(ALIAS_FILE)
    if (text === null || text.trim() === '') return mergeAliasGroups(undefined)
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return mergeAliasGroups(undefined)
    }
    const groups: Record<string, string[]> = {}
    for (const [group, words] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(words)) continue
      groups[group] = words.filter((word): word is string => typeof word === 'string')
    }
    return mergeAliasGroups(groups)
  } catch {
    return mergeAliasGroups(undefined)
  }
}

/** 过滤阶段：状态 → tags（AND）→ entities（AND）→ 时间区间（闭区间）。 */
export function filterEntries(
  entries: readonly IndexEntry[],
  input: Pick<SearchInput, 'tags' | 'time_range' | 'entities'>,
): IndexEntry[] {
  const tags = lowerList(input.tags)
  const entities = lowerList(input.entities)
  const from = normalizeBound(input.time_range?.from)
  const to = normalizeBound(input.time_range?.to)

  return entries.filter((entry) => {
    if (!isRetrievable(entry.status)) return false
    if (tags.length > 0) {
      const owned = new Set(entry.tags.map((tag) => tag.toLowerCase()))
      if (!tags.every((tag) => owned.has(tag))) return false
    }
    if (entities.length > 0) {
      const owned = new Set(entry.entities.map((entity) => entity.toLowerCase()))
      if (!entities.every((entity) => owned.has(entity))) return false
    }
    if (from !== undefined || to !== undefined) {
      const time = entry.time.slice(0, 24)
      if (from !== undefined && time < from) return false
      if (to !== undefined && time > to) return false
    }
    return true
  })
}

function toHitWithScore(score: number, reason: 'bm25' | 'alias'): (entry: IndexEntry) => Hit {
  return (entry) => ({
    id: entry.id,
    path: entry.path,
    type: entry.type,
    title: entry.title,
    summary: entry.summary,
    score: roundScore(score),
    reason,
  })
}

/** top_k：默认 10，硬上限 200，非法值回落默认。 */
export function clampTopK(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_TOP_K
  const floored = Math.floor(raw)
  if (floored < 1) return 1
  return Math.min(floored, MAX_TOP_K)
}

function lowerList(raw: readonly string[] | undefined): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
}

function normalizeBound(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const time = Date.parse(raw)
  if (Number.isNaN(time)) return undefined
  return new Date(time).toISOString().slice(0, 24)
}
