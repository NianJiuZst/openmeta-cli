import * as p from "@clack/prompts";
import { UserCancelledError } from "./errors.js";

type PromptQuestion =
	| {
			type: "input";
			name: string;
			message: string;
			default?: string;
			filter?: (input: string) => string;
			validate?: (
				input: string,
			) => string | Error | boolean | Promise<string | Error | boolean>;
	  }
	| {
			type: "password";
			name: string;
			message: string;
			mask?: string;
			validate?: (
				input: string,
			) => string | Error | boolean | Promise<string | Error | boolean>;
	  }
	| {
			type: "confirm";
			name: string;
			message: string;
			default?: boolean;
	  }
	| {
			type: "checkbox";
			name: string;
			message: string;
			choices: Array<{
				name: string;
				value: string;
				checked?: boolean;
				disabled?: boolean | string;
			}>;
			validate?: (
				input: string[],
			) => string | Error | boolean | Promise<string | Error | boolean>;
	  };

function isCancelled(value: unknown): boolean {
	return p.isCancel(value);
}

function ensureNotCancelled<T>(value: T | symbol): T {
	if (isCancelled(value)) {
		throw new UserCancelledError();
	}

	return value as T;
}

async function normalizeValidationResult(
	result:
		| string
		| Error
		| boolean
		| undefined
		| void
		| Promise<string | Error | boolean | undefined | void>,
): Promise<string | undefined> {
	const resolved = await result;
	if (resolved === true || resolved === undefined) {
		return undefined;
	}

	if (resolved === false) {
		return "Invalid value.";
	}

	if (resolved instanceof Error) {
		return resolved.message;
	}

	return resolved;
}

async function askInput(
	question: Extract<PromptQuestion, { type: "input" }>,
): Promise<string> {
	while (true) {
		const rawValue = ensureNotCancelled(
			await p.text({
				message: question.message,
				initialValue: question.default,
			}),
		);

		const value = question.filter ? question.filter(rawValue) : rawValue;
		const validationError = question.validate
			? await normalizeValidationResult(question.validate(value))
			: undefined;
		if (!validationError) {
			return value;
		}

		p.log.error(validationError);
	}
}

async function askPassword(
	question: Extract<PromptQuestion, { type: "password" }>,
): Promise<string> {
	while (true) {
		const value = ensureNotCancelled(
			await p.password({
				message: question.message,
				mask: question.mask,
			}),
		);

		const validationError = question.validate
			? await normalizeValidationResult(question.validate(value))
			: undefined;
		if (!validationError) {
			return value;
		}

		p.log.error(validationError);
	}
}

async function askConfirm(
	question: Extract<PromptQuestion, { type: "confirm" }>,
): Promise<boolean> {
	return ensureNotCancelled(
		await p.confirm({
			message: question.message,
			initialValue: question.default,
		}),
	);
}

async function askCheckbox(
	question: Extract<PromptQuestion, { type: "checkbox" }>,
): Promise<string[]> {
	while (true) {
		const values = ensureNotCancelled(
			await p.multiselect({
				message: question.message,
				options: question.choices.map((choice) => ({
					value: choice.value,
					label: choice.name,
					disabled: Boolean(choice.disabled),
				})),
				initialValues: question.choices
					.filter((choice) => choice.checked)
					.map((choice) => choice.value),
				required: false,
			}),
		);

		const validationError = question.validate
			? await normalizeValidationResult(question.validate(values))
			: undefined;
		if (!validationError) {
			return values;
		}

		p.log.error(validationError);
	}
}

async function askQuestion(question: PromptQuestion): Promise<unknown> {
	switch (question.type) {
		case "input":
			return askInput(question);
		case "password":
			return askPassword(question);
		case "confirm":
			return askConfirm(question);
		case "checkbox":
			return askCheckbox(question);
		default:
			throw new Error(
				`Unsupported prompt type: ${(question as { type?: string }).type ?? "unknown"}`,
			);
	}
}

export async function prompt<T extends object>(questions: unknown): Promise<T> {
	const questionList = questions as PromptQuestion[];
	const answers: Record<string, unknown> = {};

	for (const question of questionList) {
		answers[question.name] = await askQuestion(question);
	}

	return answers as T;
}
