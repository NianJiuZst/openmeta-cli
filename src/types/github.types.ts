export interface GitHubIssue {
	id: number;
	number: number;
	title: string;
	body: string;
	htmlUrl: string;
	repoName: string;
	repoFullName: string;
	repoDescription: string;
	repoStars: number;
	labels: string[];
	createdAt: string;
	updatedAt: string;
}

export interface MatchedIssue extends GitHubIssue {
	matchScore: number;
	analysis: {
		coreDemand: string;
		techRequirements: string[];
		solutionSuggestion: string;
		estimatedWorkload: string;
	};
}
