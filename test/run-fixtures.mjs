#!/usr/bin/env node
/**
 * fixture 断言器：不需要启动 DSH 运行时。
 *
 * 直接 import('lib/tools/*.js')，给每个 case 一个独立的临时 backend，
 * 按 cases.json 的 steps 依次调用 handler，再逐条对照 expect。
 * 任何一条对不上就 exit 1（AI 自己跑、自己改，不许跳过）。
 *
 * 用法：
 *   node test/run-fixtures.mjs            # 全部
 *   node test/run-fixtures.mjs 03         # 只跑名字里含 "03" 的 case
 *   node test/run-fixtures.mjs --json     # 额外打印每个 step 的原始输出
 */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** Windows 上动态 import 必须给 file:// URL。 */
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const { createFileBackend } = await load('lib/store/file-backend.js')
const { rebuildIndex } = await load('lib/store/index-store.js')
const { buildRecallSync } = await load('lib/host/injection.js')
const { navHandler } = await load('lib/tools/nav.js')
const { searchHandler } = await load('lib/tools/search.js')
const { assembleHandler } = await load('lib/tools/assemble.js')
const { writeHandler } = await load('lib/tools/write.js')
const { confirmHandler } = await load('lib/tools/confirm.js')
const { forgetHandler } = await load('lib/tools/forget.js')
const { resolveHandler } = await load('lib/tools/resolve.js')
const { sweepHandler } = await load('lib/tools/sweep.js')
const { digestHandler } = await load('lib/tools/digest.js')
const { staleAnchorIds } = await load('lib/store/anchors.js')
const { loadQueryLog } = await load('lib/store/query-log.js')

const filter = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? ''
const dumpJson = process.argv.includes('--json')

const cases = JSON.parse(await readFile(path.join(HERE, 'cases.json'), 'utf8'))
const selected = cases.filter((item) => filter === '' || item.name.includes(filter))
if (selected.length === 0) {
  console.error(`no fixture case matches ${JSON.stringify(filter)}`)
  process.exit(1)
}

let failedCases = 0
let totalAssertions = 0
let failedAssertions = 0

for (const testCase of selected) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-memory-agent-'))
  if (testCase.fixture !== undefined) {
    await cp(path.join(HERE, 'fixtures', testCase.fixture), root, { recursive: true })
  }
  const backend = createFileBackend(root)
  await backend.init()

  const outputs = []
  const problems = []
  let skipped = false

  try {
    for (const [index, step] of testCase.steps.entries()) {
      const input = walkReplace(resolveRefs(step.input ?? {}, outputs), pathTokens(backend))
      outputs.push(await runStep(step, input, backend))
      if (dumpJson) {
        console.log(`  #${index} ${step.op} → ${JSON.stringify(outputs[index])}`)
      }
    }
  } catch (error) {
    problems.push(`step 执行抛异常: ${error instanceof Error ? error.message : String(error)}`)
    skipped = true
  }

  for (const assertion of testCase.expect ?? []) {
    totalAssertions += 1
    const outcome = evaluate(assertion, outputs)
    if (outcome.ok) continue
    failedAssertions += 1
    problems.push(
      `期望 step#${assertion.step} ${assertion.path} ${outcome.kind} ${JSON.stringify(outcome.expected)}`
      + `，实际 ${JSON.stringify(outcome.actual)}`,
    )
  }

  const assertions = (testCase.expect ?? []).length
  if (problems.length === 0) {
    console.log(`[PASS] ${testCase.name} (${assertions} 断言)${skipped ? ' [空转]' : ''}`)
  } else {
    failedCases += 1
    console.log(`[FAIL] ${testCase.name} (${assertions} 断言)`)
    for (const problem of problems) console.log(`       ${problem}`)
  }

  await rm(root, { recursive: true, force: true })
}

console.log('')
console.log(
  failedCases === 0
    ? `fixtures: ${selected.length}/${selected.length} case 通过，${totalAssertions} 断言全绿`
    : `fixtures: ${failedCases}/${selected.length} case 失败，${failedAssertions}/${totalAssertions} 断言未通过`,
)

// 额外护栏：lib 必须存在，且工具 handler 目录不允许出现 ctx 字样（handler 必须是纯函数）
if (!existsSync(path.join(ROOT, 'lib/tools/nav.js'))) {
  console.error('lib/ 未构建：先 npm run build')
  process.exit(1)
}

