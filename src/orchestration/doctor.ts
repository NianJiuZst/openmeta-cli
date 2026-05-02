import { spawnSync } from "child_process";
import { accessSync, constants, existsSync, statSync } from "fs";
import { dirname } from "path";
import { simpleGit } from "simple-git";
import {
	configService,
	getOpenMetaArtifactRoot,
	getOpenMetaHomePath,
	getOpenMetaWorkspaceRoot,
	ui,
} from "../infra/index.js";
import { schedulerService } from "../services/index.js";
import type { AppConfig } from "../types/index.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
	id: string;
	label: string;
	status: DoctorCheckStatus;
	summary: string;
	detail?: string;
	remediation?: string;
}

export interface DoctorReport {
	configPath: string;
	homePath: string;
	checks: DoctorCheck[];
	totals: Record<DoctorCheckStatus, number>;
	ready: boolean;
}

export class DoctorOrchestrator {
	async execute(): Promise<void> {
		const report = await this.inspect();

		ui.hero({
			label: "OpenMeta Doctor",
			title: report.ready
				? "The local agent surface looks ready"
				: "The local agent surface needs attention",
			subtitle:
				"Doctor checks the local prerequisites OpenMeta needs before the full contribution loop can run with confidence.",
			lines: [
				`Config path: ${report.configPath}`,
				`OpenMeta home: ${report.homePath}`,
			],
			tone: report.ready ? "success" : "warning",
		});

		ui.stats("Doctor summary", [
			{ label: "Passed", value: String(report.totals.pass), tone: "success" },
			{
				label: "Warnings",
				value: String(report.totals.warn),
				tone: report.totals.warn > 0 ? "warning" : "muted",
			},
			{
				label: "Failures",
				value: String(report.totals.fail),
				tone: report.totals.fail > 0 ? "error" : "muted",
			},
			{
				label: "Ready",
				value: report.ready ? "YES" : "NO",
				tone: report.ready ? "success" : "warning",
			},
		]);

		ui.recordList(
			"Preflight checks",
			report.checks.map((check) => ({
				title: `${this.statusLabel(check.status)} ${check.label}`,
				subtitle: check.summary,
				meta: [check.id],
				lines: [
					...(check.detail ? [check.detail] : []),
					...(check.remediation ? [`Next: ${check.remediation}`] : []),
				],
				tone: this.toneForStatus(check.status),
			})),
		);

		if (!report.ready) {
			throw new Error(
				`OpenMeta doctor found ${report.totals.fail} critical issue(s). Fix them and rerun "openmeta doctor".`,
			);
		}
	}

	async inspect(config?: AppConfig): Promise<DoctorReport> {
		const resolvedConfig = config ?? (await configService.get());
		const configPath = configService.getConfigPath();
		const homePath = getOpenMetaHomePath();
		const checks = [
			this.checkConfigFile(configPath),
			this.checkDirectory(
				"state-dir",
				"State directory",
				dirname(configPath),
				'Run "openmeta init" to create and save local configuration.',
			),
			this.checkDirectory(
				"openmeta-home",
				"OpenMeta home",
				homePath,
				'Run "openmeta agent" or create the directory manually with write permissions.',
			),
			this.checkDirectory(
				"workspace-root",
				"Workspace root",
				getOpenMetaWorkspaceRoot(),
				'Run "openmeta agent" after configuration is complete.',
			),
			this.checkDirectory(
				"artifact-root",
				"Artifact root",
				getOpenMetaArtifactRoot(),
				'Run "openmeta agent" after configuration is complete.',
			),
			this.checkCommand(
				"runtime-bun",
				"Bun runtime",
				"bun",
				["--version"],
				"Install Bun 1.0+ and ensure it is available on PATH.",
			),
			this.checkCommand(
				"runtime-git",
				"Git runtime",
				"git",
				["--version"],
				"Install Git and ensure it is available on PATH.",
			),
			this.checkGitHubConfig(resolvedConfig),
			this.checkLlmConfig(resolvedConfig),
			this.checkProfileConfig(resolvedConfig),
			await this.checkTargetRepository(resolvedConfig),
			this.checkSchedulerConfig(resolvedConfig),
		];
		const totals = this.countStatuses(checks);

		return {
			configPath,
			homePath,
			checks,
			totals,
			ready: totals.fail === 0,
		};
	}

