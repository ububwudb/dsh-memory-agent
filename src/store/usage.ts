/**
 * 使用信号：`<root>/usage.jsonl`，一行一次命中。
 *
 * 为什么单独一个文件、只追加：
 * - 检索是读路径，绝不能被写放大拖慢，也不能因为记录失败而报错；
 * - 主索引是「读-改-写全量覆盖」，每次都为了 +1 而重写索引是不可接受的；
 * - 审计友好：命中历史原样保留，聚合随时可重算。
 *
 * 阈值参考（借自社区里迭代过十几个版本的实现，且注释里写明了理由）：
 * - 久未命中的体检阈值 90 天：非常驻记忆几十天不用是常态，阈值定太低会把正常记录报成待清理；
 * - 自动降级阈值 30 天：只针对「系统自动升上来的常驻」，人工开的不动。
 */
import type { MemoryBackend } from './backend.js'

export const USAGE_FILE = 'usage.jsonl'

/** 一次检索最多给前几条记信号——保证 hit_count 度量的是「模型真的会看的那几条」。 */
export const HIT_MARK_LIMIT = 5

/** 体检里「久未命中」的天数阈值。 */
export const STALE_USAGE_DAYS = 90

/** 自动降级候选的天数阈值（与面板冷数据判定对齐）。 */
export const AUTO_DEMOTE_DAYS = 30

export interface UsageRecord {
  id: string
  at: string
  /** 命中时的位次（1 起），便于以后做加权。 */
  rank?: number
}

export interface UsageSummary {
  count: number
  last: string
}

/** 追加命中记录；失败静默（旁路证据，不影响检索）。 */
export async function recordHits(
  backend: MemoryBackend,
  ids: readonly string[],
  at: string,
  limit = HIT_MARK_LIMIT,
): Promise<void> {
  if (ids.length === 0) return
  const lines: string[] = []
  ids.slice(0, limit).forEach((id, index) => {
    if (typeof id !== 'string' || id === '') return
    lines.push(JSON.stringify({ id, at, rank: index + 1 } satisfies UsageRecord))
  })
  if (lines.length === 0) return
  try {
    await backend.appendFile(USAGE_FILE, `${lines.join('\n')}\n`)
  } catch {
    // 记不上就不记，检索结果已经返回
  }
}

/** 解析 usage.jsonl 文本；坏行跳过。同步版本供常驻注入的同步 provider 复用。 */
export function parseUsageText(text: string): Map<string, UsageSummary> {
  const out = new Map<string, UsageSummary>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    let record: UsageRecord
    try {
      record = JSON.parse(line) as UsageRecord
    } catch {
      continue
    }
    if (typeof record?.id !== 'string' || record.id === '') continue
    const at = typeof record.at === 'string' ? record.at : ''
    const current = out.get(record.id)
    if (current === undefined) {
      out.set(record.id, { count: 1, last: at })
      continue
    }
    current.count += 1
    if (at > current.last) current.last = at
  }
  return out
}

/** 聚合使用信号；坏行跳过。 */
export async function loadUsage(backend: MemoryBackend): Promise<Map<string, UsageSummary>> {
  try {
    return parseUsageText((await backend.readFile(USAGE_FILE)) ?? '')
  } catch {
    return new Map()
  }
}

/** 把使用信号合并进条目（只用于展示，不落盘、不影响检索排序）。 */
export function mergeUsage(
  entries: readonly { id: string; time: string; hit_count?: number; last_used_at?: string }[],
  usage: ReadonlyMap<string, UsageSummary>,
): void {
  for (const entry of entries) {
    const summary = usage.get(entry.id)
    if (summary === undefined) continue
    entry.hit_count = summary.count
    entry.last_used_at = summary.last === '' ? entry.time : summary.last
  }
}

/** 闲置天数：优先用最后命中时间，没有就用写入时间。 */
export function idleDays(entry: { time: string; last_used_at?: string }, now: Date): number {
  const reference = entry.last_used_at ?? entry.time
  const stamp = Date.parse(reference)
  if (Number.isNaN(stamp)) return 0
  return Math.max(0, Math.floor((now.getTime() - stamp) / (24 * 60 * 60 * 1000)))
}
