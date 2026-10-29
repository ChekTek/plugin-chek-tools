import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelReview } from "./services/review-service";

/** A single line-level comment from a model review, with a direct link to the platform. */
export type Finding = {
	severity: "high" | "medium" | "low" | "nit";
	file: string;
	line: number | null;
	title: string;
	body: string;
	url: string | null;
};

/** The output of one model reviewing one PR/MR. */
export type Review = {
	model: string;
	label: string;
	status: "queued" | "running" | "done" | "error" | "cancelled";
	startedAt: string;
	finishedAt?: string;
	verdict?: "approve" | "request_changes" | "comment";
	summary?: string;
	findings?: Finding[];
	error?: string;
};

/** A pull request (GitHub) or merge request (GitLab): one waiting on my review, or one I opened. */
export type ChangeRequest = {
	id: string;
	platform: "github" | "gitlab";
	kind: "review" | "mine";
	/** Platform status for my own PRs, e.g. "approved" or "changes requested". */
	status?: string;
	repo: string;
	number: number;
	title: string;
	author: string;
	url: string;
	filesUrl: string;
	reason: string;
	updatedAt: string;
	headSha: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	draft?: boolean;
	reviews: Review[];
};

/** Anything else from a notification feed (issue, discussion, release...). */
export type Notification = {
	id: string;
	platform: "github" | "gitlab";
	type: string;
	reason: string;
	title: string;
	repo: string;
	url: string;
	updatedAt: string;
};

export type JiraTicket = {
	key: string;
	summary: string;
	status: string;
	type: string;
	priority: string;
	url: string;
};

export type Bookmark = {
	name: string;
	url: string;
};

export type Job = {
	status: "idle" | "running" | "done" | "error";
	startedAt?: string;
	finishedAt?: string;
	message?: string;
};

export type DashboardState = {
	jobs: { github: Job; gitlab: Job; jira: Job };
	github: { changes: ChangeRequest[]; notifications: Notification[] };
	gitlab: { changes: ChangeRequest[]; notifications: Notification[] };
	jira: { tickets: JiraTicket[]; site: string; boardUrl?: string };
	bookmarks: Bookmark[];
	lastRefresh?: { startedAt: string; finishedAt?: string };
};

const dataDir = join(homedir(), ".chek-tools");
const stateFile = join(dataDir, "dashboard.json");

function emptyState(): DashboardState {
	return {
		jobs: { github: { status: "idle" }, gitlab: { status: "idle" }, jira: { status: "idle" } },
		github: { changes: [], notifications: [] },
		gitlab: { changes: [], notifications: [] },
		jira: { tickets: [], site: "" },
		bookmarks: []
	};
}

function load(): DashboardState {
	try {
		if (existsSync(stateFile)) {
			const saved = JSON.parse(readFileSync(stateFile, "utf8")) as DashboardState;
			const state = { ...emptyState(), ...saved };
			// A job can't still be running after a restart.
			for (const job of Object.values(state.jobs)) {
				if (job.status === "running") job.status = "idle";
			}
			for (const cr of [...state.github.changes, ...state.gitlab.changes]) {
				// Queued reviews never started, so the next refresh queues them again.
				cr.reviews = cr.reviews.filter((r) => r.status !== "queued");
				for (const r of cr.reviews) {
					if (r.status === "running") {
						r.status = "error";
						r.error = "Plugin restarted before the review finished.";
					}
				}
			}
			return state;
		}
	} catch {
		// Corrupt file: start fresh.
	}
	return emptyState();
}

/**
 * The single in-memory dashboard state, persisted to ~/.chek-tools/dashboard.json and
 * broadcast to the dashboard page whenever it changes.
 */
class PluginStore extends EventEmitter {
	public state: DashboardState = load();

	/** Apply a mutation, persist, and notify listeners. */
	update(mutate: (s: DashboardState) => void): void {
		mutate(this.state);
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(stateFile, JSON.stringify(this.state, null, "\t"));
		this.emit("change", this.state);
	}

	/** Replaces a change request's reviews with a queued slot per model. */
	queueReviews(cr: ChangeRequest, models: readonly { model: string; label: string }[]): void {
		this.update((s) => {
			const current = this.find(s, cr);
			if (current) current.reviews = models.map(({ model, label }) => ({ model, label, status: "queued", startedAt: new Date().toISOString() }));
		});
	}

	/** Marks a model's review slot on a change request as running. */
	startReview(cr: ChangeRequest, model: string, label: string): void {
		this.update((s) => {
			const current = this.find(s, cr);
			if (!current) return;
			current.reviews = current.reviews.filter((r) => r.model !== model);
			current.reviews.push({ model, label, status: "running", startedAt: new Date().toISOString() });
		});
	}

	finishReview(cr: ChangeRequest, model: string, result: ModelReview | Error | "cancelled"): void {
		this.update((s) => {
			const review = this.find(s, cr)?.reviews.find((r) => r.model === model);
			if (!review) return;
			review.finishedAt = new Date().toISOString();
			if (result === "cancelled") {
				review.status = "cancelled";
			} else if (result instanceof Error) {
				review.status = "error";
				review.error = result.message;
			} else {
				review.status = "done";
				review.verdict = result.verdict;
				review.summary = result.summary;
				review.findings = result.findings;
			}
		});
	}

	/** The stored change request, as long as it still has the head the caller reviewed. */
	private find(s: DashboardState, cr: ChangeRequest): ChangeRequest | undefined {
		const current = s[cr.platform].changes.find((c) => c.id === cr.id);
		return current?.headSha === cr.headSha ? current : undefined;
	}

	setJob(name: keyof DashboardState["jobs"], job: Partial<Job>): void {
		this.update((s) => {
			s.jobs[name] = { ...s.jobs[name], ...job };
		});
	}
}

export default new PluginStore();
