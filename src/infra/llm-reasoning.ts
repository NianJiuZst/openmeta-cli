import type { LLMReasoningEffort } from '../types/index.js';

export const LLM_REASONING_EFFORTS = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
] as const satisfies readonly LLMReasoningEffort[];
export const DEFAULT_LLM_REASONING_EFFORT: LLMReasoningEffort = 'none';

export function parseLLMReasoningEffort(value: string): LLMReasoningEffort {
	const normalized = value.trim().toLowerCase();
	if (LLM_REASONING_EFFORTS.includes(normalized as LLMReasoningEffort)) {
		return normalized as LLMReasoningEffort;
	}

	throw new Error(`llm.reasoningEffort must be one of: ${LLM_REASONING_EFFORTS.join(', ')}.`);
}
