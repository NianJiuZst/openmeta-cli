import { describe, expect, test } from 'bun:test';
import {
	getErrorMessage,
	isPromptAbortError,
	isUserCancelledError,
	UserCancelledError,
} from '../src/infra/errors.js';

describe('error helpers', () => {
	test('detects known prompt abort errors by name and message', () => {
		const namedError = new Error('Prompt closed');
		namedError.name = 'ExitPromptError';
		const messagedError = new Error('The user force closed the prompt before submitting.');

		expect(isPromptAbortError(namedError)).toBe(true);
		expect(isPromptAbortError(messagedError)).toBe(true);
		expect(isPromptAbortError(new Error('Unexpected network failure'))).toBe(false);
		expect(isPromptAbortError('force closed the prompt')).toBe(false);
	});

	test('classifies explicit user cancellation errors and extracts readable messages', () => {
		const cancelled = new UserCancelledError();
		const emptyMessageError = new Error('   ');

		expect(isUserCancelledError(cancelled)).toBe(true);
		expect(isUserCancelledError(new Error('prompt was canceled by operator'))).toBe(true);
		expect(isUserCancelledError(new Error('ordinary failure'))).toBe(false);
		expect(getErrorMessage(new Error('  trimmed message  '))).toBe('trimmed message');
		expect(getErrorMessage('  plain text failure  ')).toBe('plain text failure');
		expect(getErrorMessage(emptyMessageError, 'fallback message')).toBe('fallback message');
		expect(getErrorMessage(undefined, 'fallback message')).toBe('fallback message');
	});
});