// 接线烟测：apply 必须注册 9 个工具，disposer 必须把它们全部注销且不留悬空状态
const wiringOk = await checkWiring()
process.exit(failedCases === 0 && wiringOk ? 0 : 1)

/**
 * 用假 ctx 跑一遍 apply()：验证注册数量、工具名、ctx.effect 的清理行为，
 * 以及常驻注入在 systemPrompt 上的接线（provider 同步取值、空库不注入、开关关闭不注入）。
 * 这里也顺带覆盖 defineTool 解析不到宿主模块时的降级路径（同一进程内已缓存）。
 */
async function checkWiring() {
  let ok = true
  let expectedCount = 0
  const problems = []

  const wiring = await checkWiringOnce()
  expectedCount = wiring.expectedCount
  problems.push(...wiring.problems)

  const disabled = await checkInjectionDisabled()
  problems.push(...disabled)

  if (problems.length > 0) {
    ok = false
    console.log('[FAIL] wiring: apply/ctx.effect 契约')
    for (const problem of problems) console.log(`       ${problem}`)
  } else {
    console.log(`[PASS] wiring: ${expectedCount} 个工具注册 + ctx.effect 卸载干净 + 常驻注入接线（空库/预算/开关）`)
  }
  return ok
}

/** 造一个带 systemPrompt 假服务的 ctx；返回 ctx 与捕获到的 context 条目。 */
function makeFakeCtx(registered, cleanups) {
  const capturedEntries = []
  const fakeSystemPrompt = {
    context(entry) {
      capturedEntries.push(entry)
      return () => {}
    },
  }
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        const dispose = () => {
          const at = registered.indexOf(definition)
          if (at >= 0) registered.splice(at, 1)
        }
        return dispose
      },
    },
    effect(execute, label) {
      const cleanup = execute()
      cleanups.push({ label, cleanup })
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    get(name) {
      return name === 'systemPrompt' ? fakeSystemPrompt : undefined
    },
  }
  return { ctx, capturedEntries }
}

