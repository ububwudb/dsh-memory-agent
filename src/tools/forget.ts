/**
 * forget_memories_by_session：显式删除联动（不依赖任何自动钩子）。
 *
 * scope=session_only（默认）
 *   episodes/ raw/ 中 sources 含该 session 的条目 → deleted_pending，从检索索引移除，文件保留。
 * scope=include_shared_unlink
 *   额外对 topics/ 的共享记忆从 sources 数组移除该 session；
 *   sources 清空时标 orphaned，绝不删除整个文件。
 * mode=soft（默认）只改状态；mode=hard 物理删除已标 deleted_pending 的 episodes/raw 文件
 *   （topics 永不删除，那是共享知识）。
 *
 * 判定只读 entry.sources 数组，顶层 session_id 仅用于展示与回填。
 */
import type { MemoryBackend } from '../store/backend.js'
import type { EntryStatus, IndexEntry } from '../types.js'
import { mutateIndex, patchEntryFile } from '../store/file-backend.js'

export type ForgetScope = 'session_only' | 'include_shared_unlink'
export type ForgetMode = 'soft' | 'hard'

export interface ForgetInput {
  session_id: string
  scope?: ForgetScope
  mode?: ForgetMode
}

export interface ForgetOutput {
  deleted_episode_count: number
  deleted_raw_count: number
  unlinked_topic_count: number
  orphaned_topic_count: number
  affected_paths: string[]
  status_changes: Array<{ id: string; from: EntryStatus; to: EntryStatus }>
}

export async function forgetHandler(
  backend: MemoryBackend,
  input: ForgetInput,
): Promise<ForgetOutput> {
  const sessionId = typeof input.session_id === 'string' ? input.session_id.trim() : ''
  if (sessionId === '') {
    throw new Error('forget_memories_by_session: `session_id` must be a non-empty string')
  }
  const scope: ForgetScope = input.scope === 'include_shared_unlink'
    ? 'include_shared_unlink'
    : 'session_only'
  const mode: ForgetMode = input.mode === 'hard' ? 'hard' : 'soft'

  return mutateIndex(backend, async (entries) => {
    const now = backend.now()
    const statusChanges: ForgetOutput['status_changes'] = []
    const affected = new Set<string>()
    const hardDelete: IndexEntry[] = []
    let deletedEpisodes = 0
    let deletedRaw = 0
    let unlinkedTopics = 0
    let orphanedTopics = 0

    for (const entry of entries) {
      if (!entry.sources.some((source) => source.session_id === sessionId)) continue
      const from = entry.status

      if (isSharedEntry(entry)) {
        if (scope !== 'include_shared_unlink') continue
        // 共享记忆只解绑来源，绝不删文件；来源清空只标 orphaned。
        entry.sources = entry.sources.filter((source) => source.session_id !== sessionId)
        if (entry.sources.length === 0) {
          entry.status = 'orphaned'
          if (from !== 'orphaned') orphanedTopics += 1
        } else if (from !== 'orphaned') {
          unlinkedTopics += 1
        }
        if (entry.session_id === sessionId) {
          entry.session_id = entry.sources[0]?.session_id ?? ''
        }
        if (from !== entry.status) {
          statusChanges.push({ id: entry.id, from, to: entry.status })
        }
        await patchEntryFile(backend, entry.path, {
          status: entry.status,
          sources: entry.sources.map((source) => `${source.session_id}:${source.kind}`).join(', '),
          session_id: entry.session_id,
        })
        affected.add(entry.path)
        continue
      }

      if (from !== 'deleted_pending') {
        entry.status = 'deleted_pending'
        entry.deleted_at = now
        entry.deleted_by_session = sessionId
        if (entry.type === 'raw') deletedRaw += 1
        else deletedEpisodes += 1
        statusChanges.push({ id: entry.id, from, to: 'deleted_pending' })
        affected.add(entry.path)
        await patchEntryFile(backend, entry.path, {
          status: 'deleted_pending',
          deleted_at: now,
          deleted_by_session: sessionId,
        })
      }
      // hard 模式：本次会话相关的 episodes/raw 全部物理删除（含此前已标记的）
      if (mode === 'hard') hardDelete.push(entry)
    }

    if (mode === 'hard' && hardDelete.length > 0) {
      for (const entry of hardDelete) {
        await backend.removeFile(entry.path)
      }
      const removed = new Set(hardDelete.map((entry) => entry.id))
      const kept = entries.filter((entry) => !removed.has(entry.id))
      entries.splice(0, entries.length, ...kept)
    }

    await backend.appendLedger({
      at: now,
      type: 'memory/forget',
      session_id: sessionId,
      scope,
      mode,
      deleted_episode_count: deletedEpisodes,
      deleted_raw_count: deletedRaw,
      unlinked_topic_count: unlinkedTopics,
      orphaned_topic_count: orphanedTopics,
      affected_paths: [...affected],
    })

    return {
      deleted_episode_count: deletedEpisodes,
      deleted_raw_count: deletedRaw,
      unlinked_topic_count: unlinkedTopics,
      orphaned_topic_count: orphanedTopics,
      affected_paths: [...affected].sort(),
      status_changes: statusChanges,
    }
  })
}

/** topics/ 下（或 type 为 topic/summary）的条目视为共享记忆。 */
function isSharedEntry(entry: IndexEntry): boolean {
  if (entry.type === 'topic' || entry.type === 'summary') return true
  return entry.path.startsWith('topics/')
}
