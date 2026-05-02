import { describe, expect, test } from "bun:test";
import { issueRankingService, llmService } from "../src/services/index.js";
import {
	createIssue,
	createMatchedIssue,
	createRankedIssue,
} from "./helpers/factories.js";

describe("IssueRankingService", () => {
	test("selects the first issue that meets the automation threshold", () => {
		const issues = [
			createRankedIssue({
				opportunity: { ...createRankedIssue().opportunity, overallScore: 68 },
			}),
			createRankedIssue({
				repoFullName: "acme/high",
				repoName: "high",
				number: 77,
				opportunity: { ...createRankedIssue().opportunity, overallScore: 81 },
			}),
		];

		const selected = issueRankingService.selectIssueForAutomation(issues, 70);
		expect(selected?.repoFullName).toBe("acme/high");
	});

	test("diversifies scout display across repositories before filling repeats", () => {
		const issues = [
			createRankedIssue({ repoFullName: "acme/a", repoName: "a", number: 1 }),
			createRankedIssue({ repoFullName: "acme/a", repoName: "a", number: 2 }),
			createRankedIssue({ repoFullName: "acme/b", repoName: "b", number: 3 }),
			createRankedIssue({ repoFullName: "acme/c", repoName: "c", number: 4 }),
		];

		const visible = issueRankingService.diversifyScoutIssues(issues, 3);

		expect(
			visible.map((issue) => `${issue.repoFullName}#${issue.number}`),
		).toEqual(["acme/a#1", "acme/b#3", "acme/c#4"]);
	});

	test("pre-ranks issue discovery candidates against the saved profile", () => {
		const ranked = issueRankingService.rankIssuesForProfile(
			[
				createIssue({
					repoFullName: "acme/python-tool",
					repoName: "python-tool",
					number: 1,
					title: "Add pytest coverage for serializers",
					body: "Fresh issue with unrelated Python testing work.",
					repoDescription: "Python API utilities",
					updatedAt: new Date().toISOString(),
				}),
				createIssue({
					repoFullName: "acme/react-ui",
					repoName: "react-ui",
					number: 2,
					title: "Fix React keyboard focus in dropdown",
					body: "The issue is in `src/components/Dropdown.tsx`. Steps to reproduce: tab into the menu. Expected focus moves to the first item.",
					repoDescription: "Accessible TypeScript React components",
					updatedAt: "2026-03-01T08:00:00.000Z",
				}),
			],
			{
				techStack: ["TypeScript", "React"],
				proficiency: "intermediate",
				focusAreas: ["web-dev"],
			},
		);

		expect(ranked[0]?.repoFullName).toBe("acme/react-ui");
	});

	test("scores all candidate batches instead of stopping after the first matching batch", async () => {
		const originalScoreIssues = llmService.scoreIssues;
		const batches: number[][] = [];
		const issues = Array.from({ length: 25 }, (_, index) =>
			createIssue({
				id: index + 1,
				number: index + 1,
				repoFullName: `acme/repo-${index + 1}`,
				repoName: `repo-${index + 1}`,
				title: `React issue ${index + 1}`,
			}),
		);

		try {
			llmService.scoreIssues = async (_profile, batch) => {
				batches.push(batch.map((issue) => issue.number));
				return {
					version: "1",
					kind: "issue_match_list",
					status: "success",
					data: batch.map((issue) =>
						createMatchedIssue({
							...issue,
							matchScore: 72,
						}),
					),
				};
			};

			const matches = await issueRankingService.scoreIssuesInBatches(
				{
					techStack: ["React"],
					proficiency: "intermediate",
					focusAreas: ["web-dev"],
				},
				issues,
			);

			expect(batches).toHaveLength(2);
			expect(matches).toHaveLength(25);
		} finally {
			llmService.scoreIssues = originalScoreIssues;
		}
	});

	test("builds local heuristic issue matches without LLM scoring", () => {
		const matches = issueRankingService.buildLocalIssueMatches(
			[
				createIssue({
					repoFullName: "acme/react-ui",
					repoName: "react-ui",
					number: 12,
					title: "Fix React focus trap in menu",
					body: "The bug is in `src/Menu.tsx`. Steps to reproduce: tab through the menu. Expected focus stays inside.",
					labels: ["good first issue", "accessibility"],
					repoDescription: "TypeScript React component library",
					repoStars: 420,
				}),
			],
			{
				techStack: ["TypeScript", "React"],
				proficiency: "intermediate",
				focusAreas: ["web-dev"],
			},
		);

		expect(matches).toHaveLength(1);
		expect(matches[0]?.matchScore).toBeGreaterThan(60);
		expect(matches[0]?.analysis.techRequirements).toContain("TypeScript");
		expect(matches[0]?.analysis.techRequirements).toContain("React");
		expect(matches[0]?.analysis.estimatedWorkload).toBe("1-3 hours");
		expect(matches[0]?.analysis.solutionSuggestion).toContain(
			"Local scout mode",
		);
	});
});
