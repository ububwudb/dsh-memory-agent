/**
 * 向量化的「可插拔 provider」。
 *
 * 为什么是 HTTP 而不是本地模型：实测本地 transformers.js + 多语言模型要 120MB+、
 * CPU 每条 50-200ms、冷启动更慢——这三样都直接伤害体验。HTTP embedding（硅基流动
 * bge-m3 / 任意 OpenAI 兼容端点 / 本地 Ollama）质量更好、零体积、延迟可接受。
 *
 * 设计约束：
 * - provider 只是 `(texts) => number[][]` 这样一个函数，方便 fixture 注入假实现；
 * - 失败必须静默降级（超时/断网/401 都不能让检索和写入挂掉），由调用方决定记不记 ledger。
 */

/** 批量向量化。实现方负责超时与错误抛出，调用方负责降级。 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>

export interface HttpEmbeddingOptions {
  baseUrl: string
  apiKey: string
  model: string
  /** 单次请求超时，默认 5s。 */
  timeoutMs?: number
  /** 一次最多送几条，默认 32。 */
  batchSize?: number
}

export interface EmbeddingProbe {
  ok: boolean
  dim?: number
  latencyMs?: number
  error?: string
}

/** 把用户填的 baseUrl 规整成「不带尾斜杠、不含 /embeddings」的形式。 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim()
  while (url.endsWith('/')) url = url.slice(0, -1)
  if (url.endsWith('/embeddings')) url = url.slice(0, -'/embeddings'.length)
  return url
}

/**
 * 创建一个 OpenAI 兼容的 embedding 函数。
 * 任意实现了 `POST {baseUrl}/embeddings` 的服务都能接（硅基流动、Ollama、vLLM、智谱…）。
 */
export function createHttpEmbedder(options: HttpEmbeddingOptions): EmbedFn {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const batchSize = Math.max(1, options.batchSize ?? 32)
  const timeoutMs = options.timeoutMs ?? 5000

  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return []
    const out: number[][] = []
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize)
      const vectors = await requestBatch(baseUrl, options.apiKey, options.model, batch, timeoutMs)
      out.push(...vectors)
    }
    return out
  }
}

async function requestBatch(
  baseUrl: string,
  apiKey: string,
  model: string,
  texts: string[],
  timeoutMs: number,
): Promise<number[][]> {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer = controller === undefined
    ? undefined
    : setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({ model, input: texts }),
      signal: controller === undefined ? undefined : controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`embedding HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 160)}`}`)
    }
    const body = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }> }
    const rows = body.data ?? []
    if (rows.length !== texts.length) {
      throw new Error(`embedding 返回条数不符：要 ${texts.length} 条，拿到 ${rows.length} 条`)
    }
    // 有些服务不保证顺序，按 index 归位
    const ordered = new Array<number[]>(texts.length)
    rows.forEach((row, position) => {
      const index = typeof row.index === 'number' ? row.index : position
      if (index < 0 || index >= texts.length) return
      ordered[index] = row.embedding ?? []
    })
    return ordered.map((row) => row ?? [])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 「测试连接」：发一条极短文本，确认 key/模型/维度都对。 */
export async function probeEmbedding(options: HttpEmbeddingOptions): Promise<EmbeddingProbe> {
  const startedAt = Date.now()
  try {
    const embed = createHttpEmbedder({ ...options, timeoutMs: options.timeoutMs ?? 8000 })
    const [vector] = await embed(['连接测试'])
    if (vector === undefined || vector.length === 0) {
      return { ok: false, error: '返回了空向量' }
    }
    return { ok: true, dim: vector.length, latencyMs: Date.now() - startedAt }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
