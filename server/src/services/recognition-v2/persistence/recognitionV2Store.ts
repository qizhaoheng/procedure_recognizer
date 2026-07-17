import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getTaskRoot } from '../../../storage/taskStore';
import type { RecognitionV2RunManifest } from '../contracts/index';
import { assertValidRunManifest } from '../contracts/schemaValidation';
import { createInitialManifest, failStage } from '../orchestration/stateMachine';

const MANIFEST_FILE = 'manifest.json';
const ARTIFACTS_DIR = 'artifacts';

export class RecognitionV2Store {
  private readonly updateQueues = new Map<string, Promise<void>>();

  constructor(private readonly taskRoot: string) {}

  async createRun(input: {
    taskId: string;
    packageId: string;
    sourcePackageHash: string;
    runId?: string;
    now?: string;
  }): Promise<RecognitionV2RunManifest> {
    const runId = input.runId ?? `v2_run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const manifest = createInitialManifest({ ...input, runId });
    await assertValidRunManifest(manifest);
    const runDir = this.runDir(input.taskId, input.packageId, runId);
    await fs.mkdir(path.join(runDir, ARTIFACTS_DIR), { recursive: true });
    await this.atomicWriteJson(path.join(runDir, MANIFEST_FILE), manifest);
    return manifest;
  }

  async readRun(taskId: string, packageId: string, runId: string): Promise<RecognitionV2RunManifest> {
    const text = await fs.readFile(this.manifestPath(taskId, packageId, runId), 'utf8');
    const manifest: unknown = JSON.parse(text);
    await assertValidRunManifest(manifest);
    return manifest as RecognitionV2RunManifest;
  }

  async listRuns(taskId: string, packageId: string): Promise<RecognitionV2RunManifest[]> {
    const packageDir = this.packageDir(taskId, packageId);
    const entries = await fs.readdir(packageDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const manifests = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readRun(taskId, packageId, decodeSegment(entry.name)).catch(() => undefined)));
    return manifests
      .filter((item): item is RecognitionV2RunManifest => Boolean(item))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async recoverInterruptedRuns(nowValue?: string) {
    const recovered: Array<{
      taskId: string;
      packageId: string;
      runId: string;
      stage: string;
      sourcePackageHash: string;
      updatedAt: string;
    }> = [];
    const errors: Array<{ path: string; message: string }> = [];
    const taskEntries = await fs.readdir(this.taskRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const taskEntry of taskEntries.filter((entry) => entry.isDirectory())) {
      const taskId = decodeSegment(taskEntry.name);
      const v2Root = path.join(this.taskRoot, taskEntry.name, 'recognition-v2');
      const packageEntries = await fs.readdir(v2Root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const packageEntry of packageEntries.filter((entry) => entry.isDirectory())) {
        const packageId = decodeSegment(packageEntry.name);
        const runEntries = await fs.readdir(path.join(v2Root, packageEntry.name), { withFileTypes: true });
        for (const runEntry of runEntries.filter((entry) => entry.isDirectory())) {
          const runId = decodeSegment(runEntry.name);
          try {
            const manifest = await this.readRun(taskId, packageId, runId);
            const runningStage = manifest.stages.find((stage) => stage.status === 'RUNNING');
            if (!runningStage) continue;
            const updated = await this.updateRun(taskId, packageId, runId, (current) => failStage(current, runningStage.stage, {
              code: 'SERVICE_RESTARTED',
              message: 'Recognition V2 stage was interrupted by a service restart and can be retried.',
              retryable: true,
              now: nowValue,
            }));
            recovered.push({
              taskId,
              packageId,
              runId,
              stage: runningStage.stage,
              sourcePackageHash: updated.sourcePackageHash,
              updatedAt: updated.updatedAt,
            });
          } catch (error) {
            errors.push({
              path: path.join(v2Root, packageEntry.name, runEntry.name),
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
    return { recovered, errors };
  }

  async updateRun(
    taskId: string,
    packageId: string,
    runId: string,
    updater: (manifest: RecognitionV2RunManifest) => RecognitionV2RunManifest | Promise<RecognitionV2RunManifest>,
  ): Promise<RecognitionV2RunManifest> {
    const key = `${taskId}\u0000${packageId}\u0000${runId}`;
    return this.withUpdateLock(key, async () => {
      const current = await this.readRun(taskId, packageId, runId);
      const updated = await updater(current);
      if (updated.runId !== current.runId || updated.taskId !== current.taskId || updated.packageId !== current.packageId) {
        throw new Error('Recognition V2 manifest identity cannot be changed during an update.');
      }
      await assertValidRunManifest(updated);
      await this.atomicWriteJson(this.manifestPath(taskId, packageId, runId), updated);
      return updated;
    });
  }

  async writeArtifact(
    taskId: string,
    packageId: string,
    runId: string,
    fileName: string,
    value: unknown,
  ): Promise<string> {
    const safeName = artifactFileName(fileName);
    const relativeRef = `${ARTIFACTS_DIR}/${safeName}`;
    const target = path.join(this.runDir(taskId, packageId, runId), ARTIFACTS_DIR, safeName);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.atomicWriteJson(target, value);
    return relativeRef;
  }

  async readArtifact<T>(taskId: string, packageId: string, runId: string, artifactRef: string): Promise<T> {
    const normalized = artifactRef.replace(/\\/g, '/');
    if (!/^artifacts\/[a-z0-9][a-z0-9._-]*\.json$/i.test(normalized)) {
      throw new Error(`Invalid Recognition V2 artifact reference: ${artifactRef}`);
    }
    const filePath = path.join(this.runDir(taskId, packageId, runId), ...normalized.split('/'));
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  }

  async readPackageArtifact<T>(taskId: string, packageId: string, fileName: string): Promise<T> {
    const safeName = artifactFileName(fileName);
    return JSON.parse(await fs.readFile(path.join(this.packageDir(taskId, packageId), safeName), 'utf8')) as T;
  }

  async updatePackageArtifact<T>(
    taskId: string,
    packageId: string,
    fileName: string,
    updater: (current: T | undefined) => T | Promise<T>,
  ): Promise<T> {
    const safeName = artifactFileName(fileName);
    const target = path.join(this.packageDir(taskId, packageId), safeName);
    return this.withUpdateLock(`package-artifact\u0000${taskId}\u0000${packageId}\u0000${safeName}`, async () => {
      const current = await fs.readFile(target, 'utf8').then((text) => JSON.parse(text) as T).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      const updated = await updater(current);
      await this.atomicWriteJson(target, updated);
      return updated;
    });
  }

  runReference(taskId: string, packageId: string, runId: string) {
    return path.posix.join('recognition-v2', encodeSegment(packageId), encodeSegment(runId), MANIFEST_FILE);
  }

  private packageDir(taskId: string, packageId: string) {
    return path.join(this.taskDir(taskId), 'recognition-v2', encodeSegment(packageId));
  }

  private runDir(taskId: string, packageId: string, runId: string) {
    return path.join(this.packageDir(taskId, packageId), encodeSegment(runId));
  }

  private manifestPath(taskId: string, packageId: string, runId: string) {
    return path.join(this.runDir(taskId, packageId, runId), MANIFEST_FILE);
  }

  private taskDir(taskId: string) {
    return path.join(this.taskRoot, encodeSegment(taskId));
  }

  private async atomicWriteJson(filePath: string, value: unknown) {
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async withUpdateLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.updateQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.updateQueues.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.updateQueues.get(key) === tail) this.updateQueues.delete(key);
    }
  }
}

export const recognitionV2Store = new RecognitionV2Store(getTaskRoot());

function encodeSegment(value: string) {
  const text = String(value ?? '').trim();
  if (!text || text === '.' || text === '..') throw new Error('Invalid empty or relative path identifier.');
  return encodeURIComponent(text);
}

function decodeSegment(value: string) {
  return decodeURIComponent(value);
}

function artifactFileName(value: string) {
  const text = String(value ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/i.test(text)) {
    throw new Error(`Invalid Recognition V2 artifact file name: ${value}`);
  }
  return text;
}
