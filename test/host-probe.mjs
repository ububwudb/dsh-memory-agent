/**
 * 宿主侧探针：用真实 @deepseek-ai/dsh-tools 校验插件注册的定义。
 * 用法：node dsh-host-probe.mjs <appDshDir> <pluginEntryUrl> <tmpRoot>
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [appDshDir, pluginEntry, ...rest] = process.argv.slice(2)
const hostTools = await import(pathToFileURL(path.join(appDshDir, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')).href)
const plugin = await import(pathToFileURL(pluginEntry).href)

const { assertSupportedJsonSchema, validateJsonSchemaValue, defineTool } = hostTools
console.log('宿主导出的校验器:', ['assertSupportedJsonSchema', 'validateJsonSchemaValue', 'defineTool'].filter((k) => typeof hostTools[k] === 'function').join(', '))

const root = rest[0] ?? await mkdtemp(path.join(os.tmpdir(), 'dsh-memory-probe-'))
const captured = []
const cleanups = []
plugin.apply({
  tools: { register: (definition) => { captured.push(definition); return () => {} } },
  effect: (execute) => { const cleanup = execute(); cleanups.push(cleanup); return () => {} },
}, { root })

let problems = 0
const fail = (msg) => { problems += 1; console.error('  FAIL', msg) }

for (const definition of captured) {
  try {
    assertSupportedJsonSchema(definition.parameters)
    assertSupportedJsonSchema(definition.output.schema)
  } catch (error) {
    fail(`${definition.name} schema 不被宿主接受: ${error.message}`)
  }
}
console.log(`schema 校验：${captured.length} 个工具`)

/** 参数 → 真实执行 → 渲染，一条龙跑通 */
const cases = [
  ['write_memory', { summary: '调试用记忆：pnpm 是默认包管理器', tags: ['probe'], session_id: 'probe-s1' }],
  ['write_memory', { summary: '调试用记忆：SQLite WAL 提升并发读', raw: 'WAL 模式允许读写并行。', tags: ['probe'], session_id: 'probe-s1' }],
  ['memory_search_hybrid', { query: '包管理器 pnpm', top_k: 5 }],
  ['memory_nav', {}],
  ['memory_nav', { path: 'topics/' }],
  ['memory_assemble', { task: 'WAL 并发', budget: 60 }],
]

const outputs = {}
for (const [name, args] of cases) {
  const definition = captured.find((item) => item.name === name)
  if (!definition) { fail(`没有注册 ${name}`); continue }
  const violations = validateJsonSchemaValue(definition.parameters, args, '')
  if (violations.length > 0) { fail(`${name} 参数校验不通过: ${violations.join('; ')}`); continue }
  try {
    const value = await definition.execute(args, {})
    outputs[name] = value
    const rendered = definition.output.render(args, value)
    const text = Array.isArray(rendered) ? rendered.map((part) => part.text ?? '').join('\n') : ''
    console.log(`  ${name} → ${JSON.stringify(value).slice(0, 160)}`)
    console.log(`     render 首行: ${text.split('\n')[0].slice(0, 100)}`)
  } catch (error) {
    fail(`${name} 执行/渲染抛错: ${error.message}`)
  }
}

// 用写入结果驱动 confirm / forget，闭合整条链路
const write = outputs.write_memory
if (write?.id) {
  const confirm = captured.find((item) => item.name === 'memory_confirm')
  try {
    console.log('  memory_confirm →', JSON.stringify(await confirm.execute({ id: write.id }, {})))
  } catch (error) {
    console.log('  memory_confirm 预期报错（active 不需确认）:', error.message)
  }
}
const forget = captured.find((item) => item.name === 'forget_memories_by_session')
console.log('  forget →', JSON.stringify(await forget.execute({ session_id: 'probe-s1' }, {})))

for (const cleanup of cleanups) if (typeof cleanup === 'function') await cleanup()
await rm(root, { recursive: true, force: true })

console.log(problems === 0 ? '\nHOST PROBE OK' : `\nHOST PROBE FAILED (${problems})`)
process.exit(problems === 0 ? 0 : 1)
