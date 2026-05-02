import { readFileSync } from "fs";
import { join } from "path";
import type { Octokit } from "@octokit/rest";
import type { PullRequestDraft } from "../contracts/index.js";
import type { RankedIssue } from "../types/index.js";
import { logger } from "../infra/index.js";
import { contentService } from "./content.js";
import { githubService } from "./github.js";

export interface ContributionRepositoryContext {
	path: string;
	owner: string;
	repo: string;
	defaultBranch: string;
}

export interface DraftPullRequest {
	title: string;
	body: string;
}

export interface ContributionPrSubmissionInput {
	issue: RankedIssue;
	prDraft: PullRequestDraft;
	workspacePath: string;
	changedFiles: string[];
}

export interface ContributionPrSubmissionResult {
	branchName: string;
	url: string;
	number: number;
}

export class ContributionPrService {
	private octokit: Octokit | null = null;

	initialize(octokit: Octokit): void {
		this.octokit = octokit;
	}

	async submitDraftPullRequest(
		input: ContributionPrSubmissionInput,
	): Promise<ContributionPrSubmissionResult> {
		const upstreamRepo = await this.getUpstreamRepositoryContext(input.issue);
		const forkRepo = await this.ensureForkRepository(upstreamRepo);
		const branchName = this.buildPublishBranchName(input.issue);
		const draftPullRequest = this.buildDraftPullRequest(input.prDraft);
		const commitMessage = this.buildContributionCommitMessage(input.issue);

		await this.createCommitOnFork({
			forkRepo,
			branchName,
			workspacePath: input.workspacePath,
			changedFiles: input.changedFiles,
			commitMessage,
		});

		const contributionPullRequest = await this.createContributionPullRequest(
			upstreamRepo,
			forkRepo.owner,
			branchName,
			draftPullRequest,
		);

		return {
			branchName,
			url: contributionPullRequest.url,
			number: contributionPullRequest.number,
		};
	}

	buildDraftPullRequest(prDraft: PullRequestDraft): DraftPullRequest {
		return {
			title: prDraft.title,
			body: contentService.formatPullRequestDraftBody(prDraft),
		};
	}

	buildPublishBranchName(issue: RankedIssue): string {
		const slug = issue.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32);

