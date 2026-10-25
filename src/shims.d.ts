/**
 * 宿主模块的最小类型声明。
 *
 * @deepseek-ai/* 的类型包只作为 devDependency/peerDependency 存在，
 * 运行时由 DSH 宿主提供；安装目录里发布产物不带 .d.ts，因此这里声明
 * 本插件真正用到的那一小部分签名，避免为了类型去拉一整套框架依赖。
 */
declare module '@deepseek-ai/dsh-tools' {
  /**
   * 构建类型化工具定义。注册表只要求 `{ output: { schema, render }, execute }`，
   * 这里保持宽松签名：传入什么形状，就返回什么形状。
   */
  export function defineTool<T extends object>(definition: T): T
}
