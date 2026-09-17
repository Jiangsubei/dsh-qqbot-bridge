/**
 * 契约测试：per-peer 串行发送器（`SerialSender`，N7）
 *
 * 验收语义（task-2 第 7 条）：
 *   1. 同一 peer 的任务严格按入队顺序执行（不允许并发乱序）；
 *   2. 不同 peer 之间互不阻塞（peer A 挂住时 peer B 仍能完成）；
 *   3. **单个任务 reject 不阻塞后续任务**（串行链必须"消化"失败）；
 *   4. 返回值与异常如实透传给各自的调用方；
 *   5. `clear()` 后可继续正常入队。
 *
 * 复用来源：`~/dsh-napcat-bridge/src/outbound/queue.ts:16-37`（PerPeerSerialSender）。
 */

import { describe, it, expect } from 'vitest';
import { PerPeerSerialSender } from '../../src/outbound/queue.js';

/** 手写可控延迟（不 mock 计时器，避免与被测实现的微任务顺序耦合） */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('PerPeerSerialSender（N7 per-peer 单 Promise 链）', () => {
  it('同一 peer 的任务严格按入队顺序执行，且不并发重入', async () => {
    const sender = new PerPeerSerialSender();
    const events: string[] = [];
    let running = 0;
    let maxConcurrent = 0;

    const task = (name: string, delayMs: number) => async (): Promise<string> => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      events.push(`${name}:start`);
      await sleep(delayMs);
      events.push(`${name}:end`);
      running -= 1;
      return name;
    };

    // 故意让第一个任务最慢：并发的实现会先出现 b:start
    const a = sender.enqueue('peer-1', task('a', 30));
    const b = sender.enqueue('peer-1', task('b', 1));
    const c = sender.enqueue('peer-1', task('c', 1));

    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    // 串行链内任意时刻只有一个任务在跑（关键：不是 Promise.all 并发）
    expect(maxConcurrent).toBe(1);
  });

  it('不同 peer 之间互不阻塞', async () => {
    const sender = new PerPeerSerialSender();
    const order: string[] = [];
    let releaseA: () => void = () => undefined;

    const aHeld = sender.enqueue('peer-A', async () => {
      await new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      order.push('A');
    });
    const bDone = sender.enqueue('peer-B', async () => {
      order.push('B');
    });

    // peer-B 与 peer-A 无先后关系：B 必须在 A 释放前完成
    await bDone;
    expect(order).toEqual(['B']);

    releaseA();
    await aHeld;
    expect(order).toEqual(['B', 'A']);
  });

  it('单个任务 reject 不阻塞后续任务，且异常如实透传给该调用方', async () => {
    const sender = new PerPeerSerialSender();
    const executed: string[] = [];

    const failing = sender.enqueue('peer-1', async () => {
      executed.push('failing');
      throw new Error('boom');
    });
    const next = sender.enqueue('peer-1', async () => {
      executed.push('next');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    // 关键断言：后续任务仍然执行（链接续用的是"已消化"的 promise）
    expect(await next).toBe('ok');
    expect(executed).toEqual(['failing', 'next']);
  });

  it('同步抛出的任务同样不阻塞后续任务', async () => {
    const sender = new PerPeerSerialSender();
    const first = sender.enqueue('peer-1', () => {
      throw new Error('sync-boom');
    });
    const second = sender.enqueue('peer-1', async () => 'survived');

    await expect(first).rejects.toThrow('sync-boom');
    expect(await second).toBe('survived');
  });

  it('clear() 清空队列后仍可正常入队', async () => {
    const sender = new PerPeerSerialSender();
    let release: () => void = () => undefined;
    void sender.enqueue('peer-1', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    sender.clear();
    expect(await sender.enqueue('peer-1', async () => 'after-clear')).toBe('after-clear');
    release();
  });
});