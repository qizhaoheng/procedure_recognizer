import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';

const contractDir = path.dirname(fileURLToPath(import.meta.url));
const validatorPromises = new Map<string, Promise<ValidateFunction>>();
const SCHEMA_FILE_BY_ID: Record<string, string> = {
  'recognition-v2-model-page-layout.schema.json': 'model-page-layout.schema.json',
  'recognition-v2-model-procedure-identity.schema.json': 'model-procedure-identity.schema.json',
};

export class RecognitionV2ContractError extends Error {
  constructor(public readonly schemaId: string, public readonly errors: unknown[]) {
    super(`Recognition V2 ${schemaId} failed contract validation: ${JSON.stringify(errors)}`);
    this.name = 'RecognitionV2ContractError';
  }
}

export async function assertValidRunManifest(value: unknown): Promise<void> {
  await assertSchema('recognition-v2-run-manifest.schema.json', value);
}

export async function assertValidPageLayoutResult(value: unknown): Promise<void> {
  await assertSchema('recognition-v2-page-layout-result.schema.json', value);
}

export async function assertValidPageLayoutStageResult(value: unknown): Promise<void> {
  await assertSchema('recognition-v2-page-layout-stage-result.schema.json', value);
}

export async function assertValidExtractionStageResult(value: unknown): Promise<void> {
  await assertSchema('recognition-v2-extraction-stage-result.schema.json', value);
}

export async function assertValidModelPageLayout(value: unknown): Promise<void> {
  await assertSchema('recognition-v2-model-page-layout.schema.json', value);
}

export async function assertValidModelProcedureIdentity(value: unknown): Promise<void> {
  await assertSchema('recognition-v2-model-procedure-identity.schema.json', value);
}

export async function readRecognitionV2Schema(schemaId: string): Promise<Record<string, unknown>> {
  return readSchema(schemaId);
}

async function assertSchema(schemaId: string, value: unknown) {
  const validate = await validatorFor(schemaId);
  if (!validate(value)) throw new RecognitionV2ContractError(schemaId, validate.errors ?? []);
}

async function validatorFor(schemaId: string) {
  let promise = validatorPromises.get(schemaId);
  if (!promise) {
    promise = buildValidator(schemaId);
    validatorPromises.set(schemaId, promise);
  }
  return promise;
}

async function buildValidator(schemaId: string) {
  const schemaNames = [
    'common.schema.json',
    'run-manifest.schema.json',
    'page-layout-result.schema.json',
    'page-layout-stage-result.schema.json',
    'extraction-stage-result.schema.json',
    'model-page-layout.schema.json',
    'model-procedure-identity.schema.json',
  ];
  const schemas = await Promise.all(schemaNames.map(readSchema));
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  for (const schema of schemas) ajv.addSchema(schema);
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`Recognition V2 schema not found: ${schemaId}`);
  return validate;
}

async function readSchema(fileName: string) {
  const resourceFile = SCHEMA_FILE_BY_ID[fileName] ?? fileName;
  return JSON.parse(await fs.readFile(path.join(contractDir, 'schemas', resourceFile), 'utf8'));
}
