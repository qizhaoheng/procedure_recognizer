import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import crypto from 'node:crypto';
import { claimTaskRun, releaseTaskRun, saveAgentTask, TaskRunConflictError, taskDir, writeArtifact } from '../storage';

test('serializes concurrent JSON writes without corrupting the destination', async () => {
  const taskId = `storage-test-${crypto.randomUUID()}`;
  try {
    await Promise.all(Array.from({ length: 30 }, (_, sequence) =>
      writeArtifact(taskId, 'task.json', { sequence, payload: 'x'.repeat(20_000) }),
    ));
    const stored = JSON.parse(await fs.readFile(`${taskDir(taskId)}\\task.json`, 'utf8'));
    assert.ok(stored.sequence >= 0 && stored.sequence < 30);
    assert.equal(stored.payload.length, 20_000);
  } finally {
    await fs.rm(taskDir(taskId), { recursive: true, force: true });
  }
});

// 跨进程并发保护。实测症状：dev server 与一次性脚本同跑一个任务，两边各持一份内存态
// 互相整份覆盖——模型调用成对重复、calls 计数往回退、procedure 记录凭空消失，
// 而两边都以为自己跑得好好的。进程内的 running Map 完全挡不住这种情况。
function bareTask(taskId: string): any {
  return {
    taskId, taskType: 'AGENT_AD2_RECOGNITION', taskName: 't', documents: [],
    status: 'CREATED', stage: 'UPLOAD', progress: 0, completedProcedures: 0, totalProcedures: 0,
    warningCount: 0, errorCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    pages: [], packages: [], procedures: [], steps: [], modelCalls: [],
  };
}

test('a live run by another owner blocks both claiming and writing', async () => {
  const taskId = `storage-test-${crypto.randomUUID()}`;
  try {
    const mine = bareTask(taskId);
    assert.equal(await claimTaskRun(mine, 'first'), true, '无人持有时应当claim成功');

    // 模拟另一个进程：直接把归属改成别人，心跳是新鲜的
    const foreign = JSON.parse(await fs.readFile(`${taskDir(taskId)}/task.json`, 'utf8'));
    foreign.activeRun = { owner: 'other-process:1234', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), description: 'theirs' };
    await fs.writeFile(`${taskDir(taskId)}/task.json`, JSON.stringify(foreign), 'utf8');

    const second = bareTask(taskId);
    assert.equal(await claimTaskRun(second, 'second'), false, '他人持有且心跳新鲜时不得claim');
    await assert.rejects(() => saveAgentTask(second), TaskRunConflictError, '不得覆盖他人进度');
  } finally {
    await fs.rm(taskDir(taskId), { recursive: true, force: true });
  }
});

test('a stale run can be taken over', async () => {
  const taskId = `storage-test-${crypto.randomUUID()}`;
  try {
    const seed = bareTask(taskId);
    await claimTaskRun(seed, 'seed');
    const stored = JSON.parse(await fs.readFile(`${taskDir(taskId)}/task.json`, 'utf8'));
    // 心跳停在 20 分钟前——持有进程已死，不能让任务永久锁死
    stored.activeRun = { owner: 'dead-process:999', startedAt: stored.activeRun.startedAt, heartbeatAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(), description: 'dead' };
    await fs.writeFile(`${taskDir(taskId)}/task.json`, JSON.stringify(stored), 'utf8');

    const taker = bareTask(taskId);
    assert.equal(await claimTaskRun(taker, 'takeover'), true, '心跳过期应当允许接管');
  } finally {
    await fs.rm(taskDir(taskId), { recursive: true, force: true });
  }
});

test('releasing clears ownership so the next runner can claim', async () => {
  const taskId = `storage-test-${crypto.randomUUID()}`;
  try {
    const first = bareTask(taskId);
    await claimTaskRun(first, 'first');
    await releaseTaskRun(first);
    const second = bareTask(taskId);
    assert.equal(await claimTaskRun(second, 'second'), true);
  } finally {
    await fs.rm(taskDir(taskId), { recursive: true, force: true });
  }
});

test('reading a task that carries someone else\'s run does not license overwriting it', async () => {
  // 这是最贴近真实的覆盖路径：另一个进程 read -> 改 -> save。read 会把持有者的
  // activeRun 一并读进来，若据此放行，正在跑的识别就会被整份覆盖。
  const taskId = `storage-test-${crypto.randomUUID()}`;
  try {
    const holder = bareTask(taskId);
    await claimTaskRun(holder, 'running recognition');
    const foreign = JSON.parse(await fs.readFile(`${taskDir(taskId)}/task.json`, 'utf8'));
    foreign.activeRun.owner = 'other-process:4321';
    foreign.activeRun.heartbeatAt = new Date().toISOString();
    await fs.writeFile(`${taskDir(taskId)}/task.json`, JSON.stringify(foreign), 'utf8');

    // 模拟另一进程：读到的 task 带着对方的 activeRun，然后改点东西再存
    const reader = JSON.parse(await fs.readFile(`${taskDir(taskId)}/task.json`, 'utf8'));
    reader.taskName = 'edited elsewhere';
    await assert.rejects(() => saveAgentTask(reader), TaskRunConflictError, '带着对方的 activeRun 也不得覆盖');

    const onDisk = JSON.parse(await fs.readFile(`${taskDir(taskId)}/task.json`, 'utf8'));
    assert.notEqual(onDisk.taskName, 'edited elsewhere', '磁盘上的内容必须保持原样');
  } finally {
    await fs.rm(taskDir(taskId), { recursive: true, force: true });
  }
});
