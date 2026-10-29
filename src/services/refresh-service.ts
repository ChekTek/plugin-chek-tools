import streamDeck from "@elgato/streamdeck";

import store, { type DashboardState } from "../plugin-store";
import githubService from "./github-service";
import gitlabService from "./gitlab-service";
import jiraService from "./jira-service";
import reviewService, { type ReviewJob } from "./review-service";

/** Refreshes GitHub, GitLab and Jira at once. Shared by the Refresh key, the dashboard button and the deep link. */
class RefreshService {
	private running = false;

	/**
	 * Runs all sources; resolves to whether every one succeeded. A run already in progress is
	 * reused. The AI reviews the sources queue carry on after this resolves, each change
	 * showing its own progress on the dashboard.
	 */
	async refreshAll(): Promise<boolean> {
		if (this.running) return false;
		this.running = true;
		store.update((s) => {
			s.lastRefresh = { startedAt: new Date().toISOString() };
		});

		const jobs: ReviewJob[] = [];
		try {
			const results = await Promise.all([
				this.runJob("github", async () => {
					jobs.push(...(await githubService.refresh()));
				}),
				this.runJob("gitlab", async () => {
					jobs.push(...(await gitlabService.refresh()));
				}),
				this.runJob("jira", () => jiraService.refresh())
			]);
			return results.every(Boolean);
		} finally {
			this.running = false;
			store.update((s) => {
				if (s.lastRefresh) s.lastRefresh.finishedAt = new Date().toISOString();
			});
			reviewService.reviewAll(jobs);
		}
	}

	/** Runs one source's refresh, tracking its status on the dashboard. Returns whether it succeeded. */
	private async runJob(name: keyof DashboardState["jobs"], job: () => Promise<void>): Promise<boolean> {
		store.setJob(name, { status: "running", startedAt: new Date().toISOString(), finishedAt: undefined });
		try {
			await job();
			store.setJob(name, { status: "done", finishedAt: new Date().toISOString() });
			return true;
		} catch (err) {
			streamDeck.logger.error(`${name} refresh failed: ${(err as Error).message}`);
			store.setJob(name, { status: "error", finishedAt: new Date().toISOString(), message: (err as Error).message });
			return false;
		}
	}
}

export default new RefreshService();