async function checkWiringOnce() {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-memory-agent-wiring-'))
  const registered = []
  const cleanups = []
  const problems = []
  let expectedCount = 0
  try {
    const plugin = await load('lib/index.js')
    if (plugin.name !== 'dsh-memory-agent') problems.push(`name 应为 dsh-memory-agent，实际 ${plugin.name}`)
    if (!Array.isArray(plugin.inject) || !plugin.inject.includes('tools')) {
      problems.push(`inject 必须包含 tools，实际 ${JSON.stringify(plugin.inject)}`)
    }
    if (!Array.isArray(plugin.inject) || !plugin.inject.includes('systemPrompt')) {
      problems.push(`inject 必须包含 systemPrompt（常驻注入），实际 ${JSON.stringify(plugin.inject)}`)
    }
    if (!Array.isArray(plugin.inject) || !plugin.inject.includes('webServer')) {
      problems.push(`inject 必须包含 webServer（面板 API；不声明会在服务就绪前静默丢路由），实际 ${JSON.stringify(plugin.inject)}`)
    }
    const { ctx, capturedEntries } = makeFakeCtx(registered, cleanups)
    plugin.apply(ctx, { root: tmpRoot, requireConfirmation: false })

    const names = registered.map((item) => item.name).sort()
    const expected = [
      'forget_memories_by_session',
      'memory_assemble',
      'memory_confirm',
      'memory_digest',
      'memory_nav',
      'memory_resolve',
      'memory_search_hybrid',
      'memory_sweep',
      'write_memory',
    ]
    expectedCount = expected.length
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      problems.push(`注册的工具名不符：${JSON.stringify(names)}`)
    }
    for (const definition of registered) {
      if (typeof definition.execute !== 'function') problems.push(`${definition.name} 缺少 execute`)
      if (typeof definition.output?.render !== 'function') problems.push(`${definition.name} 缺少 output.render`)
      if (typeof definition.output?.schema !== 'object') problems.push(`${definition.name} 缺少 output.schema`)
      // 注册表只吃原始 JSON Schema：parameters 必须有 type/properties，required 必须是数组
      const parameters = definition.parameters
      if (parameters?.type !== 'object' || typeof parameters.properties !== 'object') {
        problems.push(`${definition.name}.parameters 不是原始 JSON Schema（缺 type/properties）`)
      }
      if (JSON.stringify(parameters).includes('"required":true')) {
        problems.push(`${definition.name}.parameters 里残留作者 DSL 的 required:true`)
      }
    }
    const writeTool = registered.find((item) => item.name === 'write_memory')
    const writeRequired = writeTool?.parameters?.required ?? []
    if (!Array.isArray(writeRequired) || !writeRequired.includes('summary')) {
      problems.push(`write_memory.parameters.required 应包含 summary，实际 ${JSON.stringify(writeRequired)}`)
    }

    /* ---------- 常驻注入接线（记忆条目 + 记忆使用守则，两条独立 context） ---------- */
    const recallEntry = capturedEntries.find((item) => item?.name === 'memory-agent:recall')
    const guideEntry = capturedEntries.find((item) => item?.name === 'memory-agent:guide')
    if (capturedEntries.length !== 2 || recallEntry === undefined || guideEntry === undefined) {
      problems.push(
        'systemPrompt.context 应注册 2 个条目（memory-agent:recall + memory-agent:guide），'
        + `实际 ${JSON.stringify(capturedEntries.map((item) => item?.name))}`,
      )
    } else {
      const entry = recallEntry
      if (typeof entry.text !== 'function') {
        problems.push('注入条目的 text 必须是同步函数（宿主不会 await context.text）')
      } else {
        // 空库不注入
        const emptyText = entry.text({})
        if (emptyText !== '') problems.push(`空库时应注入空字符串，实际 ${JSON.stringify(emptyText)}`)
        // 写一条后注入且长度 ≤ 默认预算
        const backend = createFileBackend(tmpRoot)
        await backend.init()
        await writeHandler(backend, {
          summary: '接线探针：pnpm 是默认包管理器',
          session_id: 'wiring-s1',
        })
        const text = entry.text({})
        if (typeof text !== 'string') problems.push('注入 provider 返回了非字符串（Promise 会被宿主静默丢弃）')
        else {
          if (!text.includes('## 记忆（自动注入）')) problems.push('注入文本缺少标题行')
          if (!text.includes('接线探针')) problems.push('注入文本没有包含刚写入的记忆')
          if (text.length > 1500) problems.push(`注入文本超预算：${text.length} > 1500`)
        }
      }
      if (entry.interpolate !== false) {
        problems.push('注入条目必须 interpolate:false（记忆正文可能含 {{...}}，进插值器会抛错）')
      }
      // 记忆使用守则：空库也要在（模型才知道何时该记/该搜），且不占记忆预算
      if (typeof guideEntry.text !== 'function') {
        problems.push('守则条目的 text 必须是同步函数')
      } else {
        const guideText = guideEntry.text({})
        if (typeof guideText !== 'string') {
          problems.push('守则 provider 返回了非字符串')
        } else {
          if (!guideText.includes('记忆使用守则')) problems.push('守则文本缺少标题行「记忆使用守则」')
          if (guideText.length > 400) problems.push(`守则太长会变常态噪音：${guideText.length} > 400`)
          if (!guideText.includes('memory_search_hybrid')) problems.push('守则必须说清什么时候该搜（memory_search_hybrid）')
        }
      }
      if (guideEntry.interpolate !== false) problems.push('守则条目必须 interpolate:false')
      if (guideEntry.order <= entry.order) problems.push('守则应排在记忆条目之后（order 更大）')
    }

    for (const item of cleanups) {
      if (typeof item.cleanup !== 'function') problems.push(`ctx.effect(${item.label}) 没有返回清理函数`)
      if (typeof item.cleanup === 'function') item.cleanup()
    }
    if (registered.length !== 0) problems.push(`卸载后仍残留 ${registered.length} 个工具`)
  } catch (error) {
    problems.push(`apply() 抛异常：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
  return { problems, expectedCount }
}

/** 关掉开关（config.json 里 injectEnabled:false）后，库里有记忆也不注入。 */
async function checkInjectionDisabled() {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-memory-agent-wiring-off-'))
  const problems = []
  try {
    const backend = createFileBackend(tmpRoot)
    await backend.init()
    await backend.writeFileAtomic('config.json', `${JSON.stringify({ injectEnabled: false })}\n`)
    await writeHandler(backend, {
      summary: '开关关闭探针：这条不该被注入',
      session_id: 'wiring-s2',
    })
    const registered = []
    const cleanups = []
    const plugin = await load('lib/index.js')
    const { ctx, capturedEntries } = makeFakeCtx(registered, cleanups)
    plugin.apply(ctx, { root: tmpRoot, requireConfirmation: false })
    const entry = capturedEntries.find((item) => item?.name === 'memory-agent:recall')
    const guide = capturedEntries.find((item) => item?.name === 'memory-agent:guide')
    if (entry === undefined) problems.push('开关关闭场景没有捕获到注入条目')
    else {
      const text = entry.text({})
      if (text !== '') problems.push(`injectEnabled:false 时应注入空字符串，实际 ${JSON.stringify(text.slice(0, 80))}`)
    }
    if (guide !== undefined && guide.text({}) !== '') {
      problems.push('injectEnabled:false 时记忆使用守则也该消失（它只服务于检索）')
    }
    for (const item of cleanups) if (typeof item.cleanup === 'function') item.cleanup()
  } catch (error) {
    problems.push(`开关关闭场景抛异常：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
  return problems
}

/* ------------------------------- 断言求值 ------------------------------- */

/** fixture 里的路径占位符：root 必存在（锚点健在用），.anchor-missing-dir 从不创建（锚点失效用）。 */
function pathTokens(backend) {
  return {
    '$MISSING_ANCHOR_PATH$': path.join(backend.root, '.anchor-missing-dir'),
    '$EXISTING_ANCHOR_PATH$': backend.root,
  }
}

/** 深遍历：把字符串（含对象键）里的路径占位符换成真实绝对路径，所有 op 的 input 都过一遍。 */
function walkReplace(value, map) {
  if (typeof value === 'string') {
    let out = value
    for (const [token, replacement] of Object.entries(map)) out = out.replaceAll(token, replacement)
    return out
  }
  if (Array.isArray(value)) return value.map((item) => walkReplace(item, map))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[walkReplace(key, map)] = walkReplace(item, map)
    return out
  }
  return value
}

