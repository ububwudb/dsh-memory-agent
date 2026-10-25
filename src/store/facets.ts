/**
 * 库画像（facets）：让模型「知道自己知道什么」。
 *
 * 没有向量检索时，模型最大的问题不是搜不准，而是**不知道该搜什么**：
 * 它不知道库里有哪些标签、最近记了什么、分层结构如何，于是要么放弃、要么重复写。
 * 把这几项摘要给出去，它就能自己换词重试。
 */
import type { IndexEntry } from '../types.js'
import { isRetrievable } from '../types.js'

export interface TagFacet {
  name: string
  count: number
}

export interface LibraryFacets {
  total: number
  /** 可检索条数（排除 suggested/superseded/deleted_pending/orphaned） */
  retrievable: number
  types: Record<string, number>
  /** 出现过最多的标签，最多 20 个 */
  tags: TagFacet[]
  newest?: string
  oldest?: string
}

/** 计算库画像；`limit` 控制标签最多给几个。 */
export function buildFacets(entries: readonly IndexEntry[], limit = 20): LibraryFacets {
  const types: Record<string, number> = {}
  const tagCounts = new Map<string, number>()
  let retrievable = 0
  let newest: string | undefined
  let oldest: string | undefined

  for (const entry of entries) {
    types[entry.type] = (types[entry.type] ?? 0) + 1
    if (isRetrievable(entry.status)) retrievable += 1
    for (const tag of entry.tags) {
      const key = tag.trim()
      if (key === '') continue
      tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1)
    }
    if (newest === undefined || entry.time > newest) newest = entry.time
    if (oldest === undefined || entry.time < oldest) oldest = entry.time
  }

  const tags = [...tagCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count === a.count ? a.name.localeCompare(b.name) : b.count - a.count))
    .slice(0, limit)

  return {
    total: entries.length,
    retrievable,
    types,
    tags,
    ...(newest === undefined ? {} : { newest }),
    ...(oldest === undefined ? {} : { oldest }),
  }
}

/** 把 facets 写成一句人话（给工具渲染用）。 */
export function describeFacets(facets: LibraryFacets): string {
  if (facets.total === 0) return '记忆库还是空的。'
  const tagText = facets.tags.length === 0
    ? '（还没有标签）'
    : facets.tags.slice(0, 8).map((tag) => `${tag.name}(${tag.count})`).join(' ')
  const newest = facets.newest === undefined ? '' : `，最近更新 ${facets.newest.slice(0, 10)}`
  return `库里有 ${facets.total} 条（可检索 ${facets.retrievable}）${newest}；常用标签：${tagText}`
}
