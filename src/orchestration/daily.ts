import { type AgentRunOptions, agentOrchestrator } from './agent.js';

export type DailyExecutionOptions = AgentRunOptions;

export class DailyOrchestrator {
	async execute(options: DailyExecutionOptions = {}): Promise<void> {
		await agentOrchestrator.run(options);
	}
}

export const dailyOrchestrator = new DailyOrchestrator();