		return `openmeta/agent-${issue.number}-${slug || "issue"}-${Date.now()}`;
	}

	buildContributionCommitMessage(issue: RankedIssue): string {
		return `feat: address ${issue.repoFullName}#${issue.number} ${issue.title}`.slice(
			0,
			120,
		);
	}

	private async getUpstreamRepositoryContext(
		issue: RankedIssue,
	): Promise<ContributionRepositoryContext> {
		const [owner, repo] = issue.repoFullName.split("/");
		if (!owner || !repo) {
			throw new Error(
				`Invalid issue repository reference: ${issue.repoFullName}`,
			);
		}

		const repoInfo = await this.getGitHubRepositoryInfo(owner, repo);
		return {
			path: "",
			owner,
			repo,
			defaultBranch: repoInfo.default_branch || "main",
		};
	}

	private async ensureForkRepository(
		upstreamRepo: ContributionRepositoryContext,
	): Promise<ContributionRepositoryContext> {
		const octokit = this.getOctokit();
		const forkOwner = githubService.getUsername();

		try {
			const { data } = await octokit.rest.repos.get({
				owner: forkOwner,
				repo: upstreamRepo.repo,
			});

			if (
				!data.fork ||
				data.parent?.full_name !== `${upstreamRepo.owner}/${upstreamRepo.repo}`
			) {
				throw new Error(
					`Repository ${forkOwner}/${upstreamRepo.repo} exists but is not a fork of ${upstreamRepo.owner}/${upstreamRepo.repo}.`,
				);
			}

			await this.syncForkWithUpstream(
				forkOwner,
				upstreamRepo.repo,
				data.default_branch || upstreamRepo.defaultBranch,
			);
			return {
				path: "",
				owner: forkOwner,
				repo: upstreamRepo.repo,
				defaultBranch: data.default_branch || upstreamRepo.defaultBranch,
			};
		} catch (error) {
			const err = error as { status?: number };
			if (err.status && err.status !== 404) {
				throw error;
			}
		}

		logger.info(`Creating fork for ${upstreamRepo.owner}/${upstreamRepo.repo}`);
		await octokit.rest.repos.createFork({
			owner: upstreamRepo.owner,
			repo: upstreamRepo.repo,
		});

		const fork = await this.waitForFork(
			forkOwner,
			upstreamRepo.repo,
			`${upstreamRepo.owner}/${upstreamRepo.repo}`,
		);
		await this.syncForkWithUpstream(
			forkOwner,
			upstreamRepo.repo,
			fork.default_branch || upstreamRepo.defaultBranch,
		);

		return {
			path: "",
			owner: forkOwner,
			repo: upstreamRepo.repo,
			defaultBranch: fork.default_branch || upstreamRepo.defaultBranch,
		};
	}

	private async waitForFork(
		owner: string,
		repo: string,
		expectedParent: string,
	) {
		const octokit = this.getOctokit();

		for (let attempt = 0; attempt < 8; attempt += 1) {
			try {
				const { data } = await octokit.rest.repos.get({ owner, repo });
				if (data.fork && data.parent?.full_name === expectedParent) {
					return data;
				}
			} catch {
				// Continue polling until the fork is visible.
			}

			await this.delay(1500);
		}

		throw new Error(`Fork ${owner}/${repo} was not ready in time.`);
	}

	private async syncForkWithUpstream(
		owner: string,
		repo: string,
		branch: string,
	): Promise<void> {
		const octokit = this.getOctokit();

		try {
			await octokit.rest.repos.mergeUpstream({
				owner,
				repo,
				branch,
			});
		} catch (error) {
			logger.debug(
				`Unable to sync fork ${owner}/${repo} with upstream before opening a PR`,
				error,
			);
		}
	}

	private async createCommitOnFork(input: {
		forkRepo: ContributionRepositoryContext;
		branchName: string;
		workspacePath: string;
		changedFiles: string[];
		commitMessage: string;
	}): Promise<void> {
		const octokit = this.getOctokit();
		const branch = await octokit.rest.repos.getBranch({
			owner: input.forkRepo.owner,
			repo: input.forkRepo.repo,
			branch: input.forkRepo.defaultBranch,
		});

		const baseCommitSha = branch.data.commit.sha;
		const baseTreeSha = branch.data.commit.commit.tree.sha;

		const tree = input.changedFiles.map((filePath) => ({
			path: filePath,
			mode: "100644" as const,
			type: "blob" as const,
			content: readFileSync(join(input.workspacePath, filePath), "utf-8"),
		}));

		const createdTree = await octokit.rest.git.createTree({
			owner: input.forkRepo.owner,
			repo: input.forkRepo.repo,
			base_tree: baseTreeSha,
			tree,
		});

		const createdCommit = await octokit.rest.git.createCommit({
			owner: input.forkRepo.owner,
			repo: input.forkRepo.repo,
			message: input.commitMessage,
			tree: createdTree.data.sha,
			parents: [baseCommitSha],
		});

		try {
			await octokit.rest.git.createRef({
				owner: input.forkRepo.owner,
				repo: input.forkRepo.repo,
				ref: `refs/heads/${input.branchName}`,
				sha: createdCommit.data.sha,
			});
		} catch (error) {
			const err = error as { status?: number };
			if (err.status !== 422) {
				throw error;
			}

			await octokit.rest.git.updateRef({
				owner: input.forkRepo.owner,
				repo: input.forkRepo.repo,
				ref: `heads/${input.branchName}`,
				sha: createdCommit.data.sha,
				force: true,
			});
		}
	}

	private async createContributionPullRequest(
		upstreamRepo: ContributionRepositoryContext,
		forkOwner: string,
		branchName: string,
		draftPullRequest: DraftPullRequest,
	): Promise<{ url: string; number: number }> {
		const octokit = this.getOctokit();
		const existing = await octokit.rest.pulls.list({
			owner: upstreamRepo.owner,
			repo: upstreamRepo.repo,
			head: `${forkOwner}:${branchName}`,
			base: upstreamRepo.defaultBranch,
			state: "open",
		});

		const [existingPullRequest] = existing.data;
		if (existingPullRequest) {
			return {
				url: existingPullRequest.html_url,
				number: existingPullRequest.number,
			};
		}

		const { data } = await octokit.rest.pulls.create({
			owner: upstreamRepo.owner,
			repo: upstreamRepo.repo,
			title: draftPullRequest.title,
			body: draftPullRequest.body,
			head: `${forkOwner}:${branchName}`,
			base: upstreamRepo.defaultBranch,
			draft: true,
		});

		return {
			url: data.html_url,
			number: data.number,
		};
	}

	private async getGitHubRepositoryInfo(owner: string, repo: string) {
		const octokit = this.getOctokit();
		const { data } = await octokit.rest.repos.get({ owner, repo });
		return data;
	}

	private getOctokit(): Octokit {
		if (!this.octokit) {
			throw new Error("GitHub service not initialized");
		}

		return this.octokit;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}
}

export const contributionPrService = new ContributionPrService();
