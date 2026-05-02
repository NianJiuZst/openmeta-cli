import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { ConfigService } from "../src/infra/config.js";
import { inboxService } from "../src/services/inbox.js";
import { memoryService } from "../src/services/memory.js";
import { proofOfWorkService } from "../src/services/proof-of-work.js";
import { runHistoryService } from "../src/services/run-history.js";
import {
	createInboxItem,
	createProofRecord,
	createRankedIssue,
	createWorkspace,
} from "./helpers/factories.js";

let tempRoot = "";

function createIsolatedDir(): string {
	return mkdtempSync(join(tmpdir(), "openmeta-test-"));
}

describe("stateful services", () => {
	beforeEach(() => {
		tempRoot = createIsolatedDir();
		process.env["OPENMETA_CONFIG_DIR"] = join(tempRoot, ".config", "openmeta");
		process.env["OPENMETA_HOME"] = join(tempRoot, ".openmeta");
	});

	afterEach(() => {
		delete process.env["OPENMETA_CONFIG_DIR"];
		delete process.env["OPENMETA_HOME"];

		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
			tempRoot = "";
		}
	});

	test("config service saves and loads encrypted credentials in an isolated config dir", async () => {
		const service = new ConfigService();
		const config = await service.get();

		config.github.pat = "ghp_test_token";
		config.github.username = "nianjiu";
		config.llm.apiKey = "sk-test-key";

		await service.save(config);

		const configPath = service.getConfigPath();
		const raw = readFileSync(configPath, "utf-8");

		expect(existsSync(configPath)).toBe(true);
		expect(raw).not.toContain("ghp_test_token");
		expect(raw).not.toContain("sk-test-key");

		const reloaded = new ConfigService();
		const loaded = await reloaded.load();

		expect(loaded.github.pat).toBe("ghp_test_token");
		expect(loaded.llm.apiKey).toBe("sk-test-key");
	});

	test("config service resets to defaults and keeps a backup of the previous file", async () => {
		const service = new ConfigService();
		const config = await service.get();

		config.github.username = "custom-user";
		config.automation.scheduleTime = "18:30";
		await service.save(config);
		await service.reset();

		const resetConfig = await service.load();
		const configPath = service.getConfigPath();
		const backupPath = `${configPath}.backup`;

		expect(existsSync(backupPath)).toBe(true);
		expect(readFileSync(backupPath, "utf-8")).toContain("custom-user");
		expect(resetConfig.github.username).toBe("");
		expect(resetConfig.automation.enabled).toBe(false);
		expect(resetConfig.automation.scheduleTime).toBe("09:00");
	});

	test("config service fills defaults when loading a partial config file", async () => {
		const service = new ConfigService();
		const configPath = service.getConfigPath();

		rmSync(join(tempRoot, ".config"), { recursive: true, force: true });
		mkdirSync(join(tempRoot, ".config", "openmeta"), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				github: {
					username: "partial-user",
				},
			}),
			"utf-8",
		);

		const loaded = await service.load();

		expect(loaded.github.username).toBe("partial-user");
		expect(loaded.llm.modelName).toBe("gpt-4o-mini");
		expect(loaded.automation.enabled).toBe(false);
		expect(loaded.automation.scheduleTime).toBe("09:00");
	});

	test("memory service persists repo memory snapshots", () => {
		const nextMemory = memoryService.update(
			createRankedIssue(),
			createWorkspace(),
		);
		const loadedMemory = memoryService.load("acme/demo");

		expect(nextMemory.generatedDossiers).toBe(1);
		expect(loadedMemory.lastSelectedIssue).toBe("acme/demo#42");
		expect(loadedMemory.preferredPaths).toContain(
			"src/components/IconButton.tsx",
		);
		expect(loadedMemory.pathSignals[0]?.candidateCount).toBe(1);
		expect(readFileSync(memoryService.getPath("acme/demo"), "utf-8")).toContain(
			'"generatedDossiers": 1',
		);
	});

	test("memory service records run outcomes and validation failure signals", () => {
		memoryService.update(createRankedIssue(), createWorkspace());
		const nextMemory = memoryService.recordOutcome({
			issue: createRankedIssue(),
			workspace: createWorkspace(),
			changedFiles: ["src/components/IconButton.tsx"],
			validationResults: [
				{
					command: "bun test",
					exitCode: 1,
					passed: false,
					output: "Expected aria-label to be present",
				},
			],
			published: false,
			reviewRequired: true,
			pullRequestUrl: undefined,
		});

		expect(nextMemory.runStats.totalRuns).toBe(1);
		expect(nextMemory.runStats.reviewRequiredRuns).toBe(1);
		expect(nextMemory.runStats.failedValidationRuns).toBe(1);
		expect(nextMemory.pathSignals[0]?.changedCount).toBe(1);
		expect(nextMemory.validationSignals[0]?.command).toBe("bun test");
		expect(nextMemory.recentIssues[0]?.status).toBe("review_required");
		expect(memoryService.renderMarkdown(nextMemory)).toContain(
			"## Validation Failure Signals",
		);
	});

	test("inbox service deduplicates items and keeps higher scores first", () => {
		inboxService.saveItem(
			createInboxItem({
				id: "one",
				overallScore: 70,
				repoFullName: "acme/one",
				issueNumber: 1,
			}),
		);
		const items = inboxService.saveItem(
			createInboxItem({
				id: "two",
				overallScore: 90,
				repoFullName: "acme/two",
				issueNumber: 2,
			}),
		);

		expect(items).toHaveLength(2);
		expect(items[0]?.id).toBe("two");
		expect(inboxService.renderMarkdown(items)).toContain(
			"[READY] acme/two#2 | overall 90",
		);
	});

	test("proof-of-work service records PR links in markdown output", () => {
		const records = proofOfWorkService.record(createProofRecord());
		const markdown = proofOfWorkService.renderMarkdown(records);

		expect(records).toHaveLength(1);
		expect(markdown).toContain("Published Runs: 1");
		expect(markdown).toContain("pr=https://github.com/acme/demo/pull/123");
	});

	test("run history service records command lifecycle and error details", () => {
		const run = runHistoryService.start({
			commandName: "OpenMeta Scout",
			args: ["scout", "--local"],
		});
		const finished = runHistoryService.finish(
			run.id,
			"failed",
			"LLM validation failed",
		);
		const state = runHistoryService.load();

		expect(finished?.status).toBe("failed");
		expect(finished?.durationMs).toBeGreaterThanOrEqual(0);
		expect(finished?.error).toBe("LLM validation failed");
		expect(state.records[0]?.id).toBe(run.id);
		expect(runHistoryService.find(run.id)?.args).toEqual(["scout", "--local"]);
	});
});
