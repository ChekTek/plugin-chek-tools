import { buildLineMap, gitlabLineUrl } from "../lib/diff-links";
import { mapLimit } from "../lib/concurrency";
import { run, runJson } from "../lib/exec";
import store, { type ChangeRequest, type Notification } from "../plugin-store";
import reviewService, { type ReviewJob } from "./review-service";

/**
 * Pulls pending GitLab to-dos, MRs I am a reviewer on and my own open MRs with the glab CLI,
 * and queues the MRs that are not mine for review. Reviewer assignments come from the MR
 * list, not to-dos, so an MR stays on the dashboard after its to-do is marked done.
 */
class GitLabService {
	/** Refreshes the store and returns the review jobs for MRs that still need one. */
	async refresh(): Promise<ReviewJob[]> {
		store.setJob("gitlab", { message: "Fetching to-dos and MRs" });
		const [todos, me, mine] = await Promise.all([
			this.allPages<GlTodo>("todos?state=pending"),
			this.login(),
			this.allPages<GlMr>("merge_requests?scope=created_by_me&state=opened")
		]);
		const requested = await this.allPages<GlMr>(`merge_requests?scope=all&state=opened&reviewer_username=${me}`);

		// Every MR worth looking at, keyed by id so one MR is fetched once. To-dos win on reason.
		const candidates = new Map<string, Candidate>();
		const others: Notification[] = [];
		for (const t of todos) {
			if (t.target_type === "MergeRequest" && t.project && t.target?.iid) {
				const id = `${t.project.path_with_namespace}!${t.target.iid}`;
				if (!candidates.has(id)) candidates.set(id, { projectId: t.project.id, repo: t.project.path_with_namespace, iid: t.target.iid, reason: t.action_name, updatedAt: t.updated_at });
			} else {
				others.push({
					id: String(t.id),
					platform: "gitlab",
					type: t.target_type,
					reason: t.action_name,
					title: t.target?.title ?? t.body,
					repo: t.project?.path_with_namespace ?? "",
					url: t.target_url,
					updatedAt: t.updated_at
				});
			}
		}
		const addList = (mrs: GlMr[], reason: string): void => {
			for (const mr of mrs) {
				const repo = mr.references.full.split("!")[0];
				const id = `${repo}!${mr.iid}`;
				if (!candidates.has(id)) candidates.set(id, { projectId: mr.project_id, repo, iid: mr.iid, reason });
			}
		};
		addList(requested, "review_requested");
		addList(mine, "author");

		const changes: { cr: ChangeRequest; body: string }[] = [];
		let hidden = 0;
		await mapLimit([...candidates.values()], 6, async (c) => {
			const mr = await runJson<GlMr>("glab", ["api", `projects/${c.projectId}/merge_requests/${c.iid}`]);
			// A to-do on my own MR still files it under mine.
			const isMine = mr.author.username === me;
			if (mr.state !== "opened" || (!isMine && (await this.approvedAfterLastPush(c.projectId, mr, me)))) {
				hidden++;
				return;
			}
			changes.push({ cr: this.toChange(c.repo, mr, isMine ? "mine" : "review", c.reason, c.updatedAt ?? mr.updated_at), body: mr.description ?? "" });
		});
		changes.sort((a, b) => b.cr.updatedAt.localeCompare(a.cr.updatedAt));

		for (const { cr } of changes) reviewService.upsertChange(cr);
		store.update((s) => {
			s.gitlab.notifications = others;
			s.gitlab.changes = s.gitlab.changes.filter((c) => changes.some((n) => n.cr.id === c.id));
		});

		const mineCount = changes.filter((c) => c.cr.kind === "mine").length;
		const summary = `${changes.length - mineCount} to review, ${mineCount} mine, ${others.length} other${hidden ? `, ${hidden} hidden` : ""}`;
		store.setJob("gitlab", { message: summary });

		// My own MRs are never reviewed by the models; I review those before filing them.
		const jobs: ReviewJob[] = [];
		for (const { cr, body } of changes) {
			if (cr.kind !== "review" || !reviewService.enqueue(cr)) continue;
			jobs.push({
				cr,
				load: async () => {
					const { stdout: diff } = await run("glab", ["mr", "diff", String(cr.number), "-R", cr.repo, "--color=never"]);
					const lineMap = buildLineMap(diff);
					return {
						title: cr.title,
						author: cr.author,
						description: body,
						diff,
						link: (file, line) => gitlabLineUrl(cr.url, file, line, lineMap)
					};
				}
			});
		}
		return jobs;
	}

