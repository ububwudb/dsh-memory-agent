/**
 * 索引与切词结果的进程内缓存。
 *
 * 为什么需要：每次 search/nav 都「读整个 index.jsonl → JSON.parse → 全量切词」，
 * 中文 2-gram 切词是最贵的一步。缓存以「索引文本指纹」为 key，
 * 任何写入（writeIndex / mutateIndex / 手工改文件）都会让指纹变化 → 自动失效，
 * 所以不需要手工 invalidate，也不会读到脏数据。
 */
import type { MemoryBackend } from '../store/backend.js'
import type { IndexEntry } from '../types.js'
import { INDEX_FILE, parseIndexLines } from '../store/index-store.js'
import { tokenizeEntry } from './keyword.js'
import type { TokenizedDoc } from './keyword.js'

export interface LoadedIndex {
  entries: IndexEntry[]
  /** id → 已切好的 content/keywords token */
  tokens: Map<string, TokenizedDoc>
  signature: string
  fromCache: boolean
}

interface CacheSlot {
  signature: string
  entries: IndexEntry[]
  tokens: Map<string, TokenizedDoc>
  hits: number
}

const SLOTS = new Map<string, CacheSlot>()

/** FNV-1a 变体：够快、够稳，只用来判等。 */
export function indexSignature(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`
}

/** 读索引（带缓存）。返回的 entries 不要就地修改——它是缓存对象。 */
export async function loadIndex(backend: MemoryBackend): Promise<LoadedIndex> {
  const text = (await backend.readFile(INDEX_FILE)) ?? ''
  const signature = indexSignature(text)
  const cached = SLOTS.get(backend.root)
  if (cached !== undefined && cached.signature === signature) {
    cached.hits += 1
    return { entries: cached.entries, tokens: cached.tokens, signature, fromCache: true }
  }

  const entries = parseIndexLines(text).entries
  const tokens = new Map<string, TokenizedDoc>()
  for (const entry of entries) {
    tokens.set(entry.id, tokenizeEntry({
      id: entry.id,
      content: `${entry.title}\n${entry.summary}`,
      keywords: [...entry.tags, ...entry.entities].join(' '),
    }))
  }
  SLOTS.set(backend.root, { signature, entries, tokens, hits: 0 })
  return { entries, tokens, signature, fromCache: false }
}

/** 某条文档的 token；缓存里没有就现切（理论上不会走到）。 */
export function tokensOf(
  loaded: LoadedIndex,
  entry: IndexEntry,
): TokenizedDoc {
  const cached = loaded.tokens.get(entry.id)
  if (cached !== undefined) return cached
  return tokenizeEntry({
    id: entry.id,
    content: `${entry.title}\n${entry.summary}`,
    keywords: [...entry.tags, ...entry.entities].join(' '),
  })
}

export function cacheInfo(root: string): { cached: boolean; hits: number; signature: string } {
  const slot = SLOTS.get(root)
  return slot === undefined
    ? { cached: false, hits: 0, signature: '' }
    : { cached: true, hits: slot.hits, signature: slot.signature }
}

export function clearIndexCache(): void {
  SLOTS.clear()
}
