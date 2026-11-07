// 预览用：替代 @getpaseo/plugin 根入口的运行时部分（合约定义原样返回）。
export function defineRpc<T>(definition: T): T {
  return definition;
}
export function defineSubscription<T>(definition: T): T {
  return definition;
}
