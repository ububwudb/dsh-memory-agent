/**
 * 会话钩子：只注入与审计，默认关闭，绝不删除任何记忆。
 *
 * 这里刻意不订阅任何"回合结束"事件去做自动清理——删除只走显式工具
 * forget_memories_by_session。钩子存在的唯一理由是留下 attach/detach 审计痕迹，
 * 方便事后对账"这次会话到底碰过什么"。
 */
import type { MemoryBackend } from '../store/backend.js'

export interface SessionHookOptions {
  /** 默认 false。 */
  enabled?: boolean
  /** 是否写审计事件，默认 true。 */
  audit?: boolean
  /** 会话标识，仅用于审计。 */
  session_id?: string
}

/** 只用到 ctx.effect 这一个能力，避免把 cordis 类型拖进依赖。 */
export interface EffectHost {
  effect(execute: () => void | (() => void), label?: string): unknown
}

/** 安装钩子；返回卸载函数（未启用时是空操作）。 */
export function installSessionHook(
  ctx: EffectHost,
  backend: MemoryBackend,
  options: SessionHookOptions = {},
): () => void {
  if (options.enabled !== true) return () => {}
  const audit = options.audit !== false
  const sessionId = options.session_id ?? 'unknown'

  const maybeDispose = ctx.effect(() => {
    if (audit) {
      void backend.appendLedger({
        at: backend.now(),
        type: 'lifecycle/attach',
        session_id: sessionId,
        note: 'audit-only: 钩子绝不删除记忆',
      })
    }
    return () => {
      if (audit) {
        void backend.appendLedger({
          at: backend.now(),
          type: 'lifecycle/detach',
          session_id: sessionId,
        })
      }
    }
  }, 'dsh-memory-agent:session-hook')

  return typeof maybeDispose === 'function' ? (maybeDispose as () => void) : () => {}
}
