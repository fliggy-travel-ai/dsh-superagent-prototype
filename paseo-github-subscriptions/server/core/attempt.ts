/**
 * 一次启动尝试的生命周期。模块的启动是异步的，停止（或失败后的清理）可能发生在任意一次 await 之间：
 * 每次 await 之后调用 `check()`，取消后抛错；清理函数用 `add()` 登记，取消之后才登记的立即执行，
 * 所以钩子、订阅和定时器不会遗留。
 */
export class Attempt {
  cancelled = false;
  private readonly removers: Array<() => void> = [];

  check(): void {
    if (this.cancelled) throw new Error('已停止');
  }

  add(remove: () => void): void {
    if (this.cancelled) this.run(remove);
    else this.removers.push(remove);
  }

  cancel(): void {
    this.cancelled = true;
    for (const remove of this.removers.splice(0).reverse()) this.run(remove);
  }

  private run(remove: () => void) {
    try { remove(); } catch { /* 已移除 */ }
  }
}
