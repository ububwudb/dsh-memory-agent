/**
 * memory_resolve：给冲突收尾。
 *
 * 冲突如果只标记不裁决，两份互相矛盾的记忆会**同时**被检索、同时进上下文，
 * 等于把判断权甩回给模型。这个工具让人（或模型）显式选边：
 *
 * - action = "keep"（默认）：这条转 active，同槽位的其它冲突条目转 superseded（保留文件作历史）。
 * - action = "drop"：这条转 superseded，不动别人。
 *
 * 只处理 conflict 状态的条目；其它状态直接报错，避免拿它当万能状态扳手。
 */
import type { MemoryBackend } from '../store/backend.js'
import type { EntryStatus } from '../types.js'
import { mutateIndex, patchEntryFile } from '../store/file-backend.js'

export interface ResolveInput {
  id: string
  action?: 'keep' | 'drop'
}

export interface ResolveOutput {
  id: string
  status: EntryStatus
  /** 被连带改成 superseded 的条目。 */
  superseded: string[]
}

export async function resolveHandler(
  backend: MemoryBackend,
  input: ResolveInput,
): Promise<ResolveOutput> {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (id === '') throw new Error('memory_resolve: `id` 必填')
  const action = input.action === 'drop' ? 'drop' : 'keep'

  return mutateIndex(backend, async (entries) => {
    const entry = entries.find((item) => item.id === id)
    if (entry === undefined) throw new Error(`memory_resolve: 没有这条记忆 ${JSON.stringify(id)}`)
    if (entry.status !== 'conflict') {
      throw new Error(`memory_resolve: 只处理 conflict 状态的条目（id=${id}, status=${entry.status}）`)
    }

    const superseded: string[] = []
    entry.status = action === 'keep' ? 'active' : 'superseded'
    await patchEntryFile(backend, entry.path, { status: entry.status })

    if (action === 'keep' && entry.conflict_key !== undefined) {
      for (const sibling of entries) {
        if (sibling.id === entry.id) continue
        if (sibling.conflict_key !== entry.conflict_key) continue
        if (sibling.status !== 'conflict') continue
        sibling.status = 'superseded'
        superseded.push(sibling.id)
        await patchEntryFile(backend, sibling.path, { status: 'superseded' })
      }
    }

    await backend.appendLedger({
      at: backend.now(),
      type: 'memory/resolve',
      id: entry.id,
      action,
      status: entry.status,
      superseded,
    })
    return { id: entry.id, status: entry.status, superseded }
  })
}