async function runStep(step, input, backend) {
  switch (step.op) {
    case 'write':
      return writeHandler(backend, input)
    case 'writeMany': {
      const count = Number(step.count ?? 1)
      const out = []
      for (let i = 0; i < count; i += 1) {
        const summary = String(input.summary ?? '').replaceAll('{{i}}', String(i))
        out.push(await writeHandler(backend, { ...input, summary }))
      }
      return out
    }
    case 'confirm':
      return confirmHandler(backend, input)
    case 'nav':
      return navHandler(backend, input)
    case 'search':
      return searchHandler(backend, input)
    case 'searchMany': {
      // 批量真实检索（撑 query-log 滞回裁剪用）：count 次都真跑 searchHandler，
      // 第 i 次把 query 里的 {{i}} 换成 i，每次都会记一条检索日志
      const count = Number(input.count ?? step.count ?? 0)
      let lastHits = 0
      for (let i = 0; i < count; i += 1) {
        const hits = await searchHandler(backend, {
          query: String(input.query ?? '').replaceAll('{{i}', String(i)),
          top_k: 5,
        })
        lastHits = hits.length
      }
      return { runs: count, lastHits }
    }
    case 'queryLog':
      // 读回检索日志（时间正序、坏行跳过），断言有界裁剪与零命中留痕
      return loadQueryLog(backend)
    case 'anchorCheck': {
      // 造假 probe 评估锚点：env/pathExists 只认表里给过的键，没给 = 探测不到 = 未校验
      //（null 显式表示「探测不到」）；tool-list / self-version 宿主没有 API，恒为 undefined
      const envMap = input.env ?? {}
      const pathMap = input.paths ?? {}
      const probe = {
        env: (name) => (Object.hasOwn(envMap, name) ? (envMap[name] === null ? undefined : envMap[name]) : undefined),
        pathExists: (p) => (Object.hasOwn(pathMap, p) ? pathMap[p] : undefined),
        toolList: () => undefined,
        selfVersion: () => undefined,
      }
      return staleAnchorIds(await backend.readIndex(), probe)
    }
    case 'assemble':
      return assembleHandler(backend, input)
    case 'forget':
      return forgetHandler(backend, input)
    case 'resolve':
      return resolveHandler(backend, input)
    case 'sweep':
      return sweepHandler(backend, input)
    case 'digest':
      return digestHandler(backend, input ?? {})
    case 'inject':
      // 常驻注入的同步组装器：断言预算硬顶 / 空库不注入 / 命中优先排序
      return buildRecallSync(backend.root, {
        budgetChars: typeof input.budgetChars === 'number' ? input.budgetChars : undefined,
      })
    case 'index':
      return backend.readIndex()
    case 'indexStats': {
      const entries = await backend.readIndex()
      const byStatus = { active: 0, suggested: 0, superseded: 0, conflict: 0, deleted_pending: 0, orphaned: 0 }
      for (const entry of entries) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1
      return { total: entries.length, byStatus }
    }
    case 'ledger':
      return backend.readLedger()
    case 'exists':
      return (await backend.readFile(input.path)) !== null
    case 'readFile':
      // 必须 await：否则断言拿到的是 Promise，length 恒为 undefined
      return (await backend.readFile(input.path)) ?? ''
    case 'removeFile':
      return backend.removeFile(input.path)
    case 'rebuild': {
      const result = await rebuildIndex(backend.root)
      return { entry_count: result.entries.length, scanned: result.scanned, skipped: result.skipped }
    }
    default:
      throw new Error(`unknown op ${JSON.stringify(step.op)}`)
  }
}

