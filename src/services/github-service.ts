import { githubLineUrl } from "../lib/diff-links";
import { mapLimit } from "../lib/concurrency";
import { run, runJson } from "../lib/exec";
import store, { type ChangeRequest, type Notification } from "../plugin-store";
import reviewService, { type ReviewJob } from "./review-service";

const PR_FIELDS = "number,title,url,body,author,headRefOid,additions,deletions,changedFiles,isDraft,state,reviewDecision,updatedAt";

/**
 * Pulls unread GitHub notifications, PRs waiting on my review and my own open PRs with the
 * gh CLI, and queues the PRs that are not mine for review. Review requests and assignments
 * come from search, not notifications, so a PR stays on the dashboard after its notification is read.
 */
class GitHubService {
	/** Refreshes the store and returns the review jobs for PRs that still need one. */
	async refresh(): Promise<ReviewJob[]> {
		store.setJob("github", { message: "Fetching notifications and PRs" });
		const [pages, me, requested, assigned, mine] = await Promise.all([
			runJson<GhNotification[][]>("gh", ["api", "notifications", "--paginate", "--slurp"]),
			this.login(),
			this.searchPrs("--review-requested=@me"),
			this.searchPrs("--assignee=@me"),
			this.searchPrs("--author=@me")
		]);

		// Every PR worth looking at, keyed by id so one PR is fetched once. Notifications win on reason.
		const candidates = new Map<string, Candidate>();
		const others: GhNotification[] = [];
		for (const n of pages.flat()) {
			const number = n.subject.type === "PullRequest" ? Number(n.subject.url?.split("/").pop()) : NaN;
			if (Number.isNaN(number)) others.push(n);
			else candidates.set(`${n.repository.full_name}#${number}`, { repo: n.repository.full_name, number, reason: n.reason, updatedAt: n.updated_at });
		}
		const addSearch = (prs: GhSearchPr[], reason: string): void => {
			for (const p of prs) {
				const id = `${p.repository.nameWithOwner}#${p.number}`;
				if (!candidates.has(id)) candidates.set(id, { repo: p.repository.nameWithOwner, number: p.number, reason });
			}
		};
		addSearch(requested, "review_requested");
		addSearch(assigned, "assigned");
		addSearch(mine, "author");

		const changes: { cr: ChangeRequest; body: string }[] = [];
		let hidden = 0;
		await mapLimit([...candidates.values()], 6, async (c) => {
			const pr = await runJson<GhPr>("gh", ["pr", "view", String(c.number), "-R", c.repo, "--json", PR_FIELDS]);
			// A notification on my own PR (GitHub sends them with reason "author") still files it under mine.
			const isMine = pr.author.login === me;
			if (pr.state !== "OPEN" || (!isMine && (await this.approvedAtHead(c.repo, pr, me)))) {
				hidden++;
				return;
			}
			changes.push({ cr: this.toChange(c.repo, pr, isMine ? "mine" : "review", c.reason, c.updatedAt ?? pr.updatedAt), body: pr.body ?? "" });
		});
		changes.sort((a, b) => b.cr.updatedAt.localeCompare(a.cr.updatedAt));

		const notifications: Notification[] = [];
		await mapLimit(others, 6, async (n) => {
			notifications.push({
				id: n.id,
				platform: "github",
				type: n.subject.type,
				reason: n.reason,
				title: n.subject.title,
				repo: n.repository.full_name,
				url: await this.htmlUrl(n),
				updatedAt: n.updated_at
			});
		});
		notifications.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

		for (const { cr } of changes) reviewService.upsertChange(cr);
		store.update((s) => {
			s.github.notifications = notifications;
			s.github.changes = s.github.changes.filter((c) => changes.some((n) => n.cr.id === c.id));
		});

		const mineCount = changes.filter((c) => c.cr.kind === "mine").length;
		const summary = `${changes.length - mineCount} to review, ${mineCount} mine, ${notifications.length} other${hidden ? `, ${hidden} hidden` : ""}`;
		store.setJob("github", { message: summary });

		// My own PRs are never reviewed by the models; I review those before filing them.
		const jobs: ReviewJob[] = [];
		for (const { cr, body } of changes) {
			if (cr.kind !== "review" || !reviewService.enqueue(cr)) continue;
			jobs.push({
				cr,
				load: async () => ({
					title: cr.title,
					author: cr.author,
					description: body,
					diff: await this.diff(cr.repo, cr.number),
					link: (file, line) => githubLineUrl(cr.url, file, line)
				})
			});
		}
		return jobs;
	}