	private checkConfigFile(configPath: string): DoctorCheck {
		if (!existsSync(configPath)) {
			return {
				id: "config-file",
				label: "Config file",
				status: "warn",
				summary: "No saved configuration file was found yet.",
				detail: configPath,
				remediation:
					'Run "openmeta init" to save credentials, profile, and automation settings.',
			};
		}

		try {
			accessSync(configPath, constants.R_OK | constants.W_OK);
			return {
				id: "config-file",
				label: "Config file",
				status: "pass",
				summary: "Configuration file exists and is readable.",
				detail: configPath,
			};
		} catch {
			return {
				id: "config-file",
				label: "Config file",
				status: "fail",
				summary: "Configuration file exists but is not readable and writable.",
				detail: configPath,
				remediation: 'Fix file permissions, then rerun "openmeta doctor".',
			};
		}
	}

	private checkDirectory(
		id: string,
		label: string,
		path: string,
		remediation: string,
	): DoctorCheck {
		if (!existsSync(path)) {
			return {
				id,
				label,
				status: "warn",
				summary: "Directory does not exist yet.",
				detail: path,
				remediation,
			};
		}

		if (!statSync(path).isDirectory()) {
			return {
				id,
				label,
				status: "fail",
				summary: "Path exists but is not a directory.",
				detail: path,
				remediation:
					"Move or remove the file at this path, then rerun the command.",
			};
		}

		try {
			accessSync(path, constants.R_OK | constants.W_OK);
			return {
				id,
				label,
				status: "pass",
				summary: "Directory exists and is writable.",
				detail: path,
			};
		} catch {
			return {
				id,
				label,
				status: "fail",
				summary: "Directory exists but is not writable.",
				detail: path,
				remediation: "Fix directory permissions before running the agent.",
			};
		}
	}

	private checkCommand(
		id: string,
		label: string,
		command: string,
		args: string[],
		remediation: string,
	): DoctorCheck {
		const result = spawnSync(command, args, { encoding: "utf-8" });
		if (result.error) {
			return {
				id,
				label,
				status: "fail",
				summary: `${command} is not available.`,
				detail: result.error.message,
				remediation,
			};
		}

		if (result.status !== 0) {
			return {
				id,
				label,
				status: "fail",
				summary: `${command} returned exit code ${result.status ?? "n/a"}.`,
				detail: (result.stderr || result.stdout || "").trim(),
				remediation,
			};
		}

		return {
			id,
			label,
			status: "pass",
			summary: `${command} is available.`,
			detail: (result.stdout || result.stderr || "").trim().split(/\r?\n/)[0],
		};
	}

	private checkGitHubConfig(config: AppConfig): DoctorCheck {
		const missing = [
			!config.github.username ? "username" : "",
			!config.github.pat ? "token" : "",
		].filter(Boolean);

		if (missing.length > 0) {
			return {
				id: "github-config",
				label: "GitHub configuration",
				status: "fail",
				summary: `Missing GitHub ${missing.join(" and ")}.`,
				remediation:
					'Run "openmeta init" or set github.username and github.pat.',
			};
		}

		return {
			id: "github-config",
			label: "GitHub configuration",
			status: "pass",
			summary: `GitHub identity is configured for ${config.github.username}.`,
			detail: `Token: ${ui.maskSecret(config.github.pat)}`,
		};
	}

	private checkLlmConfig(config: AppConfig): DoctorCheck {
		const missing = [
			!config.llm.apiBaseUrl ? "base URL" : "",
			!config.llm.modelName ? "model" : "",
			!config.llm.apiKey ? "API key" : "",
		].filter(Boolean);

		if (missing.length > 0) {
			return {
				id: "llm-config",
				label: "LLM configuration",
				status: "fail",
				summary: `Missing LLM ${missing.join(", ")}.`,
				remediation:
					'Run "openmeta init" or set llm.apiBaseUrl, llm.modelName, and llm.apiKey.',
			};
		}

		return {
			id: "llm-config",
			label: "LLM configuration",
			status: "pass",
			summary: `${config.llm.provider} provider is configured.`,
			detail: `${config.llm.modelName} at ${config.llm.apiBaseUrl}; key ${ui.maskSecret(config.llm.apiKey)}`,
		};
	}

