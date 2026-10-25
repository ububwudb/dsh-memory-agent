/**
 * BM25 纯函数检索（无依赖、无 LLM、确定性可缓存）。
 *
 * 不是子串匹配：先切词，再用 TF-IDF 系的 BM25 打分。
 * - CJK 按「单字 + 相邻 2-gram」切分（中文没有空格，单字保召回、2-gram 保精度）
 * - 拉丁字母/数字按词切分，统一小写 + 轻量词形归一（复数/ing/ed）
 * - 停用词（中英各一小张表）直接丢，避免「的/是/the/of」把分数糊成一片
 * - content 与 keywords 两个字段分开加权（keywords 命中权重更高）
 */

/** 一条待检索文档。keywords 通常是 tags + entities。 */
export interface KeywordDoc {
  id: string
  content: string
  keywords?: string
}

/** 已经切好词的文档（缓存复用，省掉重复 tokenize）。 */
export interface TokenizedDoc {
  id: string
  content: string[]
  keywords: string[]
}

export interface Bm25Options {
  /** 词频饱和参数，默认 1.5 */
  k1?: number
  /** 长度归一参数，默认 0.75 */
  b?: number
  /** keywords 字段相对 content 的权重，默认 2 */
  keywordWeight?: number
}

export interface KeywordIndex {
  n: number
  avgdl: number
  df: Record<string, number>
  docs: Array<{ id: string; tf: Record<string, number>; dl: number }>
}

export const DEFAULT_K1 = 1.5
export const DEFAULT_B = 0.75
export const DEFAULT_KEYWORD_WEIGHT = 2

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const LATIN_PATTERN = /[a-z0-9]/
const MAX_TOKEN_LENGTH = 40

/** 英文停用词：极短、几乎不携带主题信息。 */
const EN_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'and', 'or', 'in', 'on', 'at', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that',
  'these', 'those', 'as', 'by', 'from', 'into', 'than', 'then', 'so', 'if', 'we',
  'you', 'they', 'i', 'me', 'my', 'our', 'your', 'their', 'not', 'no', 'do',
  'does', 'did', 'can', 'could', 'should', 'would', 'will', 'may', 'might',
])

/** 中文单字停用词：只是语法胶水，留着会把 BM25 拉平。 */
const ZH_STOPCHARS = new Set([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '有',
  '不', '我', '你', '他', '她', '它', '这', '那', '个', '些', '们', '之', '其',
  '为', '以', '到', '从', '对', '把', '被', '让', '给', '又', '很', '更', '最',
  '会', '能', '可', '需', '要', '着', '过', '得', '地', '啊', '吧', '呢', '吗',
])

/** 英文轻量词形归一：复数 / ing / ed。够用就好，不做完整 Porter。 */
export function stemLatin(word: string): string {
  if (word.length <= 4) return word
  if (word.endsWith('ies') && word.length > 5) return `${word.slice(0, -3)}y`
  if (word.endsWith('ing') && word.length > 6) return word.slice(0, -3)
  if (word.endsWith('ed') && word.length > 5) return word.slice(0, -2)
  if (word.endsWith('es') && word.length > 5) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 4) return word.slice(0, -1)
  return word
}

/** 单个 token 是否值得进索引。 */
export function isUsefulToken(token: string): boolean {
  if (token === '') return false
  if (EN_STOPWORDS.has(token)) return false
  if (token.length === 1 && ZH_STOPCHARS.has(token)) return false
  return true
}

