import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { simpleGit } from "simple-git";
import { gitService } from "../src/services/git.js";

const tempDirs: string[] = [];

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "openmeta-git-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("gitService.writeAndPublish", () => {
	test("publishes artifacts on an isolated branch instead of the current branch", async () => {
		const repoPath = makeRepo();
		const git = simpleGit(repoPath);

		await git.init(["--initial-branch=main"]);
		await git.addConfig("user.name", "OpenMeta Test");
		await git.addConfig("user.email", "openmeta@example.com");
		writeFileSync(join(repoPath, "README.md"), "# Demo\n", "utf-8");
		await git.add("README.md");
		await git.commit("chore: initial commit");
		await git.checkoutLocalBranch("feature/local-work");

		const initialized = await gitService.initialize(repoPath);
		expect(initialized).toBe(true);

		const publishResult = await gitService.writeAndPublish(
			[{ path: "INBOX.md", content: "# Inbox\n" }],
			"feat: publish inbox",
			{
				branchName: "openmeta-artifacts",
				baseBranch: "main",
			},
		);

		expect(publishResult?.branch).toBe("openmeta-artifacts");

		const currentBranch = await git.branchLocal();
		expect(currentBranch.current).toBe("openmeta-artifacts");

		const publishedFile = await git.show(["openmeta-artifacts:INBOX.md"]);
		expect(publishedFile).toContain("# Inbox");

		let featureBranchHasArtifact = true;
		try {
			await git.show(["feature/local-work:INBOX.md"]);
		} catch {
			featureBranchHasArtifact = false;
		}

		expect(featureBranchHasArtifact).toBe(false);
	});
});
