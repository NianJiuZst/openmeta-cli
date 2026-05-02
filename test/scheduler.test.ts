import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SchedulerService } from "../src/services/scheduler.js";
import type { AppConfig } from "../src/types/index.js";

interface SchedulerTestHarness {
	sync(config: AppConfig): ReturnType<SchedulerService["sync"]>;
	detectProvider(): "launchd" | "cron" | "manual";
	getSchedulerContext(): { executablePath: string; entryScriptPath: string };
	readCrontab(): { content: string; error?: string };
	runCommand(
		command: string,
		args: string[],
		allowFailure?: boolean,
		input?: string,
	): { success: boolean; message?: string };
	parseScheduleTime(value: string): { hour: number; minute: number };
	buildCommandString(context: {
		executablePath: string;
		entryScriptPath: string;
	}): string;
	buildLaunchdPlist(options: {
		executablePath: string;
		entryScriptPath: string;
		hour: number;
		minute: number;
		stdoutPath: string;
		stderrPath: string;
		workingDirectory: string;
	}): string;
	shellEscape(value: string): string;
	escapeXml(value: string): string;
}

let tempRoot = "";

function createIsolatedDir(): string {
	return mkdtempSync(join(tmpdir(), "openmeta-scheduler-test-"));
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	return {
		userProfile: {
			techStack: [],
			proficiency: "beginner",
			focusAreas: [],
		},
		github: {
			pat: "ghp_test",
			username: "nianjiu",
			targetRepoPath: "",
		},
		llm: {
			provider: "openai",
			apiBaseUrl: "https://api.openai.com/v1",
			apiKey: "sk-test",
			modelName: "gpt-4o-mini",
		},
		automation: {
			enabled: true,
			scheduleTime: "09:30",
			timezone: "Asia/Shanghai",
			contentType: "research_note",
			scheduler: "cron",
			minMatchScore: 70,
			skipIfAlreadyGeneratedToday: true,
		},
		commitTemplate: "feat(daily): {{title}}\n\n{{content}}",
		...overrides,
	};
}