/** 切词：CJK 单字 + 2-gram，拉丁按词（已做停用词与词形归一）。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lowered = text.toLowerCase()
  let latin = ''
  let cjk: string[] = []

  const flushLatin = (): void => {
    if (latin === '') return
    if (latin.length <= MAX_TOKEN_LENGTH) {
      const stemmed = stemLatin(latin)
      if (isUsefulToken(stemmed)) tokens.push(stemmed)
    }
    latin = ''
  }
  const flushCjk = (): void => {
    if (cjk.length === 0) return
    for (const char of cjk) if (isUsefulToken(char)) tokens.push(char)
    for (let i = 0; i + 1 < cjk.length; i += 1) {
      const gram = cjk[i] + cjk[i + 1]
      // 含停用字构成的 2-gram 基本是语法胶水（“的兜”“是互”），丢掉
      if (ZH_STOPCHARS.has(cjk[i]) || ZH_STOPCHARS.has(cjk[i + 1])) continue
      tokens.push(gram)
    }
    cjk = []
  }

  for (const char of lowered) {
    if (CJK_PATTERN.test(char)) {
      flushLatin()
      cjk.push(char)
      continue
    }
    if (LATIN_PATTERN.test(char)) {
      flushCjk()
      latin += char
      continue
    }
    flushLatin()
    flushCjk()
  }
  flushLatin()
  flushCjk()
  return tokens
}

/** 查询词去重且保序（避免单字与 2-gram 重复计分）。 */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of tokenize(query)) {
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

/** 把一条索引条目切成 content / keywords 两段 token（供缓存复用）。 */
export function tokenizeEntry(doc: KeywordDoc): TokenizedDoc {
  return {
    id: doc.id,
    content: tokenize(doc.content),
    keywords: tokenize(doc.keywords ?? ''),
  }
}

/** 建索引：TF 与文档长度按字段加权，DF 取 content∪keywords 的文档频次。 */
export function buildKeywordIndex(
  docs: readonly KeywordDoc[],
  options: Bm25Options = {},
): KeywordIndex {
  return buildKeywordIndexFromTokens(docs.map(tokenizeEntry), options)
}

/** 同上，但吃已经切好的 token（检索缓存走这条，避免重复切词）。 */
export function buildKeywordIndexFromTokens(
  docs: readonly TokenizedDoc[],
  options: Bm25Options = {},
): KeywordIndex {
  const keywordWeight = options.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT
  const df: Record<string, number> = {}
  const built: KeywordIndex['docs'] = []
  let totalLength = 0

  for (const doc of docs) {
    const tf: Record<string, number> = {}
    for (const token of doc.content) tf[token] = (tf[token] ?? 0) + 1
    for (const token of doc.keywords) tf[token] = (tf[token] ?? 0) + keywordWeight
    for (const token of Object.keys(tf)) df[token] = (df[token] ?? 0) + 1
    const dl = doc.content.length + keywordWeight * doc.keywords.length
    totalLength += dl
    built.push({ id: doc.id, tf, dl })
  }

  const n = built.length
  return {
    n,
    avgdl: n === 0 ? 0 : totalLength / n,
    df,
    docs: built,
  }
}

/** 单文档对单条查询的 BM25 分数。 */
export function bm25Score(
  index: KeywordIndex,
  doc: KeywordIndex['docs'][number],
  terms: readonly string[],
  options: Bm25Options = {},
): number {
  const k1 = options.k1 ?? DEFAULT_K1
  const b = options.b ?? DEFAULT_B
  const avgdl = index.avgdl > 0 ? index.avgdl : 1
  let score = 0
  for (const term of terms) {
    const tf = doc.tf[term]
    if (tf === undefined || tf === 0) continue
    const docFreq = index.df[term] ?? 0
    if (docFreq === 0) continue
    const idf = Math.log(1 + (index.n - docFreq + 0.5) / (docFreq + 0.5))
    const norm = 1 - b + b * (doc.dl / avgdl)
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * norm))
  }
  return score
}

/**
 * 强词：长度 >= 2 的 token（CJK 2-gram 或拉丁词）。
 *
 * 单字命中（「算力」命中「量子计算」的「算」）只能加分，不能单独构成命中：
 * 一旦查询里有强词，文档必须命中至少一个强词才算候选，否则中文单字会把
 * 一堆无关记忆拉进结果。
 */
export function isStrongTerm(term: string): boolean {
  return term.length >= 2
}

/** 低权重补充词（来自别名词表）。 */
export interface ScoreExtras {
  extraTerms?: readonly string[]
  extraWeight?: number
}

/**
 * 全库打分：返回 id → score（0 分不返回）。
 *
 * 两档命中：
 * - 原查询命中（强词规则生效）：正常分数，`reason=bm25`；
 * - 只有别名补充词命中：允许成命，但贡献按 `extraWeight` 打折（默认 0.5），
 *   上层会标 `reason=alias`，让人知道这是「推断出来的相关」而不是字面命中。
 */
export function bm25Scores(
  index: KeywordIndex,
  query: string,
  options: Bm25Options = {},
  extras: ScoreExtras = {},
): Map<string, number> {
  const terms = queryTerms(query)
  const out = new Map<string, number>()
  if (terms.length === 0) return out
  const termSet = new Set(terms)
  const extraTerms = (extras.extraTerms ?? []).filter((term) => !termSet.has(term))
  const extraWeight = extras.extraWeight ?? 0.5
  const strongTerms = terms.filter(isStrongTerm)

  for (const doc of index.docs) {
    const strongHit = strongTerms.length === 0
      || strongTerms.some((term) => (doc.tf[term] ?? 0) > 0)
    const aliasHit = !strongHit
      && extraTerms.some((term) => (doc.tf[term] ?? 0) > 0)
    if (!strongHit && !aliasHit) continue
    let score = bm25Score(index, doc, terms, options)
    if (extraTerms.length > 0) score += extraWeight * bm25Score(index, doc, extraTerms, options)
    if (score > 0) out.set(doc.id, score)
  }
  return out
}

/** 一行调用：建索引 + 打分 + 排序 + 截断。同分按 id 升序保证确定性。 */
export function rankDocuments(
  docs: readonly KeywordDoc[],
  query: string,
  limit: number,
  options: Bm25Options = {},
): Array<{ id: string; score: number }> {
  const index = buildKeywordIndex(docs, options)
  const scores = bm25Scores(index, query, options)
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => (b.score === a.score ? a.id.localeCompare(b.id) : b.score - a.score))
    .slice(0, Math.max(0, limit))
}

/** 保留 6 位小数，避免浮点抖动进入断言与缓存。 */
export function roundScore(score: number): number {
  return Math.round(score * 1e6) / 1e6
}
