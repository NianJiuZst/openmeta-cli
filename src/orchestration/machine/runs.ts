import { runsOrchestrator } from '../index.js';
import { mapMachineError } from './errors.js';
import { buildMachineEnvelope, writeMachinePayload } from './runtime.js';

export class MachineRunsOrchestrator {
  async show(id: string | undefined, options: { limit?: number } = {}): Promise<void> {
    try {
      if (id) {
        const result = await runsOrchestrator.showMachine(id);
        writeMachinePayload(buildMachineEnvelope('machine runs', result));
        return;
      }

      const result = await runsOrchestrator.listMachine({
        limit: options.limit ?? 10,
      });
      writeMachinePayload(buildMachineEnvelope('machine runs', result));
    } catch (error) {
      const mapped = mapMachineError('machine runs', error);
      writeMachinePayload(mapped.payload);
      process.exitCode = mapped.exitCode;
    }
  }
}

export const machineRunsOrchestrator = new MachineRunsOrchestrator();
