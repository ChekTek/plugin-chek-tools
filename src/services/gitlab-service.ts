import { buildLineMap, gitlabLineUrl } from "../lib/diff-links";
import { run, runJson } from "../lib/exec";
import store, { type ChangeRequest, type Notification } from "../plugin-store";
import reviewService from "./review-service";

/** Pulls pending GitLab to-dos with the glab CLI and reviews the merge requests among them. */
class GitLabService {
	async refresh(): Promise<void> {
		store.setJob("gitlab", { message: "Fetching to-dos" });
		const todos = await this.allPages<GlTodo>("todos?state=pending");
		const me = (await runJson<{ username: string }>("glab", ["api", "user"])).username;
		const changes: { cr: ChangeRequest; body: string }[] = [];
		const others: Notification[] = [];
		let hidden = 0;

		for (const t of todos) {
			if (t.target_type === "MergeRequest" && t.project && t.target?.iid) {
				const mr = await runJson<GlMr>("glab", ["api", `projects/${t.project.id}/merge_requests/${t.target.iid}`]);
				if (mr.state !== "opened" || (await this.approvedAfterLastPush(t.project.id, mr, me))) {
					hidden++;
					continue;
				}
				const cr: ChangeRequest = {
					id: `${t.project.path_with_namespace}!${mr.iid}`,
					platform: "gitlab",
					repo: t.project.path_with_namespace,
					number: mr.iid,
					title: mr.title,
					author: mr.author.username,
					url: mr.web_url,
					filesUrl: `${mr.web_url}/diffs`,
					reason: t.action_name,
					updatedAt: t.updated_at,
					headSha: mr.sha,
					changedFiles: mr.changes_count ? Number(mr.changes_count) : undefined,
					draft: mr.draft,
					reviews: []
				};
				if (!changes.some((c) => c.cr.id === cr.id)) {
					changes.push({ cr, body: mr.description ?? "" });
					reviewService.upsertChange(cr);
				}
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

		store.update((s) => {
			s.gitlab.notifications = others;
			s.gitlab.changes = s.gitlab.changes.filter((c) => changes.some((n) => n.cr.id === c.id));
		});

		for (const { cr, body } of changes) {
			store.setJob("gitlab", { message: `Reviewing ${cr.id}` });
			const { stdout: diff } = await run("glab", ["mr", "diff", String(cr.number), "-R", cr.repo, "--color=never"]);
			const lineMap = buildLineMap(diff);
			await reviewService.reviewChange(cr, {
				title: cr.title,
				author: cr.author,
				description: body,
				diff,
				link: (file, line) => gitlabLineUrl(cr.url, file, line, lineMap)
			});
		}

		store.setJob("gitlab", { message: `${changes.length} MRs, ${others.length} other${hidden ? `, ${hidden} hidden` : ""}` });
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
	title: string;
	description: string | null;
	web_url: string;
	sha: string;
	draft: boolean;
	changes_count: string | null;
	author: { username: string };
	state: "opened" | "closed" | "merged" | "locked";
};

type GlNote = {
	system: boolean;
	body: string;
	created_at: string;
	author: { username: string };
};
