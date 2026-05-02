import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { simpleGit } from "simple-git";
import { workspaceService } from "../src/services/workspace.js";
import { createRankedIssue } from "./helpers/factories.js";

const tempDirs: string[] = [];

function makeWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "openmeta-workspace-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("workspaceService.applyGeneratedChanges", () => {
	test("writes updated files inside the workspace and returns relative paths", () => {
		const workspacePath = makeWorkspace();
		const filePath = join(workspacePath, "src", "button.ts");
		mkdirSync(join(workspacePath, "src"), { recursive: true });
		writeFileSync(filePath, "export const button = 1;\n", "utf-8");

		const result = workspaceService.applyGeneratedChanges(workspacePath, [
			{
				path: "src/button.ts",
				reason: "Update implementation",
				content: "export const button = 2;\n",
			},
		]);

		expect(result.appliedFiles).toEqual(["src/button.ts"]);
		expect(result.reviewRequired).toBe(false);
		expect(readFileSync(filePath, "utf-8")).toBe("export const button = 2;\n");
	});

	test("skips unsafe paths outside the workspace", () => {
		const workspacePath = makeWorkspace();
		const outsidePath = join(workspacePath, "..", "escape.ts");

		const result = workspaceService.applyGeneratedChanges(workspacePath, [
			{
				path: "../escape.ts",
				reason: "Unsafe path",
				content: "export const leaked = true;\n",
			},
		]);

		expect(result.appliedFiles).toEqual([]);
		expect(result.reviewRequired).toBe(true);
		expect(result.skippedFiles[0]?.reason).toContain("outside the workspace");
		expect(existsSync(outsidePath)).toBe(false);
	});

	test("does not report files whose content is unchanged", () => {
		const workspacePath = makeWorkspace();
		const filePath = join(workspacePath, "README.md");
		writeFileSync(filePath, "# Demo\n", "utf-8");

		const result = workspaceService.applyGeneratedChanges(workspacePath, [
			{
				path: "README.md",
				reason: "No-op",
				content: "# Demo\n",
			},
		]);

		expect(result.appliedFiles).toEqual([]);
		expect(result.reviewRequired).toBe(false);
		expect(result.skippedFiles[0]?.reason).toContain("unchanged");
	});

	test("requires review when generated edits target files outside implementation context", () => {
		const workspacePath = makeWorkspace();
		mkdirSync(join(workspacePath, "src"), { recursive: true });
		writeFileSync(
			join(workspacePath, "src", "known.ts"),
			"export const known = 1;\n",
			"utf-8",
		);
		writeFileSync(
			join(workspacePath, "src", "surprise.ts"),
			"export const surprise = 1;\n",
			"utf-8",
		);

		const result = workspaceService.applyGeneratedChanges(
			workspacePath,
			[
				{
					path: "src/surprise.ts",
					reason: "Unexpected edit",
					content: "export const surprise = 2;\n",
				},
			],
			{
				allowedPaths: ["src/known.ts"],
			},
		);

		expect(result.appliedFiles).toEqual([]);
		expect(result.reviewRequired).toBe(true);
		expect(result.reviewReason).toContain("selected implementation context");
		expect(
			readFileSync(join(workspacePath, "src", "surprise.ts"), "utf-8"),
		).toBe("export const surprise = 1;\n");
	});

	test("requires review when generated patch touches too many files", () => {
		const workspacePath = makeWorkspace();
		const changes = Array.from({ length: 7 }, (_, index) => ({
			path: `src/file-${index}.ts`,
			reason: "Too broad",
			content: `export const value${index} = true;\n`,
		}));

		const result = workspaceService.applyGeneratedChanges(
			workspacePath,
			changes,
		);

		expect(result.appliedFiles).toEqual([]);
		expect(result.reviewRequired).toBe(true);
		expect(result.reviewReason).toContain("automatic apply limit");
	});
});

