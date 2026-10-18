import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { z } from "zod/v4";

export const OPERATIONS = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentHighlight",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "typeDefinition",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "diagnostics",
  "workspaceDiagnostics",
  "signatureHelp",
  "rename",
  "prepareRename",
  "foldingRange",
  "codeAction",
  "setBreakpoint",
] as const;

export const SEVERITY_FILTERS = ["all", "error", "warning", "info", "hint"] as const;

export type Operation = (typeof OPERATIONS)[number];

const positiveInt = (description: string) => z
  .number()
  .int()
  .positive()
  .describe(description);

const filePathField = z.string().min(1).describe("Absolute or relative path to the file.");
const severityField = z.enum(SEVERITY_FILTERS).optional()
  .describe('Filter diagnostics: "all" | "error" | "warning" | "info" | "hint".');

const positionSchema = {
  line: positiveInt("1-based line number."),
  character: positiveInt("1-based character offset."),
};

const positionedFileOperation = <T extends Operation>(operation: T) => z.strictObject({
  operation: z.literal(operation),
  filePath: filePathField,
  ...positionSchema,
});

const documentSymbolSchema = z.strictObject({
  operation: z.literal("documentSymbol"),
  filePath: filePathField,
});

const workspaceSymbolSchema = z.strictObject({
  operation: z.literal("workspaceSymbol"),
  filePath: filePathField,
});

const diagnosticsSchema = z.strictObject({
  operation: z.literal("diagnostics"),
  filePath: filePathField,
  severity: severityField,
});

const workspaceDiagnosticsSchema = z.strictObject({
  operation: z.literal("workspaceDiagnostics"),
  filePaths: z.array(filePathField).min(1).describe("File paths for workspaceDiagnostics."),
  severity: severityField,
});

const signatureHelpSchema = z.strictObject({
  operation: z.literal("signatureHelp"),
  filePath: filePathField,
  ...positionSchema,
});

const renameSchema = z.strictObject({
  operation: z.literal("rename"),
  filePath: filePathField,
  ...positionSchema,
  newName: z.string().min(1).describe("New symbol name for rename."),
});

const prepareRenameSchema = z.strictObject({
  operation: z.literal("prepareRename"),
  filePath: filePathField,
  ...positionSchema,
});

const foldingRangeSchema = z.strictObject({
  operation: z.literal("foldingRange"),
  filePath: filePathField,
});

const codeActionSchema = z.strictObject({
  operation: z.literal("codeAction"),
  filePath: filePathField,
  ...positionSchema,
  endLine: positiveInt("1-based end line for range operations.").optional(),
  endCharacter: positiveInt("1-based end character for range operations.").optional(),
}).superRefine((value, ctx) => {
  const hasEndLine = value.endLine !== undefined;
  const hasEndCharacter = value.endCharacter !== undefined;
  if (hasEndLine !== hasEndCharacter) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "endLine and endCharacter must be provided together.",
      path: hasEndLine ? ["endCharacter"] : ["endLine"],
    });
  }
});

const positionedOperations = [
  "goToDefinition", "findReferences", "hover", "documentHighlight",
  "goToImplementation", "typeDefinition", "prepareCallHierarchy", "incomingCalls",
  "outgoingCalls", "signatureHelp", "prepareRename", "setBreakpoint",
] as const;

export const lspToolInputSchema = z.union([
  ...positionedOperations.map((operation) => positionedFileOperation(operation)),
  documentSymbolSchema,
  workspaceSymbolSchema,
  diagnosticsSchema,
  workspaceDiagnosticsSchema,
  renameSchema,
  foldingRangeSchema,
  codeActionSchema,
] as const);

const toolFilePath = Type.String({ minLength: 1, description: "Absolute or relative path to the file." });
const toolDiagnosticSeverity = Type.Union(
  SEVERITY_FILTERS.map((severity) => Type.Literal(severity)),
  { description: 'Filter diagnostics: "all" | "error" | "warning" | "info" | "hint".' },
);
const toolPosition = {
  line: Type.Integer({ minimum: 1, description: "1-based line number." }),
  character: Type.Integer({ minimum: 1, description: "1-based character offset." }),
};
const operationToolSchema = <T extends Operation>(operation: T, fields: Record<string, any>) =>
  Type.Object({ operation: Type.Literal(operation), ...fields }, { additionalProperties: false });

// Pi receives an operation-specific TypeBox `anyOf`, not a generic object of
// optional fields. Each strict branch matches the corresponding Zod runtime contract;
// Pi 0.86/0.87's TypeBox validator supports these schemas.
export const lspToolParameters = Type.Union([
  ...positionedOperations.map((operation) =>
    operationToolSchema(operation, { filePath: toolFilePath, ...toolPosition })),
  operationToolSchema("documentSymbol", { filePath: toolFilePath }),
  operationToolSchema("workspaceSymbol", { filePath: toolFilePath }),
  operationToolSchema("diagnostics", { filePath: toolFilePath, severity: Type.Optional(toolDiagnosticSeverity) }),
  operationToolSchema("workspaceDiagnostics", { filePaths: Type.Array(toolFilePath, { minItems: 1 }), severity: Type.Optional(toolDiagnosticSeverity) }),
  operationToolSchema("rename", { filePath: toolFilePath, ...toolPosition, newName: Type.String({ minLength: 1 }) }),
  operationToolSchema("foldingRange", { filePath: toolFilePath }),
  operationToolSchema("codeAction", { filePath: toolFilePath, ...toolPosition }),
  operationToolSchema("codeAction", { filePath: toolFilePath, ...toolPosition, endLine: Type.Integer({ minimum: 1 }), endCharacter: Type.Integer({ minimum: 1 }) }),
]);

export type LspToolInput = z.infer<typeof lspToolInputSchema>;

export function parseLspToolInput(input: unknown): LspToolInput {
  return lspToolInputSchema.parse(input);
}

export function safeParseLspToolInput(input: unknown): ReturnType<typeof lspToolInputSchema.safeParse> {
  return lspToolInputSchema.safeParse(input);
}