	private checkProfileConfig(config: AppConfig): DoctorCheck {
		const missing = [
			config.userProfile.techStack.length === 0 ? "tech stack" : "",
			config.userProfile.focusAreas.length === 0 ? "focus areas" : "",
		].filter(Boolean);

		if (missing.length > 0) {
			return {
				id: "profile-config",
				label: "Matching profile",
				status: "warn",
				summary: `Profile is missing ${missing.join(" and ")}.`,
				remediation:
					'Run "openmeta init" or update userProfile.techStack and userProfile.focusAreas.',
			};
		}

		return {
			id: "profile-config",
			label: "Matching profile",
			status: "pass",
			summary: `${config.userProfile.proficiency} profile with ${config.userProfile.techStack.length} stack item(s).`,
			detail: `Focus: ${config.userProfile.focusAreas.join(", ")}`,
		};
	}

	private async checkTargetRepository(config: AppConfig): Promise<DoctorCheck> {
		if (!config.github.targetRepoPath) {
			return {
				id: "target-repo",
				label: "Artifact repository",
				status: "pass",
				summary:
					"OpenMeta will use the managed private artifact repository policy.",
			};
		}

		if (!existsSync(config.github.targetRepoPath)) {
			return {
				id: "target-repo",
				label: "Artifact repository",
				status: "fail",
				summary: "Configured target repository path does not exist.",
				detail: config.github.targetRepoPath,
				remediation:
					"Fix github.targetRepoPath or leave it empty to use the managed repository policy.",
			};
		}

		try {
			const git = simpleGit(config.github.targetRepoPath);
			const isRepo = await git.checkIsRepo();
			const remotes = isRepo ? await git.getRemotes(true) : [];
			if (!isRepo || remotes.length === 0) {
				return {
					id: "target-repo",
					label: "Artifact repository",
					status: "fail",
					summary: "Target path is not a git repository with a remote.",
					detail: config.github.targetRepoPath,
					remediation:
						"Initialize a git repository with an origin remote, or clear github.targetRepoPath.",
				};
			}

			return {
				id: "target-repo",
				label: "Artifact repository",
				status: "pass",
				summary: "Configured target repository is available locally.",
				detail: `${config.github.targetRepoPath} (${remotes.map((remote) => remote.name).join(", ")})`,
			};
		} catch (error) {
			return {
				id: "target-repo",
				label: "Artifact repository",
				status: "fail",
				summary: "Unable to inspect configured target repository.",
				detail: error instanceof Error ? error.message : String(error),
				remediation: "Check the repository path and git permissions.",
			};
		}
	}

	private checkSchedulerConfig(config: AppConfig): DoctorCheck {
		const detectedProvider = schedulerService.detectProvider();

		if (!config.automation.enabled) {
			return {
				id: "scheduler-config",
				label: "Automation scheduler",
				status: "pass",
				summary: "Automation is disabled; no scheduler is required.",
				detail: `Detected provider: ${detectedProvider}`,
			};
		}

		if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(config.automation.scheduleTime)) {
			return {
				id: "scheduler-config",
				label: "Automation scheduler",
				status: "fail",
				summary: "Automation is enabled but scheduleTime is invalid.",
				detail: config.automation.scheduleTime,
				remediation: "Set automation.scheduleTime to HH:mm.",
			};
		}

		if (detectedProvider === "manual") {
			return {
				id: "scheduler-config",
				label: "Automation scheduler",
				status: "warn",
				summary:
					"Automation is enabled, but this platform needs manual scheduler setup.",
				remediation:
					'Use "openmeta automation status" to copy the manual scheduler command.',
			};
		}

		return {
			id: "scheduler-config",
			label: "Automation scheduler",
			status: "pass",
			summary: `${detectedProvider} can run automation at ${config.automation.scheduleTime}.`,
			detail: `Configured timezone: ${config.automation.timezone}`,
		};
	}

	private countStatuses(
		checks: DoctorCheck[],
	): Record<DoctorCheckStatus, number> {
		return checks.reduce<Record<DoctorCheckStatus, number>>(
			(totals, check) => {
				totals[check.status] += 1;
				return totals;
			},
			{ pass: 0, warn: 0, fail: 0 },
		);
	}

	private statusLabel(status: DoctorCheckStatus): string {
		if (status === "pass") {
			return "[pass]";
		}

		if (status === "warn") {
			return "[warn]";
		}

		return "[fail]";
	}

	private toneForStatus(
		status: DoctorCheckStatus,
	): "success" | "warning" | "error" {
		if (status === "pass") {
			return "success";
		}

		if (status === "warn") {
			return "warning";
		}

		return "error";
	}
}

export const doctorOrchestrator = new DoctorOrchestrator();
