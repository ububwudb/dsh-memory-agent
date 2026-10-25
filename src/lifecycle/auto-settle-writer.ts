/**
 * 自动沉淀的写库接线：**唯一**负责「候选怎么变成一条记忆」的地方。
 *
 * 单独立文件是为了让「只写 suggested」这条硬约束只有一个落点：
 * 生产接线（index.ts）和测试（test/run-settle-check.mjs）都调这里，
 * 不会出现「生产改了、测试还在按老样子写」的漂移。
 *
 * 写死的三件事，不要改：
 * 1. `requireConfirmation: true` —— 自动沉淀永远只写 suggested，确认闸门不许绕过；
 * 2. `type: 'episode'` + `raw` —— 沉淀的是用户原话，留原文便于日后核对；
 * 3. `source: 'session'` —— 来源标记，forget 按会话忘却时靠它命中。
 */
import type { MemoryBackend } from '../store/backend.js'
import { writeHandler } from '../tools/write.js'
import type { AutoSettleWriteInput } from './auto-settle.js'

export interface SettleWriterOptions {
  /** 写入前脱敏（跟 runtime.redactSecrets 走），默认 true。 */
  redactSecrets?: boolean
}

export type SettleWriter = (
  input: AutoSettleWriteInput,
) => Promise<{ id?: string; status?: string; dedupe?: string }>

/** 造一个写库回调，交给 createAutoSettler 的 `write`。 */
export function createSettleWriter(
  backend: MemoryBackend,
  options: SettleWriterOptions = {},
): SettleWriter {
  return async (input) => {
    const output = await writeHandler(backend, {
      title: input.title,
      summary: input.summary,
      raw: input.summary,
      tags: input.tags,
      source: 'session',
      session_id: input.session_id,
      requireConfirmation: true,
      redactSecrets: options.redactSecrets !== false,
      type: 'episode',
    })
    return { id: output.id, status: output.status, dedupe: output.dedupe }
  }
}
