import type {
  AiInputPackage,
  AiInputPage,
  ProcedureGroup,
  SupportingInfoRef,
} from '../../types/procedure';

export type PromptPackageType = 'SID' | 'STAR' | 'APPROACH' | 'GENERIC';
export type PromptTemplateStatus = 'DRAFT' | 'ACTIVE' | 'DEPRECATED';

export interface PromptTemplate {
  id: string;
  name: string;
  version: string;
  packageType: PromptPackageType;
  navigationTypes: string[];
  templatePath: string;
  examplePath?: string;
  outputSchemaName: string;
  outputSchemaVersion: string;
  status: PromptTemplateStatus;
  description?: string;
  changelog?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProcedurePackage = ProcedureGroup;

export interface BuildPromptInput {
  taskId: string;
  packageId: string;
  procedurePackage: ProcedurePackage;
  aiInputPackage: AiInputPackage;
  templateOverrideId?: string;
}

export interface BuiltPrompt {
  promptTemplateId: string;
  promptTemplateName: string;
  promptVersion: string;
  outputSchemaName: string;
  outputSchemaVersion: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: unknown;
  inputImages: AiInputPage[];
  supportSummaries: SupportingInfoRef[];
  excludedSupport: SupportingInfoRef[];
  renderedAt: string;
}

export interface PromptRunRecord {
  runId: string;
  taskId: string;
  packageId: string;
  model: string;
  promptTemplateId: string;
  promptVersion: string;
  outputSchemaName: string;
  outputSchemaVersion: string;
  inputPackageHash: string;
  renderedPrompt: {
    systemPrompt: string;
    userPrompt: string;
  };
  createdAt: string;
}
