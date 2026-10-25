/**
 * query-log：`<root>/query-log.jsonl`，一行一次检索（P2 代谢收尾）。
 *
 * 用途：反查「模型问了但库没命中」的查询——这些是记忆库该补内容的信号。
 * 与 usage.jsonl 同一套旁路纪律：只追加、失败静默、绝不为记录而拖慢检索主路径。
 *
 * 有界策略：上限 200 条；因为逐条 append 后每写一次都全量重写太贵，
 * 用滞回裁剪——行数超过 `LIMIT + SLACK`（250）才重写保留最近 `LIMIT`（200）条，
 * 稳态每 ~51 次检索才重写一次，文件行数恒 ≤ 251。
 */
import type { MemoryBackend } from './backend.js'

export const QUERY_LOG_FILE = 'query-log.jsonl'

/** 保留的最近条数（裁剪目标）。 */
export const QUERY_LOG_LIMIT = 200
/** 滞回余量：超过 LIMIT+SLACK 才触发裁剪（避免每写必重写）。 */
export const QUERY_LOG_TRIM_SLACK = 50
/** 单条 query 记录的截断宽度。 */
export const QUERY_LOG_QUERY_CHARS = 120

export interface QueryLogRecord {
  at: string
  query: string
  /** 该次检索返回的命中条数（0 = 问了但没命中）。 */
  hits: number
}

/**
 * 记录一次检索。任何失败都静默（旁路证据，不影响检索结果）。
 * query 去空白并截断到 QUERY_LOG_QUERY_CHARS；空查询不记。
 */
export async function recordQueryLog(
  backend: MemoryBackend,
  query: string,
  hits: number,
  at: string,
): Promise<void> {
  const trimmed = clip(query.replace(/\s+/g, ' ').trim(), QUERY_LOG_QUERY_CHARS)
  if (trimmed === '') return
  try {
    await backend.appendFile(QUERY_LOG_FILE, `${JSON.stringify({ at, query: trimmed, hits } satisfies QueryLogRecord)}\n`)
  } catch {
    return // 记不上就不记
  }
  // 滞回裁剪：只在超过 LIMIT+SLACK 时重写一次，保留最近 LIMIT 条
  try {
    const text = await backend.readFile(QUERY_LOG_FILE)
    if (text === null) return
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    if (lines.length > QUERY_LOG_LIMIT + QUERY_LOG_TRIM_SLACK) {
      await backend.writeFileAtomic(QUERY_LOG_FILE, `${lines.slice(-QUERY_LOG_LIMIT).join('\n')}\n`)
    }
  } catch {
    // 裁剪失败不影响检索，下次写入再试
  }
}

/** 读回全部检索日志（时间正序，坏行跳过）。 */
export async function loadQueryLog(backend: MemoryBackend): Promise<QueryLogRecord[]> {
  let text: string | null
  try {
    text = await backend.readFile(QUERY_LOG_FILE)
  } catch {
    return []
  }
  if (text === null) return []
  const out: QueryLogRecord[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const record = JSON.parse(trimmed) as QueryLogRecord
      if (typeof record?.at !== 'string' || typeof record?.query !== 'string') continue
      out.push({ at: record.at, query: record.query, hits: typeof record.hits === 'number' ? record.hits : 0 })
    } catch {
      continue
    }
  }
  return out
}

/** 最近的零命中查询（新→旧，默认 20 条）：记忆库该补内容的信号。 */
export async function zeroHitQueries(
  backend: MemoryBackend,
  limit = 20,
): Promise<QueryLogRecord[]> {
  const all = await loadQueryLog(backend)
  return all
    .filter((record) => record.hits === 0)
    .slice(-limit)
    .reverse()
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 1) return ''
  return `${text.slice(0, max - 1).trimEnd()}…`
}
