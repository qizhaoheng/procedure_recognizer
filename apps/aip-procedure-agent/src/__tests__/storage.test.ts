import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import crypto from 'node:crypto';
import { taskDir, writeArtifact } from '../storage';

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
