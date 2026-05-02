import * as p from "@clack/prompts";
import { UserCancelledError } from "./errors.js";

export interface SelectChoice<T> {
	name: string;
	value: T;
	description?: string;
	disabled?: boolean | string;
}

export async function selectPrompt<T>(options: {
	message: string;
	choices: SelectChoice<T>[];
	default?: T;
	pageSize?: number;
}): Promise<T> {
	const mappedOptions = options.choices.map((choice) => ({
		value: choice.value,
		label: choice.name,
		...(choice.description ? { hint: choice.description } : {}),
		...(choice.disabled ? { disabled: true } : {}),
	})) as Parameters<typeof p.select<T>>[0]["options"];

	const result = await p.select<T>({
		message: options.message,
		options: mappedOptions,
		initialValue: options.default,
		maxItems: options.pageSize ?? 10,
	});

	if (p.isCancel(result)) {
		throw new UserCancelledError();
	}

	return result as T;
}