describe("workspaceService.detectTestCommands", () => {
	test("prefers bun for package scripts when a bun lockfile is present", () => {
		const workspacePath = makeWorkspace();
		writeFileSync(
			join(workspacePath, "package.json"),
			JSON.stringify({
				scripts: {
					lint: "eslint .",
					build: "vite build",
				},
			}),
			"utf-8",
		);
		writeFileSync(join(workspacePath, "bun.lock"), "", "utf-8");

		const commands = (
			workspaceService as unknown as {
				detectTestCommands(path: string): Array<{ command: string }>;
			}
		).detectTestCommands(workspacePath);

		expect(commands.map((command) => command.command)).toContain(
			"bun run lint",
		);
		expect(commands.map((command) => command.command)).toContain(
			"bun run build",
		);
	});

	test("skips repository-defined validation scripts in headless mode", () => {
		const commands = [
			{
				command: "bun run test",
				reason: "Detected package.json test script (bun)",
				source: "repo-script" as const,
			},
			{
				command: "pytest",
				reason: "Detected pyproject.toml",
				source: "tool-default" as const,
			},
		];

		const selected = (
			workspaceService as unknown as {
				selectValidationCommands: (
					commands: Array<{
						command: string;
						reason: string;
						source: "tool-default" | "repo-script";
					}>,
					mode: "interactive" | "headless",
				) => { commands: Array<{ command: string }>; warnings: string[] };
			}
		).selectValidationCommands(commands, "headless");

		expect(selected.commands.map((command) => command.command)).toEqual([
			"pytest",
		]);
		expect(selected.warnings[0]).toContain(
			"Skipped bun run test during headless validation",
		);
	});

	test("reads workspace files safely and ignores paths outside the repository root", () => {
		const workspacePath = makeWorkspace();
		mkdirSync(join(workspacePath, "src"), { recursive: true });
		writeFileSync(
			join(workspacePath, "src", "index.ts"),
			"export const ready = true;\n",
			"utf-8",
		);

		const snippets = workspaceService.readWorkspaceFiles(workspacePath, [
			"src/index.ts",
			"../escape.ts",
		]);

		expect(snippets).toEqual([
			{
				path: "src/index.ts",
				content: "export const ready = true;\n",
			},
		]);
	});

	test("creates a unique workspace branch name when the base branch already exists", async () => {
		const workspacePath = makeWorkspace();
		const git = simpleGit(workspacePath);

		await git.init(["--initial-branch=main"]);
		await git.addConfig("user.name", "OpenMeta Test");
		await git.addConfig("user.email", "openmeta@example.com");
		writeFileSync(join(workspacePath, "README.md"), "# Demo\n", "utf-8");
		await git.add("README.md");
		await git.commit("chore: initial commit");
		await git.checkoutLocalBranch(
			"openmeta/42-add-accessible-labels-to-icon-buttons",
		);

		const branchName = await (
			workspaceService as unknown as {
				createWorkspaceBranchName: (
					gitInstance: ReturnType<typeof simpleGit>,
					issue: ReturnType<typeof createRankedIssue>,
				) => Promise<string>;
			}
		).createWorkspaceBranchName(git, createRankedIssue());

		expect(branchName).toMatch(
			/^openmeta\/42-add-accessible-labels-to-icon-buttons-\d+$/,
		);
	});

	test("prioritizes file paths explicitly referenced in the issue body", () => {
		const workspacePath = makeWorkspace();
		mkdirSync(join(workspacePath, "src", "components"), { recursive: true });
		writeFileSync(
			join(workspacePath, "src", "components", "Dropzone.tsx"),
			"export const Dropzone = () => null;\n",
			"utf-8",
		);
		writeFileSync(
			join(workspacePath, "src", "misc.ts"),
			"export const misc = true;\n",
			"utf-8",
		);

		const rankedFiles = (
			workspaceService as unknown as {
				rankCandidateFiles: (
					issue: {
						title: string;
						body: string;
						analysis: { coreDemand: string; techRequirements: string[] };
					},
					memory: { preferredPaths: string[] },
					files: string[],
				) => string[];
			}
		).rankCandidateFiles(
			{
				title: "Fix accessibility in Dropzone",
				body: "The problem is in `src/components/Dropzone.tsx` and should be fixed there.",
				analysis: {
					coreDemand: "Add accessibility attributes to the dropzone.",
					techRequirements: ["react", "typescript"],
				},
			},
			{ preferredPaths: [] },
			["src/misc.ts", "src/components/Dropzone.tsx"],
		);

		expect(rankedFiles[0]).toBe("src/components/Dropzone.tsx");
	});

	test("prioritizes historically successful files from memory path signals", () => {
		const rankedFiles = (
			workspaceService as unknown as {
				rankCandidateFiles: (
					issue: {
						title: string;
						body: string;
						analysis: { coreDemand: string; techRequirements: string[] };
					},
					memory: {
						preferredPaths: string[];
						pathSignals: Array<{
							path: string;
							candidateCount: number;
							changedCount: number;
							successfulValidationCount: number;
							publishedCount: number;
						}>;
						recentIssues: Array<{
							changedFiles: string[];
							status:
								| "selected"
								| "draft_only"
								| "review_required"
								| "validated"
								| "published"
								| "pr_opened";
						}>;
					},
					files: string[],
				) => string[];
			}
		).rankCandidateFiles(
			{
				title: "Improve accessibility in icon interactions",
				body: "Audit the button flow for better labels and affordances.",
				analysis: {
					coreDemand: "Tighten icon button accessibility behavior.",
					techRequirements: ["react", "typescript"],
				},
			},
			{
				preferredPaths: [],
				pathSignals: [
					{
						path: "src/components/IconButton.tsx",
						candidateCount: 2,
						changedCount: 2,
						successfulValidationCount: 2,
						publishedCount: 1,
					},
				],
				recentIssues: [
					{
						changedFiles: ["src/components/IconButton.tsx"],
						status: "published",
					},
				],
			},
			["src/utils/labels.ts", "src/components/IconButton.tsx"],
		);

		expect(rankedFiles[0]).toBe("src/components/IconButton.tsx");
	});
});
