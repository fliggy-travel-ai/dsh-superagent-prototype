// 客户端用到的 React Native 全局类型里，AbortSignal 没有 timeout() 和 any()。
// 服务端运行在 Node 上，两个方法都有；复制来的上游文件和通知模块都在用。
export {};
declare global {
  namespace AbortSignal {
    function timeout(milliseconds: number): AbortSignal;
    function any(signals: AbortSignal[]): AbortSignal;
  }
}
