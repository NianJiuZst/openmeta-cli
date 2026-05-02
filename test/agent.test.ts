import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentOrchestrator } from "../src/orchestration/agent.js";
import { llmService, workspaceService } from "../src/services/index.js";
import {
	createPatchDraft,
	createRankedIssue,
	createWorkspace,
} from "./helpers/factories.js";

interface AgentInternals {
	buildImplementationWorkspace(
		workspace: ReturnType<typeof createWorkspace>,
		patchDraft: ReturnType<typeof createPatchDraft>,
	): ReturnType<typeof createWorkspace>;
	formatValidationSummary(
		results: Array<{
			command: string;
			exitCode: number | null;
			passed: boolean;
			output: string;
		}>,
	): string;
	hasBlockingValidationFailures(
		results: Array<{
			command: string;
			exitCode: number | null;
			passed: boolean;
			output: string;
		}>,
	): boolean;
	generateConcretePatch(
		issue: ReturnType<typeof createRankedIssue>,
		workspace: ReturnType<typeof createWorkspace>,
		patchDraft: ReturnType<typeof createPatchDraft>,
		runChecks: boolean,
		draftOnly?: boolean,
	): Promise<{
		changedFiles: string[];
		validationResults: Array<{
			command: string;
			exitCode: number | null;
			passed: boolean;
			output: string;
		}>;
		reviewRequired: boolean;
	}>;
}

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("AgentOrchestrator patch workflow", () => {
	test("marks exit code 127 validations as unavailable instead of failed", () => {
		const orchestrator = new AgentOrchestrator() as unknown as AgentInternals;
		const summary = orchestrator.formatValidationSummary([
			{
				command: "npm run lint",
				exitCode: 127,
				passed: false,
				output: "sh: npm: command not found",
			},
		]);

		expect(summary).toBe("npm run lint=unavailable (127)");
	});

	test("loads patch draft target files into implementation context", () => {
		const workspacePath = mkdtempSync(
			join(tmpdir(), "openmeta-agent-context-"),
		);
		tempDirs.push(workspacePath);
		mkdirSync(join(workspacePath, "src", "components"), { recursive: true });
		writeFileSync(
			join(workspacePath, "src", "components", "IconButton.tsx"),
			"export function IconButton() { return null; }\n",
			"utf-8",
		);
		writeFileSync(
			join(workspacePath, "src", "components", "IconButton.test.tsx"),
			'test("icon button", () => {});\n',
			"utf-8",
		);

		const orchestrator = new AgentOrchestrator() as unknown as AgentInternals;
		const workspace = orchestrator.buildImplementationWorkspace(
			createWorkspace({
				workspacePath,
				candidateFiles: ["src/components/IconButton.tsx"],
				snippets: [
					{
						path: "src/components/IconButton.tsx",
						content: "export function IconButton() { return null; }\n",
					},
				],
			}),
			createPatchDraft({
				targetFiles: [
					{
						path: "src/components/IconButton.tsx",
						reason: "Primary component",
					},
					{
						path: "src/components/IconButton.test.tsx",
						reason: "Coverage for the updated behavior",
					},
					{
						path: "../outside.ts",
						reason: "Unsafe path that must not enter context",
					},
				],
				proposedChanges: [
					{
						title: "Update tests",
						details: "Cover the accessibility behavior.",
						files: ["src/components/IconButton.test.tsx"],
					},
				],
			}),
		);

		expect(workspace.candidateFiles).toContain(
			"src/components/IconButton.test.tsx",
		);
		expect(workspace.candidateFiles).not.toContain("../outside.ts");
		expect(workspace.snippets.map((snippet) => snippet.path)).toEqual([
			"src/components/IconButton.tsx",
			"src/components/IconButton.test.tsx",
		]);
	});

	test("treats infrastructure validation failures as non-blocking", () => {
		const orchestrator = new AgentOrchestrator() as unknown as AgentInternals;

		expect(
			orchestrator.hasBlockingValidationFailures([
				{
					command: "npm run lint",
					exitCode: 127,
					passed: false,
					output: "command not found",
				},
			]),
		).toBe(false);

		expect(
			orchestrator.hasBlockingValidationFailures([
				{
					command: "pytest",
					exitCode: 1,
					passed: false,
					output: "AssertionError",
				},
			]),
		).toBe(true);
	});

	test("attempts a single validation repair pass after blocking failures", async () => {
		const workspacePath = mkdtempSync(join(tmpdir(), "openmeta-agent-"));
		tempDirs.push(workspacePath);
		mkdirSync(join(workspacePath, "src"), { recursive: true });
		writeFileSync(
			join(workspacePath, "src", "app.ts"),
			"export const version = 0;\n",
			"utf-8",
		);

		const originalGenerateImplementationDraft =
			llmService.generateImplementationDraft;
		const originalGenerateImplementationRepairDraft =
			llmService.generateImplementationRepairDraft;
		const originalRunValidationCommands =
			workspaceService.runValidationCommands;

		let validationRuns = 0;

		try {
			llmService.generateImplementationDraft = async () => ({
				version: "1",
				kind: "implementation_draft",
				status: "success",
				data: {
					summary: "Initial patch",
					fileChanges: [
						{
							path: "src/app.ts",
							reason: "Apply the initial implementation",
							content: "export const version = 1;\n",
						},
					],
				},
			});

			llmService.generateImplementationRepairDraft = async () => ({
				version: "1",
				kind: "implementation_draft",
				status: "success",
				data: {
					summary: "Repair patch",
					fileChanges: [
						{
							path: "src/app.ts",
							reason: "Fix the failing validation path",
							content: "export const version = 2;\n",
						},
					],
				},
			});

			workspaceService.runValidationCommands = () => {
				validationRuns += 1;
				return validationRuns === 1
					? [
							{
								command: "pytest",
								exitCode: 1,
								passed: false,
								output: "AssertionError: expected version 2",
							},
						]
					: [
							{
								command: "pytest",
								exitCode: 0,
								passed: true,
								output: "1 passed",
							},
						];
			};

			const orchestrator = new AgentOrchestrator() as unknown as AgentInternals;
			const result = await orchestrator.generateConcretePatch(
				createRankedIssue(),
				createWorkspace({
					workspacePath,
					snippets: [
						{ path: "src/app.ts", content: "export const version = 0;\n" },
					],
					testCommands: [
						{
							command: "pytest",
							reason: "Detected pyproject.toml",
							source: "tool-default",
						},
					],
					validationCommands: [
						{
							command: "pytest",
							reason: "Detected pyproject.toml",
							source: "tool-default",
						},
					],
					validationWarnings: [],
					testResults: [],
				}),
				createPatchDraft(),
				true,
			);

			expect(validationRuns).toBe(2);
			expect(result.changedFiles).toEqual(["src/app.ts"]);
			expect(result.validationResults[0]?.passed).toBe(true);
			expect(result.reviewRequired).toBe(false);
			expect(readFileSync(join(workspacePath, "src", "app.ts"), "utf-8")).toBe(
				"export const version = 2;\n",
			);
		} finally {
			llmService.generateImplementationDraft =
				originalGenerateImplementationDraft;
			llmService.generateImplementationRepairDraft =
				originalGenerateImplementationRepairDraft;
			workspaceService.runValidationCommands = originalRunValidationCommands;
		}
	});

	test("skips generated file edits when the implementation draft requires review", async () => {
		const workspacePath = mkdtempSync(join(tmpdir(), "openmeta-agent-review-"));
		tempDirs.push(workspacePath);
		mkdirSync(join(workspacePath, "src"), { recursive: true });
		writeFileSync(
			join(workspacePath, "src", "app.ts"),
			"export const version = 0;\n",
			"utf-8",
		);

		const originalGenerateImplementationDraft =
			llmService.generateImplementationDraft;

		try {
			llmService.generateImplementationDraft = async () => ({
				version: "1",
				kind: "implementation_draft",
				status: "needs_review",
				data: {
					summary: "The generated implementation needs manual review.",
					fileChanges: [
						{
							path: "src/app.ts",
							reason:
								"Candidate implementation that should not be auto-applied",
							content: "export const version = 1;\n",
						},
					],
				},
			});

			const orchestrator = new AgentOrchestrator() as unknown as AgentInternals;
			const result = await orchestrator.generateConcretePatch(
				createRankedIssue(),
				createWorkspace({
					workspacePath,
					snippets: [
						{ path: "src/app.ts", content: "export const version = 0;\n" },
					],
					testCommands: [],
					validationCommands: [],
					validationWarnings: [],
					testResults: [],
				}),
				createPatchDraft(),
				true,
			);

			expect(result.changedFiles).toEqual([]);
			expect(result.reviewRequired).toBe(true);
			expect(readFileSync(join(workspacePath, "src", "app.ts"), "utf-8")).toBe(
				"export const version = 0;\n",
			);
		} finally {
			llmService.generateImplementationDraft =
				originalGenerateImplementationDraft;
		}
	});

	test("skips generated file edits in draft-only mode", async () => {
		const workspacePath = mkdtempSync(
			join(tmpdir(), "openmeta-agent-draft-only-"),
		);
		tempDirs.push(workspacePath);
		mkdirSync(join(workspacePath, "src"), { recursive: true });
		writeFileSync(
			join(workspacePath, "src", "app.ts"),
			"export const version = 0;\n",
			"utf-8",
		);

		const originalGenerateImplementationDraft =
			llmService.generateImplementationDraft;
		let implementationRequested = false;

		try {
			llmService.generateImplementationDraft = async () => {
				implementationRequested = true;
				return {
					version: "1",
					kind: "implementation_draft",
					status: "success",
					data: {
						summary: "Patch that should not be requested",
						fileChanges: [
							{
								path: "src/app.ts",
								reason: "Draft-only mode should skip this edit",
								content: "export const version = 1;\n",
							},
						],
					},
				};
			};

			const orchestrator = new AgentOrchestrator() as unknown as AgentInternals;
			const result = await orchestrator.generateConcretePatch(
				createRankedIssue(),
				createWorkspace({
					workspacePath,
					snippets: [
						{ path: "src/app.ts", content: "export const version = 0;\n" },
					],
					testCommands: [],
					validationCommands: [],
					validationWarnings: [],
					testResults: [],
				}),
				createPatchDraft(),
				true,
				true,
			);

			expect(implementationRequested).toBe(false);
			expect(result.changedFiles).toEqual([]);
			expect(result.reviewRequired).toBe(false);
			expect(readFileSync(join(workspacePath, "src", "app.ts"), "utf-8")).toBe(
				"export const version = 0;\n",
			);
		} finally {
			llmService.generateImplementationDraft =
				originalGenerateImplementationDraft;
		}
	});

	test("skips generated file edits when the workspace is already dirty", async () => {
		const workspacePath = mkdtempSync(join(tmpdir(), "openmeta-agent-dirty-"));
		tempDirs.push(workspacePath);
		mkdirSync(join(workspacePath, "src"), { recursive: true });
		writeFileSync(
			join(workspacePath, "src", "app.ts"),
			"export const version = 0;\n",
			"utf-8",
		);

		const originalGenerateImplementationDraft =
			llmService.generateImplementationDraft;
		let implementationRequested = false;

		try {
			llmService.generateImplementationDraft = async () => {
				implementationRequested = true;
				return {
					version: "1",
					kind: "implementation_draft",
					status: "success",
					data: {
						summary: "Patch that should not be requested",
						fileChanges: [
							{
								path: "src/app.ts",
								reason: "Dirty workspaces should be protected",
								content: "export const version = 1;\n",
							},
						],
					},
				};
			};

			const orchestrator = new AgentOrchestrator() as unknown as AgentInternals;
			const result = await orchestrator.generateConcretePatch(
				createRankedIssue(),
				createWorkspace({
					workspacePath,
					workspaceDirty: true,
					snippets: [
						{ path: "src/app.ts", content: "export const version = 0;\n" },
					],
					testCommands: [],
					validationCommands: [],
					validationWarnings: [],
					testResults: [],
				}),
				createPatchDraft(),
				true,
			);

			expect(implementationRequested).toBe(false);
			expect(result.changedFiles).toEqual([]);
			expect(result.reviewRequired).toBe(true);
			expect(readFileSync(join(workspacePath, "src", "app.ts"), "utf-8")).toBe(
				"export const version = 0;\n",
			);
		} finally {
			llmService.generateImplementationDraft =
				originalGenerateImplementationDraft;
		}
	});

	test("marks the run as review-required when validation repair needs manual review", async () => {
		const workspacePath = mkdtempSync(
			join(tmpdir(), "openmeta-agent-repair-review-"),
		);
		tempDirs.push(workspacePath);
		mkdirSync(join(workspacePath, "src"), { recursive: true });
		writeFileSync(
			join(workspacePath, "src", "app.ts"),
			"export const version = 0;\n",
			"utf-8",
		);

		const originalGenerateImplementationDraft =
			llmService.generateImplementationDraft;
		const originalGenerateImplementationRepairDraft =
			llmService.generateImplementationRepairDraft;
		const originalRunValidationCommands =
			workspaceService.runValidationCommands;

		let validationRuns = 0;

		try {
			llmService.generateImplementationDraft = async () => ({
				version: "1",
				kind: "implementation_draft",
				status: "success",
				data: {
					summary: "Initial patch",
					fileChanges: [
						{
							path: "src/app.ts",
							reason: "Apply the initial implementation",
							content: "export const version = 1;\n",
						},
					],
				},
			});

			llmService.generateImplementationRepairDraft = async () => ({
				version: "1",
				kind: "implementation_draft",
				status: "needs_review",
				data: {
					summary: "The repair requires manual inspection.",
					fileChanges: [
						{
							path: "src/app.ts",
							reason: "Candidate repair that should not be auto-applied",
							content: "export const version = 2;\n",
						},
					],
				},
			});

			workspaceService.runValidationCommands = () => {
				validationRuns += 1;
				return [
					{
						command: "pytest",
						exitCode: 1,
						passed: false,
						output: "AssertionError: expected version 2",
					},
				];
			};

			const orchestrator = new AgentOrchestrator() as unknown as AgentInternals;
			const result = await orchestrator.generateConcretePatch(
				createRankedIssue(),
				createWorkspace({
					workspacePath,
					snippets: [
						{ path: "src/app.ts", content: "export const version = 0;\n" },
					],
					testCommands: [
						{
							command: "pytest",
							reason: "Detected pyproject.toml",
							source: "tool-default",
						},
					],
					validationCommands: [
						{
							command: "pytest",
							reason: "Detected pyproject.toml",
							source: "tool-default",
						},
					],
					validationWarnings: [],
					testResults: [],
				}),
				createPatchDraft(),
				true,
			);

			expect(validationRuns).toBe(1);
			expect(result.changedFiles).toEqual(["src/app.ts"]);
			expect(result.validationResults[0]?.passed).toBe(false);
			expect(result.reviewRequired).toBe(true);
			expect(readFileSync(join(workspacePath, "src", "app.ts"), "utf-8")).toBe(
				"export const version = 1;\n",
			);
		} finally {
			llmService.generateImplementationDraft =
				originalGenerateImplementationDraft;
			llmService.generateImplementationRepairDraft =
				originalGenerateImplementationRepairDraft;
			workspaceService.runValidationCommands = originalRunValidationCommands;
		}
	});
});
