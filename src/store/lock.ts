/**
 * 极简文件锁：用 `open(path, 'wx')` 做互斥，配合过期锁清理。
 *
 * 为什么需要：索引是「读整个 index.jsonl → 改 → 整体重写」。两个工具调用并发时
 * 会互相覆盖（后写的把先写的条目吃掉）。单进程多 session / 多 subagent 都会撞上。
 *
 * 不追求分布式正确性，只要同机多协程/多进程不丢条目即可：
 * - 抢不到就短轮询重试，超时抛错（宁可报错，不静默丢数据）；
 * - 持锁进程崩了会留下陈旧锁，超过 staleMs 直接清掉。
 */
import { open, rm, stat } from 'node:fs/promises'

export interface LockOptions {
  /** 抢锁最长等待，默认 8s */
  timeoutMs?: number
  /** 多久算陈旧锁，默认 15s */
  staleMs?: number
  /** 轮询间隔，默认 15ms */
  pollMs?: number
}

/**
 * 抢锁成功返回释放函数（幂等、异步）。
 *
 * Windows 上「文件刚被删 / 句柄没释放干净」时 open 报的是 EPERM 而不是 EEXIST，
 * 所以这几种码统一当「已被占用」处理，重试而不是直接失败。
 */
export async function acquireLock(
  lockPath: string,
  options: LockOptions = {},
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? 8000
  const staleMs = options.staleMs ?? 15000
  const pollMs = options.pollMs ?? 15
  const startedAt = Date.now()

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(`${process.pid}:${Date.now()}`, 'utf8')
      } finally {
        await handle.close()
      }
      let released = false
      return async () => {
        if (released) return
        released = true
        await rm(lockPath, { force: true }).catch(() => {})
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const busy = code === 'EEXIST' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!busy) throw error
    }

    try {
      const info = await stat(lockPath)
      if (Date.now() - info.mtimeMs > staleMs) {
        await rm(lockPath, { force: true })
        continue
      }
    } catch {
      // 别人刚释放，立刻重试
      continue
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`memory index is locked (${lockPath}) — 另一个写入还没结束`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