	private async login(): Promise<string> {
		return (await run("gh", ["api", "user", "-q", ".login"])).stdout.trim();
	}

	/** Open PRs matching one `gh search prs` filter, e.g. `--author=@me`. */
	private searchPrs(filter: string): Promise<GhSearchPr[]> {
		return runJson<GhSearchPr[]>("gh", ["search", "prs", filter, "--state=open", "--limit", "100", "--json", "repository,number"]);
	}

	/**
	 * The PR's unified diff. GitHub refuses the whole-PR diff past 300 files, so fall back to
	 * stitching together the per-file patches from the files API.
	 */
	private async diff(repo: string, number: number): Promise<string> {
		try {
			return (await run("gh", ["pr", "diff", String(number), "-R", repo])).stdout;
		} catch (err) {
			if (!(err as Error).message.includes("maximum number of files")) throw err;
		}
		const pages = await runJson<GhFile[][]>("gh", ["api", `repos/${repo}/pulls/${number}/files`, "--paginate", "--slurp"]);
		return pages
			.flat()
			.map((f) => {
				const header = `diff --git a/${f.previous_filename ?? f.filename} b/${f.filename}\n--- a/${f.previous_filename ?? f.filename}\n+++ b/${f.filename}\n`;
				return header + (f.patch ?? `(no textual patch: ${f.status}, +${f.additions} -${f.deletions})`) + "\n";
			})
			.join("");
	}

	private toChange(repo: string, pr: GhPr, kind: ChangeRequest["kind"], reason: string, updatedAt: string): ChangeRequest {
		return {
			id: `${repo}#${pr.number}`,
			platform: "github",
			kind,
			status: kind === "mine" ? REVIEW_DECISIONS[pr.reviewDecision] : undefined,
			repo,
			number: pr.number,
			title: pr.title,
			author: pr.author.login,
			url: pr.url,
			filesUrl: `${pr.url}/files`,
			reason,
			updatedAt,
			headSha: pr.headRefOid,
			additions: pr.additions,
			deletions: pr.deletions,
			changedFiles: pr.changedFiles,
			draft: pr.isDraft,
			reviews: []
		};
	}

	/** True when my latest review of the PR is an approval of its current head commit. */
	private async approvedAtHead(repo: string, pr: GhPr, me: string): Promise<boolean> {
		const pages = await runJson<GhReview[][]>("gh", ["api", `repos/${repo}/pulls/${pr.number}/reviews`, "--paginate", "--slurp"]);
		// Pending (unsubmitted) reviews have no submitted_at and say nothing about approval yet.
		const mine = pages
			.flat()
			.filter((r): r is GhReview & { submitted_at: string } => r.user.login === me && r.state !== "COMMENTED" && r.state !== "PENDING" && !!r.submitted_at)
			.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
		const latest = mine.at(-1);
		return latest?.state === "APPROVED" && latest.commit_id === pr.headRefOid;
	}

	/** Resolves a notification's API URL to the page a human would open. */
	private async htmlUrl(n: GhNotification): Promise<string> {
		if (!n.subject.url) {
			return n.subject.type === "Discussion" ? `${n.repository.html_url}/discussions` : n.repository.html_url;
		}
		try {
			const { stdout } = await run("gh", ["api", n.subject.url, "-q", ".html_url"]);
			return stdout.trim() || n.repository.html_url;
		} catch {
			return n.repository.html_url;
		}
	}
}

export default new GitHubService();

const REVIEW_DECISIONS: Record<string, string> = {
	APPROVED: "approved",
	CHANGES_REQUESTED: "changes requested",
	REVIEW_REQUIRED: "review required",
	"": "no reviews"
};

/** A PR to fetch, and why it is on the dashboard. updatedAt comes from the notification when there is one. */
type Candidate = {
	repo: string;
	number: number;
	reason: string;
	updatedAt?: string;
};

type GhFile = {
	filename: string;
	previous_filename?: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
};

type GhSearchPr = {
	number: number;
	repository: { nameWithOwner: string };
};

type GhNotification = {
	id: string;
	reason: string;
	updated_at: string;
	subject: { title: string; url: string | null; type: string };
	repository: { full_name: string; html_url: string };
};

type GhPr = {
	number: number;
	title: string;
	url: string;
	body: string;
	author: { login: string };
	headRefOid: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	isDraft: boolean;
	state: "OPEN" | "CLOSED" | "MERGED";
	reviewDecision: string;
	updatedAt: string;
};

type GhReview = {
	user: { login: string };
	state: string;
	commit_id: string;
	submitted_at: string | null;
};
