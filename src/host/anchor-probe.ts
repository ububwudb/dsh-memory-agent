/**
 * 锚点探测的 Node 实现（宿主层专用，可以碰 process / node:fs）。
 *
 * tool-list / self-version 当前没有现成的宿主 API 可查——按「探测不到 = 未校验」
 * 的规则返回 undefined，绝不把没能力探测误判成失效（判据见 store/anchors.ts）。
 */
import { existsSync } from 'node:fs'
import { env } from 'node:process'
import type { AnchorProbe } from '../store/anchors.js'

export function createNodeAnchorProbe(): AnchorProbe {
  return {
    env: (name) => {
      if (typeof name !== 'string' || name === '') return undefined
      const value = env[name]
      return value === undefined ? undefined : value
    },
    pathExists: (path) => {
      if (typeof path !== 'string' || path === '') return undefined
      try {
        return existsSync(path)
      } catch {
        return undefined
      }
    },
    toolList: () => undefined, // 宿主没有可直接查询的工具清单 API：未校验
    selfVersion: () => undefined, // 同上：未校验
  }
}
