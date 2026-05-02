import { configService, prompt, ui } from "../infra/index.js";
import { schedulerService } from "../services/index.js";

export class AutomationOrchestrator {
	async status(): Promise<void> {
		const config = await configService.get();

		ui.hero({
			label: "OpenMeta Automation",
			title: config.automation.enabled
				? "The unattended loop is warm and waiting"
				: "The unattended loop is quiet, waiting for your signal",
			subtitle: config.automation.enabled
				? "A persistent scheduler is already holding the line for headless agent runs."
				: "No persistent scheduler is active right now. Manual runs are still one clean command away.",
			lines: [
				`Schedule: ${config.automation.scheduleTime} (${config.automation.timezone})`,
				`Scheduler provider: ${config.automation.scheduler}`,
			],
			tone: config.automation.enabled ? "warning" : "accent",
		});

		ui.stats("Automation snapshot", [
			{
				label: "Status",
				value: config.automation.enabled ? "ENABLED" : "DISABLED",
				tone: config.automation.enabled ? "warning" : "muted",
			},
			{
				label: "Mode",
				value: "HEADLESS",
				tone: "info",
			},
			{
				label: "Content type",
				value: config.automation.contentType.toUpperCase(),
				tone: "info",
			},
			{
				label: "Min score",
				value: String(config.automation.minMatchScore),
				tone: "accent",
			},
		]);

		ui.keyValues("Runtime policy", [
			{
				label: "Schedule",
				value: `${config.automation.scheduleTime} (${config.automation.timezone})`,
				tone: "info",
			},
			{ label: "Scheduler", value: config.automation.scheduler, tone: "info" },
			{ label: "Headless agent", value: "yes", tone: "warning" },
			{
				label: "Skip if already generated today",
				value: config.automation.skipIfAlreadyGeneratedToday ? "yes" : "no",
				tone: "info",
			},
			{
				label: "Disable command",
				value: "openmeta automation disable",
				tone: "muted",
			},
		]);

		ui.callout({
			label: "OpenMeta Automation",
			title: config.automation.enabled
				? "Review automation risk posture"
				: "Automation is currently manual-only",
			subtitle: config.automation.enabled
				? "Scheduled runs can publish generated artifacts and may open a real draft PR without an extra interactive review step."
				: "Enable automation only if you are comfortable letting OpenMeta run the contribution loop unattended on your machine.",
			tone: config.automation.enabled ? "warning" : "info",
		});
	}

	async enable(): Promise<void> {
		const config = await configService.get();

		if (config.automation.enabled) {
			ui.callout({
				label: "OpenMeta Automation",
				title: "Automation already enabled",
				subtitle:
					"The persistent scheduler is already configured for unattended runs.",
				lines: [
					`Schedule: ${config.automation.scheduleTime} (${config.automation.timezone})`,
					"Disable command: openmeta automation disable",
				],
				tone: "info",
			});
			return;
		}

		ui.callout({
			label: "OpenMeta Automation",
			title: "Persistent automation warning",
			subtitle:
				"Enabling this installs a long-running scheduled task that will execute the OpenMeta agent every day until disabled.",
			lines: [
				`Schedule: ${config.automation.scheduleTime} (${config.automation.timezone})`,
				"Scheduled runs use headless agent mode and can commit and push generated artifacts without interactive review.",
				"Disable command: openmeta automation disable",
			],
			tone: "warning",
		});

		ui.keyValues("Impact summary", [
			{
				label: "Execution mode",
				value: "Headless autonomous agent",
				tone: "warning",
			},
			{
				label: "Review gate",
				value: "No interactive review during scheduled runs",
				tone: "warning",
			},
			{
				label: "Publish behavior",
				value: "Artifacts may be committed and pushed automatically",
				tone: "warning",
			},
			{
				label: "Rollback",
				value: 'Run "openmeta automation disable"',
				tone: "info",
			},
		]);

		const { acknowledgePersistence } = await prompt<{
			acknowledgePersistence: boolean;
		}>([
			{
				type: "confirm",
				name: "acknowledgePersistence",
				message:
					"Do you understand that this creates a persistent scheduled task on your machine?",
				default: false,
			},
		]);

		if (!acknowledgePersistence) {
			ui.callout({
				label: "OpenMeta Automation",
				title: "Automation not enabled",
				subtitle: "The persistent scheduler was not installed.",
				tone: "warning",
			});
			return;
		}

		const { finalConsent } = await prompt<{ finalConsent: boolean }>([
			{
				type: "confirm",
				name: "finalConsent",
				message: "Enable unattended agent automation now?",
				default: false,
			},
		]);

		if (!finalConsent) {
			ui.callout({
				label: "OpenMeta Automation",
				title: "Automation not enabled",
				subtitle: "The persistent scheduler was not installed.",
				tone: "warning",
			});
			return;
		}

		const updated = {
			...config,
			automation: {
				...config.automation,
				enabled: true,
			},
		};

		await configService.save(updated);
		const result = await schedulerService.sync(updated);

		ui.card({
			label: "OpenMeta Automation",
			title:
				result.status === "installed"
					? "The unattended loop is now alive"
					: "Automation needs attention",
			subtitle: result.detail,
			lines: [
				`Schedule: ${updated.automation.scheduleTime} (${updated.automation.timezone})`,
				`Scheduler: ${updated.automation.scheduler}`,
				`Content type: ${updated.automation.contentType}`,
				"Disable command: openmeta automation disable",
			],
			tone: result.status === "installed" ? "success" : "warning",
		});
	}

	async disable(): Promise<void> {
		const config = await configService.get();

		ui.callout({
			label: "OpenMeta Automation",
			title: "Disable persistent automation",
			subtitle:
				"This removes the system scheduler so the OpenMeta agent stops running automatically.",
			lines: [
				`Current schedule: ${config.automation.scheduleTime} (${config.automation.timezone})`,
				'Manual runs via "openmeta agent" and "openmeta daily" will still work.',
			],
			tone: "warning",
		});

		const { confirmDisable } = await prompt<{ confirmDisable: boolean }>([
			{
				type: "confirm",
				name: "confirmDisable",
				message: "Disable unattended agent automation?",
				default: false,
			},
		]);

		if (!confirmDisable) {
			ui.callout({
				label: "OpenMeta Automation",
				title: "Automation unchanged",
				subtitle: "The persistent scheduler is still in its previous state.",
				tone: "info",
			});
			return;
		}

		const updated = {
			...config,
			automation: {
				...config.automation,
				enabled: false,
			},
		};

		await configService.save(updated);
		const result = await schedulerService.sync(updated);

		ui.card({
			label: "OpenMeta Automation",
			title:
				result.status === "removed"
					? "The unattended loop has gone quiet"
					: "Automation disable needs attention",
			subtitle: result.detail,
			lines: [
				`Scheduler: ${updated.automation.scheduler}`,
				'You can re-enable it later with "openmeta automation enable".',
			],
			tone: result.status === "removed" ? "success" : "warning",
		});
	}
}

export const automationOrchestrator = new AutomationOrchestrator();
