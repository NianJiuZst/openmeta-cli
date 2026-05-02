import { describe, expect, test } from "bun:test";
import { getDailyNoteFileName, getLocalDateStamp } from "../src/infra/date.js";

describe("date helpers", () => {
	test("formats local date stamp with zero padding", () => {
		const date = new Date("2026-04-09T12:34:56.000Z");

		expect(getLocalDateStamp(date)).toBe("2026-04-09");
	});

	test("builds daily note file name from local date stamp", () => {
		const date = new Date("2026-12-01T12:34:56.000Z");

		expect(getDailyNoteFileName(date)).toBe("openmeta-daily-2026-12-01.md");
	});
});
