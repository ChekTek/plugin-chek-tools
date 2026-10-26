import { githubLineUrl } from "../lib/diff-links";
import { run, runJson } from "../lib/exec";
import store, { type ChangeRequest, type Notification } from "../plugin-store";
import reviewService from "./review-service";

/** Pulls unread GitHub notifications with the gh CLI and reviews the pull requests among them. */
class GitHubService {
	async refresh(): Promise<void> {
		store.setJob("github", { message: "Fetching notifications" });
		const pages = await runJson<GhNotification[][]>("gh", ["api", "notifications", "--paginate", "--slurp"]);
		const me = (await run("gh", ["api", "user", "-q", ".login"])).stdout.trim();
		const changes: { cr: ChangeRequest; body: string }[] = [];
		const others: Notification[] = [];
		let hidden = 0;

		for (const n of pages.flat()) {
			const prNumber = n.subject.type === "PullRequest" ? Number(n.subject.url?.split("/").pop()) : NaN;
			if (!Number.isNaN(prNumber)) {
				const pr = await runJson<GhPr>("gh", [
					"pr", "view", String(prNumber), "-R", n.repository.full_name,
					"--json", "number,title,url,body,author,headRefOid,additions,deletions,changedFiles,isDraft,state"
				]);
				if (pr.state !== "OPEN" || (await this.approvedAtHead(n.repository.full_name, pr, me))) {
					hidden++;
					continue;
				}
				const cr: ChangeRequest = {
					id: `${n.repository.full_name}#${pr.number}`,
					platform: "github",
					repo: n.repository.full_name,
					number: pr.number,
					title: pr.title,
					author: pr.author.login,
					url: pr.url,
					filesUrl: `${pr.url}/files`,
					reason: n.reason,
					updatedAt: n.updated_at,
					headSha: pr.headRefOid,
					additions: pr.additions,
					deletions: pr.deletions,
					changedFiles: pr.changedFiles,
					draft: pr.isDraft,
					reviews: []
				};
				changes.push({ cr, body: pr.body ?? "" });
				reviewService.upsertChange(cr);
			} else {
				others.push({
					id: n.id,
					platform: "github",
					type: n.subject.type,
					reason: n.reason,
					title: n.subject.title,
					repo: n.repository.full_name,
					url: await this.htmlUrl(n),
					updatedAt: n.updated_at
				});
			}
		}

		store.update((s) => {
			s.github.notifications = others;
			s.github.changes = s.github.changes.filter((c) => changes.some((n) => n.cr.id === c.id));
		});

		for (const { cr, body } of changes) {
			store.setJob("github", { message: `Reviewing ${cr.id}` });
			const { stdout: diff } = await run("gh", ["pr", "diff", String(cr.number), "-R", cr.repo]);
			await reviewService.reviewChange(cr, {
				title: cr.title,
				author: cr.author,
				description: body,
				diff,
				link: (file, line) => githubLineUrl(cr.url, file, line)
			});
		}

		store.setJob("github", { message: `${changes.length} PRs, ${others.length} other${hidden ? `, ${hidden} hidden` : ""}` });
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
};

type GhReview = {
	user: { login: string };
	state: string;
	commit_id: string;
	submitted_at: string | null;
};