describe("SchedulerService", () => {
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

	test("parses valid schedule times and rejects invalid ones", () => {
		const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;

		expect(scheduler.parseScheduleTime("09:30")).toEqual({
			hour: 9,
			minute: 30,
		});
		expect(scheduler.parseScheduleTime("23:59")).toEqual({
			hour: 23,
			minute: 59,
		});
		expect(() => scheduler.parseScheduleTime("9:30")).toThrow(
			"Invalid schedule time",
		);
		expect(() => scheduler.parseScheduleTime("24:00")).toThrow(
			"Invalid schedule time",
		);
	});

	test("shell-escapes command arguments and XML-escapes launchd values", () => {
		const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;

		expect(scheduler.shellEscape("/tmp/it's here")).toBe(
			"'/tmp/it'\\''s here'",
		);
		expect(scheduler.escapeXml(`A&B<"'`)).toBe("A&amp;B&lt;&quot;&apos;");
	});

	test("builds scheduler command strings with quoted executable and entry paths", () => {
		const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
		const command = scheduler.buildCommandString({
			executablePath: "/Applications/OpenMeta App/bin/node",
			entryScriptPath: "/tmp/OpenMeta's Agent/cli.js",
		});

		expect(command).toContain("'/Applications/OpenMeta App/bin/node'");
		expect(command).toContain("'agent'");
		expect(command).toContain("'--headless'");
		expect(command).toContain("'--scheduler-run'");
		expect(command).toContain("'/tmp/OpenMeta'\\''s Agent/cli.js'");
	});

	test("returns manual scheduler instructions when automation is enabled on unsupported platforms", async () => {
		const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
		const originalDetectProvider = scheduler.detectProvider;
		const originalGetSchedulerContext = scheduler.getSchedulerContext;

		try {
			scheduler.detectProvider = () => "manual";
			scheduler.getSchedulerContext = () => ({
				executablePath: "/usr/bin/node",
				entryScriptPath: "/tmp/openmeta-cli.js",
			});

			const result = await scheduler.sync(createConfig());

			expect(result).toEqual({
				provider: "manual",
				status: "manual",
				detail:
					"Automatic scheduling is not supported on this platform. Use your system scheduler to run OpenMeta agent in headless mode.",
				command:
					"'/usr/bin/node' '/tmp/openmeta-cli.js' 'agent' '--headless' '--scheduler-run'",
			});
		} finally {
			scheduler.detectProvider = originalDetectProvider;
			scheduler.getSchedulerContext = originalGetSchedulerContext;
		}
	});

	test("installs cron entries by replacing previous tagged lines and preserving unrelated entries", async () => {
		const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
		const originalDetectProvider = scheduler.detectProvider;
		const originalGetSchedulerContext = scheduler.getSchedulerContext;
		const originalReadCrontab = scheduler.readCrontab;
		const originalRunCommand = scheduler.runCommand;
		let appliedCrontab = "";

		try {
			scheduler.detectProvider = () => "cron";
			scheduler.getSchedulerContext = () => ({
				executablePath: "/usr/bin/node",
				entryScriptPath: "/tmp/openmeta-cli.js",
			});
			scheduler.readCrontab = () => ({
				content: [
					"MAILTO=dev@example.com",
					"0 1 * * * '/usr/bin/node' '/tmp/old.js' # openmeta-daily",
					"15 7 * * * /usr/bin/true",
				].join("\n"),
			});
			scheduler.runCommand = (
				_command: string,
				_args: string[],
				_allowFailure: boolean = false,
				input?: string,
			) => {
				appliedCrontab = input || "";
				return { success: true };
			};

			const result = await scheduler.sync(
				createConfig({
					automation: {
						...createConfig().automation,
						scheduleTime: "18:05",
					},
				}),
			);

			expect(result.status).toBe("installed");
			expect(appliedCrontab).toContain("MAILTO=dev@example.com");
			expect(appliedCrontab).toContain("15 7 * * * /usr/bin/true");
			expect(appliedCrontab).toContain("5 18 * * *");
			expect(appliedCrontab).toContain(
				"'agent' '--headless' '--scheduler-run'",
			);
			expect(appliedCrontab).not.toContain("/tmp/old.js");
		} finally {
			scheduler.detectProvider = originalDetectProvider;
			scheduler.getSchedulerContext = originalGetSchedulerContext;
			scheduler.readCrontab = originalReadCrontab;
			scheduler.runCommand = originalRunCommand;
		}
	});

	test("removes only tagged cron entries when automation is disabled", async () => {
		const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
		const originalDetectProvider = scheduler.detectProvider;
		const originalReadCrontab = scheduler.readCrontab;
		const originalRunCommand = scheduler.runCommand;
		let appliedCrontab = "";

		try {
			scheduler.detectProvider = () => "cron";
			scheduler.readCrontab = () => ({
				content: [
					"MAILTO=dev@example.com",
					"0 1 * * * '/usr/bin/node' '/tmp/old.js' # openmeta-daily",
					"15 7 * * * /usr/bin/true",
				].join("\n"),
			});
			scheduler.runCommand = (
				_command: string,
				_args: string[],
				_allowFailure: boolean = false,
				input?: string,
			) => {
				appliedCrontab = input || "";
				return { success: true };
			};

			const result = await scheduler.sync(
				createConfig({
					automation: {
						...createConfig().automation,
						enabled: false,
					},
				}),
			);

			expect(result).toEqual({
				provider: "cron",
				status: "removed",
				detail: "cron automation was removed.",
			});
			expect(appliedCrontab).toContain("MAILTO=dev@example.com");
			expect(appliedCrontab).toContain("15 7 * * * /usr/bin/true");
			expect(appliedCrontab).not.toContain("# openmeta-daily");
		} finally {
			scheduler.detectProvider = originalDetectProvider;
			scheduler.readCrontab = originalReadCrontab;
			scheduler.runCommand = originalRunCommand;
		}
	});

	test("renders launchd plist with escaped values and scheduler arguments", () => {
		const scheduler = new SchedulerService() as unknown as SchedulerTestHarness;
		const plist = scheduler.buildLaunchdPlist({
			executablePath: "/Applications/OpenMeta & Friends/bin/node",
			entryScriptPath: "/tmp/openmeta-cli.js",
			hour: 9,
			minute: 45,
			stdoutPath: join(tempRoot, "logs", "daily.stdout.log"),
			stderrPath: join(tempRoot, "logs", "daily.stderr.log"),
			workingDirectory: "/tmp/work & more",
		});

		expect(plist).toContain(
			"<string>/Applications/OpenMeta &amp; Friends/bin/node</string>",
		);
		expect(plist).toContain("<string>agent</string>");
		expect(plist).toContain("<string>--headless</string>");
		expect(plist).toContain("<integer>9</integer>");
		expect(plist).toContain("<integer>45</integer>");
		expect(plist).toContain("<string>/tmp/work &amp; more</string>");
	});
});