	private async login(): Promise<string> {
		return (await runJson<{ username: string }>("glab", ["api", "user"])).username;
	}

	private toChange(repo: string, mr: GlMr, kind: ChangeRequest["kind"], reason: string, updatedAt: string): ChangeRequest {
		return {
			id: `${repo}!${mr.iid}`,
			platform: "gitlab",
			kind,
			status: kind === "mine" ? mr.detailed_merge_status.replace(/_/g, " ") : undefined,
			repo,
			number: mr.iid,
			title: mr.title,
			author: mr.author.username,
			url: mr.web_url,
			filesUrl: `${mr.web_url}/diffs`,
			reason,
			updatedAt,
			headSha: mr.sha,
			changedFiles: mr.changes_count ? Number(mr.changes_count) : undefined,
			draft: mr.draft,
			reviews: []
		};
	}

	/**
	 * True when I am among the MR's approvers and my approval came after its newest push.
	 * GitLab records approvals as system notes and each push as a diff version, so the note
	 * time is compared to the latest version's creation time (commit dates can predate a push).
	 */
	private async approvedAfterLastPush(projectId: number, mr: GlMr, me: string): Promise<boolean> {
		const base = `projects/${projectId}/merge_requests/${mr.iid}`;
		const approvals = await runJson<{ approved_by: { user: { username: string } }[] }>("glab", ["api", `${base}/approvals`]);
		if (!approvals.approved_by.some((a) => a.user.username === me)) return false;

		const [versions, notes] = await Promise.all([
			runJson<{ created_at: string; head_commit_sha: string }[]>("glab", ["api", `${base}/versions`]),
			this.allPages<GlNote>(`${base}/notes?sort=desc&order_by=created_at`)
		]);
		const approvedAt = notes.find((n) => n.system && n.author.username === me && n.body === "approved this merge request")?.created_at;
		const latest = versions.find((v) => v.head_commit_sha === mr.sha) ?? versions[0];
		return !!approvedAt && !!latest && approvedAt > latest.created_at;
	}

	/** Fetches every page of a list endpoint. */
	private async allPages<T>(endpoint: string): Promise<T[]> {
		const all: T[] = [];
		for (let page = 1; ; page++) {
			const items = await runJson<T[]>("glab", ["api", `${endpoint}&per_page=100&page=${page}`]);
			all.push(...items);
			if (items.length < 100) return all;
		}
	}
}

export default new GitLabService();

/** An MR to fetch, and why it is on the dashboard. updatedAt comes from the to-do when there is one. */
type Candidate = {
	projectId: number;
	repo: string;
	iid: number;
	reason: string;
	updatedAt?: string;
};

type GlTodo = {
	id: number;
	action_name: string;
	target_type: string;
	target_url: string;
	body: string;
	updated_at: string;
	project: { id: number; path_with_namespace: string } | null;
	target: { iid?: number; title?: string } | null;
};

type GlMr = {
	iid: number;
	project_id: number;
	title: string;
	description: string | null;
	web_url: string;
	sha: string;
	draft: boolean;
	changes_count: string | null;
	author: { username: string };
	state: "opened" | "closed" | "merged" | "locked";
	detailed_merge_status: string;
	updated_at: string;
	references: { full: string };
};

type GlNote = {
	system: boolean;
	body: string;
	created_at: string;
	author: { username: string };
};