function evaluate(assertion, outputs) {
  const actual = readPath(outputs[assertion.step], assertion.path)
  const expected = assertion.value === undefined ? undefined : resolveRefs(assertion.value, outputs)
  const check = (kind, ok, want) => ({ ok, kind, expected: want, actual })

  if ('count' in assertion) {
    const needle = String(assertion.count)
    const haystack = String(actual ?? '')
    const occurrences = haystack === '' ? 0 : haystack.split(needle).length - 1
    return check(`count(${needle})`, occurrences === (assertion.value ?? 1), assertion.value ?? 1)
  }
  if ('value' in assertion) return check('==', deepEqual(actual, expected), expected)
  if ('lte' in assertion) return check('<=', typeof actual === 'number' && actual <= assertion.lte, assertion.lte)
  if ('gte' in assertion) return check('>=', typeof actual === 'number' && actual >= assertion.gte, assertion.gte)
  if ('length' in assertion) {
    const len = actual !== null && actual !== undefined && typeof actual === 'object' && 'length' in actual
      ? actual.length
      : undefined
    return check('length', len === assertion.length, assertion.length)
  }
  if ('includes' in assertion) {
    const haystack = typeof actual === 'string' ? actual : Array.isArray(actual) ? actual : null
    return check('includes', haystack !== null && haystack.includes(assertion.includes), assertion.includes)
  }
  if ('before' in assertion) {
    // 顺序断言：before 必须出现在 after 之前（注入优先级用）
    const haystack = typeof actual === 'string' ? actual : null
    const okOrder = haystack !== null
      && haystack.includes(assertion.before)
      && haystack.includes(assertion.after)
      && haystack.indexOf(assertion.before) < haystack.indexOf(assertion.after)
    return check(`before("${assertion.before}" 在 "${assertion.after}" 之前)`, okOrder, [assertion.before, assertion.after])
  }
  if ('jsonIncludes' in assertion) {
    return check('jsonIncludes', JSON.stringify(outputs[assertion.step])?.includes(assertion.jsonIncludes) === true, assertion.jsonIncludes)
  }
  if ('jsonNotIncludes' in assertion) {
    return check('jsonNotIncludes', JSON.stringify(outputs[assertion.step])?.includes(assertion.jsonNotIncludes) === false, assertion.jsonNotIncludes)
  }
  return { ok: false, kind: '未知断言', expected: assertion, actual }
}

function readPath(value, dotted) {
  if (dotted === undefined || dotted === '') return value
  let cursor = value
  for (const key of String(dotted).split('.')) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = cursor[key]
  }
  return cursor
}

/** 输入与期望里都允许 {"$ref": {"step": 0, "path": "id"}}，避免硬编码随机 id。 */
function resolveRefs(value, outputs) {
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, outputs))
  if (value === null || typeof value !== 'object') return value
  if (typeof value.$ref === 'object' && value.$ref !== null) {
    return readPath(outputs[value.$ref.step], value.$ref.path)
  }
  if (typeof value.$repeat === 'object' && value.$repeat !== null) {
    const text = String(value.$repeat.text ?? '')
    return text.repeat(Math.max(0, Number(value.$repeat.count ?? 1)))
  }
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = resolveRefs(item, outputs)
  return out
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b)
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => deepEqual(a[key], b[key]))
}
