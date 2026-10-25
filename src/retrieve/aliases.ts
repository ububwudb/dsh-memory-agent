/**
 * 别名词表：没有向量检索时，这是最便宜、最可控的「语义桥」。
 *
 * 为什么有用：BM25 的失败模式不是排序差，而是**词汇不重合**——
 * 库里写的是「sqlite / postgres」，用户问的是「数据库连的哪个」；
 * 库里写的是「verify.sh」，用户问的是「上线前检查什么」。这两类零命中占实际体验里的大头。
 *
 * 做法：查询里命中某个别名组（中文按子串、英文按词），就把同组其它词作为**低权重补充项**
 * 参与打分（权重 0.5），并允许它们构成命中（结果标 reason=alias 让你知道这是推断出来的）。
 *
 * 表可以用 `<root>/aliases.json` 覆盖：`{ "组名": ["词1", "词2"] }`，和内置表合并。
 */

/** 内置别名组：覆盖开发/运维场景里最常出现的「同义与上位词」。 */
export const DEFAULT_ALIAS_GROUPS: Record<string, readonly string[]> = {
  包管理器: ['npm', 'pnpm', 'yarn', 'pip', 'cargo', 'poetry', 'dependency', 'dependencies', 'deps'],
  数据库: ['sql', 'sqlite', 'postgres', 'postgresql', 'mysql', 'mongo', 'mongodb', 'redis', 'db'],
  缓存: ['cache', 'redis', 'memcached'],
  搜索: ['search', 'query', 'bm25', '检索', '查询'],
  检查: ['test', 'tests', 'verify', 'check', 'lint', 'smoke', '校验', '测试', '自检'],
  部署: ['deploy', 'release', 'publish', '上线', '发布', '灰度'],
  配置: ['config', 'configuration', 'settings', 'env', '环境变量'],
  报错: ['error', 'exception', 'bug', 'failed', 'failure', '报错', '异常'],
  性能: ['performance', 'latency', 'slow', 'timeout', '延迟', '慢', '超时'],
  图片: ['image', 'img', 'avatar', '图片', '头像'],
  文件: ['file', 'files', 'upload', 'oss', 's3', '对象存储', '上传', '文件'],
  记忆: ['memory', 'remember', 'memories', '记忆', '记住'],
  接口: ['api', 'endpoint', 'route', '接口'],
  日志: ['log', 'logs', 'logging', '日志'],
}

/** 别名补充项的分数权重：低权重，只在没有更好选择时起作用。 */
export const ALIAS_TERM_WEIGHT = 0.5

export interface AliasTable {
  /** 组名 → 词列表（含同组全部词） */
  groups: Record<string, readonly string[]>
  source: 'builtin' | 'builtin+file'
}

export interface AliasExpansion {
  /** 参与打分的补充词（已小写、去重、去掉原查询里已有的） */
  extraTerms: string[]
  /** 命中的别名组名，用于调试与引导文案 */
  matchedGroups: string[]
}

/** 合并内置表与用户表。 */
export function mergeAliasGroups(
  fileGroups: Record<string, readonly string[]> | undefined,
): AliasTable {
  if (fileGroups === undefined || Object.keys(fileGroups).length === 0) {
    return { groups: DEFAULT_ALIAS_GROUPS, source: 'builtin' }
  }
  const merged: Record<string, readonly string[]> = { ...DEFAULT_ALIAS_GROUPS }
  for (const [group, words] of Object.entries(fileGroups)) {
    if (!Array.isArray(words)) continue
    const clean = words
      .filter((word): word is string => typeof word === 'string')
      .map((word) => word.trim().toLowerCase())
      .filter((word) => word !== '')
    if (clean.length === 0) continue
    const existing = new Set([group.toLowerCase(), ...(merged[group] ?? [])])
    for (const word of clean) existing.add(word)
    merged[group] = [...existing]
  }
  return { groups: merged, source: 'builtin+file' }
}

/**
 * 把查询扩展成补充词。
 * 中文按子串命中（「数据库连的哪个」包含「数据库」），英文按词命中（避免 `db` 撞 `dbms` 之类）。
 */
export function expandAliases(
  query: string,
  table: AliasTable,
  alreadyHave: ReadonlySet<string> = new Set(),
): AliasExpansion {
  const lowered = query.toLowerCase()
  const matchedGroups: string[] = []
  const extraTerms: string[] = []
  const seen = new Set<string>()

  for (const [group, words] of Object.entries(table.groups)) {
    const members = [group.toLowerCase(), ...words.map((word) => word.toLowerCase())]
    const hit = members.some((member) => matchesSurface(lowered, member))
    if (!hit) continue
    matchedGroups.push(group)
    for (const member of members) {
      if (alreadyHave.has(member) || seen.has(member)) continue
      if (matchesSurface(lowered, member)) continue // 查询里本来就有的词不重复加
      seen.add(member)
      extraTerms.push(member)
    }
  }

  return { extraTerms, matchedGroups }
}

function matchesSurface(loweredQuery: string, term: string): boolean {
  if (term === '') return false
  if (/^[a-z0-9][a-z0-9._-]*$/.test(term)) {
    // 英文：词边界匹配
    const pattern = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`)
    return pattern.test(loweredQuery)
  }
  return loweredQuery.includes(term)
}
