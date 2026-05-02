const PROMPT_ABORT_ERROR_NAMES = new Set([
	"ExitPromptError",
	"AbortPromptError",
	"PromptAbortError",
]);

export class UserCancelledError extends Error {
	constructor(message: string = "User cancelled the current command.") {
		super(message);
		this.name = "UserCancelledError";
	}
}

export function isPromptAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	if (PROMPT_ABORT_ERROR_NAMES.has(error.name)) {
		return true;
	}

	return /force closed the prompt|prompt was canceled|canceled prompt/i.test(
		error.message,
	);
}

export function isUserCancelledError(error: unknown): boolean {
	return error instanceof UserCancelledError || isPromptAbortError(error);
}

export function getErrorMessage(
	error: unknown,
	fallback: string = "Something went wrong. Please try again.",
): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message.trim();
	}

	if (typeof error === "string" && error.trim().length > 0) {
		return error.trim();
	}

	return fallback;
}
