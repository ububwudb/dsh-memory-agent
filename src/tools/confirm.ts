/**
 * memory_confirm：确认闸门的唯一出口，suggested → active。
 *
 * 只有 suggested 能提升；已经是 active 时幂等返回；其他状态拒绝，避免用确认
 * 动作绕过 conflict / deleted_pending 的语义（冲突要走 memory_resolve）。
 */
import type { MemoryBackend } from '../store/backend.js'
import { mutateIndex, patchEntryFile } from '../store/file-backend.js'

export interface ConfirmInput {
  id: string
}

export interface ConfirmOutput {
  id: string
  status: 'active'
}

export async function confirmHandler(
  backend: MemoryBackend,
  input: ConfirmInput,
): Promise<ConfirmOutput> {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (id === '') throw new Error('memory_confirm: `id` must be a non-empty string')

  return mutateIndex(backend, async (entries) => {
    const entry = entries.find((item) => item.id === id)
    if (entry === undefined) throw new Error(`memory_confirm: unknown memory id ${JSON.stringify(id)}`)

    if (entry.status === 'active') return { id: entry.id, status: 'active' as const }
    if (entry.status !== 'suggested') {
      throw new Error(
        `memory_confirm: only suggested entries can be confirmed (id=${id}, status=${entry.status})`,
      )
    }

    entry.status = 'active'
    await patchEntryFile(backend, entry.path, { status: 'active' })
    await backend.appendLedger({
      at: backend.now(),
      type: 'memory/confirm',
      id: entry.id,
      path: entry.path,
      from: 'suggested',
      to: 'active',
    })
    return { id: entry.id, status: 'active' as const }
  })
}
