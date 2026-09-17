/**
 * dsh-qqbot-bridge: Per-peer 串行发送队列
 *
 * 正文回复、提问交互、审批通知与文件传输均经由同一条串行队列下发，
 * 避免网络并发导致的消息乱序问题。每个 openid 独立维护异步执行链。
 */

import type { SerialSender } from '../types/index.js';

/**
 * 按 peer 串行化异步任务的发送器。
 * - 同一 peer 的 enqueue 任务严格按入队顺序执行；
 * - 不同 peer 之间互不阻塞；
 * - 单个任务 reject 只影响其调用方，串行链继续推进。
 */
export class PerPeerSerialSender implements SerialSender {
  private chains = new Map<string, Promise<unknown>>();

  enqueue<T>(peer: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(peer) ?? Promise.resolve();
    const run = prev.then(() => task());
    // 链上以"已消化结果"的 promise 接续，保证前置任务 reject 也不阻塞后续任务
    this.chains.set(
      peer,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  /** 清空全部队列（dispose 时调用；队列中未完成任务的调用方仍会收到对应结果/错误） */
  clear(): void {
    this.chains.clear();
  }
}