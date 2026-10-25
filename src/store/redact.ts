/**
 * 写入脱敏：把常见的密钥形态在**落盘前**替换掉。
 *
 * 为什么放在写入侧而不是读取侧：记忆是明文 markdown，一旦写进磁盘，
 * 之后任何进程、任何备份、任何云盘同步都能看到。落盘前打码才是真的挡住。
 *
 * 只处理「几乎可以确定是凭证」的形态（固定前缀、私钥块、URL 里的密码、身份证号），
 * 不碰手机号/邮箱——那通常是用户想记住的内容。宁可漏，也不要误伤。
 */

interface RedactionRule {
  kind: string
  pattern: RegExp
  /** 有捕获组时替换第几组（保留前后文）。 */
  group?: number
}

const RULES: RedactionRule[] = [
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi },
  // 连接串里的密码：scheme://user:password@host → 只打码 password
  { kind: 'url-password', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)([^@\s/]+)(@)/gi, group: 2 },
  { kind: 'id-card', pattern: /\b\d{17}[\dXx]\b/g },
]

export interface RedactionResult {
  text: string
  /** 命中的类别（去重保序），空数组表示没动过。 */
  kinds: string[]
}

/** 按要求把凭证类文本替换成 `[已脱敏:kind]`。 */
export function redactSecrets(text: string): RedactionResult {
  if (typeof text !== 'string' || text === '') return { text, kinds: [] }
  let output = text
  const kinds: string[] = []

  for (const rule of RULES) {
    const replaced = output.replace(rule.pattern, (...args) => {
      if (rule.group === undefined) return `[已脱敏:${rule.kind}]`
      // replace 回调：args[0] 是整段，args[1..] 是捕获组
      const groups = args.slice(1, args.length - 2) as string[]
      const target = groups[rule.group - 1] ?? ''
      if (target === '') return args[0] as string
      const withMask = groups.map((value, index) => (index === rule.group! - 1
        ? `[已脱敏:${rule.kind}]`
        : value)).join('')
      return withMask
    })
    if (replaced !== output) {
      if (!kinds.includes(rule.kind)) kinds.push(rule.kind)
      output = replaced
    }
  }

  return { text: output, kinds }
}
