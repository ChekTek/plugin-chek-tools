import streamDeck from "@elgato/streamdeck";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../lib/exec";
import store, { type ChangeRequest, type Finding } from "../plugin-store";

/** Models used for every review, run in this order. Both come from the GitHub Copilot subscription via pi. */
export const REVIEW_MODELS = [
	{ provider: "github-copilot", model: "gpt-6-astra", label: "Astra" },
	{ provider: "github-copilot", model: "claude-opus-5.5", label: "Opus 5.5" }
] as const;

export type ModelReview = {
	verdict: "approve" | "request_changes" | "comment";
	summary: string;
	findings: Finding[];
};

export type ReviewInput = {
	platform: "GitHub" | "GitLab";
	title: string;
	author: string;
	description: string;
	diff: string;
	/** Turns a file/line finding into a deep link on the platform. */
	link: (file: string, line: number | null) => string;
};

const SYSTEM_PROMPT = `You are a senior engineer performing a careful code review of a pull request.
You have no tools; everything you need is in the message. Review for correctness bugs,
regressions, missed edge cases, security issues, and anything that would block a merge.
Mention style only when it hurts readability. Be concrete and brief.

Respond with ONLY a JSON object (no markdown fences, no prose) in this exact shape:
{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "2-4 sentences on what the change does and your overall take",
  "findings": [
    {
      "severity": "high" | "medium" | "low" | "nit",
      "file": "path/to/file exactly as it appears after +++ in the diff (without the b/ prefix)",
      "line": <line number in the NEW version of the file, or null if not line-specific>,
      "title": "short one-line headline",
      "body": "1-3 sentences explaining the problem and a suggested fix"
    }
  ]
}`;

const MAX_DIFF_CHARS = 400_000;

/** Runs AI code reviews through pi and records them in the store. */
class ReviewService {
	/**
	 * Runs every configured model over a change request, one after the other, recording
	 * progress in the store so the dashboard updates live. Skips changes whose head commit
	 * was already fully reviewed. A failing model is recorded on the dashboard and does not
	 * stop the next model.
	 */
	async reviewChange(cr: ChangeRequest, input: Omit<ReviewInput, "platform">): Promise<void> {
		const platform = cr.platform;
		const existing = store.state[platform].changes.find((c) => c.id === cr.id);
		const alreadyReviewed =
			existing?.headSha === cr.headSha && REVIEW_MODELS.every((m) => existing.reviews.some((r) => r.model === m.model && r.status === "done"));
		if (alreadyReviewed) {
			streamDeck.logger.info(`Skipping ${cr.id}: head ${cr.headSha.slice(0, 7)} already reviewed`);
			return;
		}

		for (const model of REVIEW_MODELS) {
			store.startReview(platform, cr.id, model.model, model.label);
			try {
				const result = await this.reviewWith(model, { ...input, platform: platform === "github" ? "GitHub" : "GitLab" });
				store.finishReview(platform, cr.id, model.model, result);
			} catch (err) {
				streamDeck.logger.error(`Review of ${cr.id} with ${model.label} failed: ${(err as Error).message}`);
				store.finishReview(platform, cr.id, model.model, err as Error);
			}
		}
	}

	/** Keeps a change request's metadata fresh while preserving reviews from the store when the head is unchanged. */
	upsertChange(cr: ChangeRequest): void {
		store.update((s) => {
			const list = s[cr.platform].changes;
			const i = list.findIndex((c) => c.id === cr.id);
			const prior = i >= 0 ? list[i] : undefined;
			const merged = { ...cr, reviews: prior && prior.headSha === cr.headSha ? prior.reviews : [] };
			if (i >= 0) list[i] = merged;
			else list.push(merged);
		});
	}

	/**
	 * Asks one model (through pi, non-interactively) to review a diff and returns the parsed result.
	 * The diff is passed as a file reference so very large changes don't hit argv limits.
	 */
	private async reviewWith(model: (typeof REVIEW_MODELS)[number], input: ReviewInput): Promise<ModelReview> {
		const dir = mkdtempSync(join(tmpdir(), "chek-review-"));
		try {
			let diff = input.diff;
			if (diff.length > MAX_DIFF_CHARS) {
				diff = diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated by the dashboard; review what is shown]";
			}
			const diffPath = join(dir, "change.diff");
			writeFileSync(diffPath, diff);

			const message = [
				`Platform: ${input.platform}`,
				`Title: ${input.title}`,
				`Author: ${input.author}`,
				``,
				`Description:`,
				input.description.trim() || "(none)",
				``,
				`The unified diff is in the attached file. Review it now.`
			].join("\n");

			const { stdout } = await run(
				"pi",
				[
					"--print",
					"--no-session",
					"--no-tools",
					"--no-extensions",
					"--no-skills",
					"--no-context-files",
					"--no-mcp",
					"--no-prompt-templates",
					"--no-themes",
					"--provider",
					model.provider,
					"--model",
					model.model,
					"--system-prompt",
					SYSTEM_PROMPT,
					`@${diffPath}`,
					message
				],
				{ cwd: dir, timeoutMs: 15 * 60 * 1000 }
			);

			const parsed = parseReview(stdout);
			return {
				verdict: parsed.verdict,
				summary: parsed.summary,
				findings: parsed.findings.map((f) => ({ ...f, url: input.link(f.file, f.line) }))
			};
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

/** Pulls the JSON object out of the model output, tolerating fences or stray text around it. */
function parseReview(text: string): { verdict: ModelReview["verdict"]; summary: string; findings: RawFinding[] } {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1) {
		throw new Error(`Model did not return JSON: ${text.slice(0, 200)}`);
	}
	const obj = JSON.parse(text.slice(start, end + 1)) as Partial<ModelReview> & { findings?: Partial<RawFinding>[] };
	const verdicts = ["approve", "request_changes", "comment"];
	return {
		verdict: verdicts.includes(obj.verdict ?? "") ? (obj.verdict as ModelReview["verdict"]) : "comment",
		summary: String(obj.summary ?? ""),
		findings: (obj.findings ?? []).map((f) => ({
			severity: (["high", "medium", "low", "nit"].includes(f.severity ?? "") ? f.severity : "low") as Finding["severity"],
			file: String(f.file ?? "").replace(/^[ab]\//, ""),
			line: typeof f.line === "number" && f.line > 0 ? Math.floor(f.line) : null,
			title: String(f.title ?? ""),
			body: String(f.body ?? "")
		}))
	};
}

export default new ReviewService();

type RawFinding = Omit<Finding, "url">;
