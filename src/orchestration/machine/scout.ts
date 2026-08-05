import { runInMachineContext } from '../../infra/index.js';
import { agentOrchestrator } from '../index.js';
import { mapMachineError } from './errors.js';
import { buildMachineEnvelope, writeMachinePayload, writeMachinePlan } from './runtime.js';

export class MachineScoutOrchestrator {
  async execute(
    options: { limit?: number; refresh?: boolean; minStars?: number; maxStars?: number; repo?: string } = {},
  ): Promise<void> {
    try {
      writeMachinePlan('machine scout', [
        'Validate GitHub access',
        'Validate LLM provider',
        'Fetch and score contribution opportunities',
        'Return ranked opportunities with mode metadata',
      ]);
      const result = await runInMachineContext(() =>
        agentOrchestrator.scoutMachine({
          limit: options.limit ?? 10,
          refresh: options.refresh,
          minStars: options.minStars,
          maxStars: options.maxStars,
          repo: options.repo,
        }),
      );
      writeMachinePayload(buildMachineEnvelope('machine scout', result));
    } catch (error) {
      const mapped = mapMachineError('machine scout', error);
      writeMachinePayload(mapped.payload);
      process.exitCode = mapped.exitCode;
    }
  }
}

export const machineScoutOrchestrator = new MachineScoutOrchestrator();
