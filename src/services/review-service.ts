import streamDeck from "@elgato/streamdeck";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { mapLimit } from "../lib/concurrency";
import { CancelledError, run } from "../lib/exec";
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

/** A change waiting for review; `load` fetches its diff when its turn comes. */
export type ReviewJob = {
	cr: ChangeRequest;
	load: () => Promise<Omit<ReviewInput, "platform">>;
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

/** pi's code-review skill supplies the review instructions; the dashboard only adds the output shape. */
const SKILL_PATH = join(homedir(), ".pi", "agent", "skills", "code-review", "SKILL.md");

const BASE_PROMPT = `You are reviewing a pull request. Follow the code review instructions below.
You have no tools and no repository checkout: the attached unified diff is the whole target, so review what it shows.`;

const OUTPUT_FORMAT = `Output format: respond with ONLY a JSON object (no markdown fences, no prose) in this exact shape:
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
	/** In-flight reviews by change id, so one can be cancelled from the dashboard or superseded by a newer head. */
	private readonly inFlight = new Map<string, { controller: AbortController; headSha: string }>();
	/** Changes cancelled before their review started; they are skipped when their turn comes. */
	private readonly cancelledQueued = new Set<string>();

	/** Stops the review of one change, whether it is running or still queued. */
	cancel(id: string): void {
		const running = this.inFlight.get(id);
		if (running) running.controller.abort();
		else this.cancelledQueued.add(id);
	}

	/**
	 * Marks a change as queued on the dashboard and returns true, unless its current head is
	 * already reviewed, queued or running. A review still running for an older head is cancelled.
	 */
	enqueue(cr: ChangeRequest): boolean {
		const running = this.inFlight.get(cr.id);
		if (running?.headSha === cr.headSha) return false;
		running?.controller.abort();

		const reviews = store.state[cr.platform].changes.find((c) => c.id === cr.id)?.reviews ?? [];
		if (reviews.some((r) => r.status === "queued")) return false;
		if (REVIEW_MODELS.every((m) => reviews.some((r) => r.model === m.model && r.status === "done"))) {
			streamDeck.logger.info(`Skipping ${cr.id}: head ${cr.headSha.slice(0, 7)} already reviewed`);
			return false;
		}
		store.queueReviews(cr, REVIEW_MODELS);
		return true;
	}

	/** Reviews the queued jobs a few at a time. Never rejects: every failure lands on its change's card. */
	async reviewAll(jobs: ReviewJob[]): Promise<void> {
		await mapLimit(jobs, 3, async ({ cr, load }) => {
			try {
				await this.reviewChange(cr, await load());
			} catch (err) {
				this.markFailed(cr, (err as Error).message);
			}
		});
	}

	/**
	 * Runs every configured model over a change request, one after the other, recording
	 * progress in the store so the dashboard updates live. A failing model is recorded on
	 * the dashboard and does not stop the next model.
	 */
	private async reviewChange(cr: ChangeRequest, input: Omit<ReviewInput, "platform">): Promise<void> {
		const controller = new AbortController();
		if (this.cancelledQueued.delete(cr.id)) controller.abort();
		this.inFlight.set(cr.id, { controller, headSha: cr.headSha });

		try {
			for (const model of REVIEW_MODELS) {
				store.startReview(cr, model.model, model.label);
				if (controller.signal.aborted) {
					store.finishReview(cr, model.model, "cancelled");
					continue;
				}
				try {
					const result = await this.reviewWith(model, { ...input, platform: cr.platform === "github" ? "GitHub" : "GitLab" }, controller.signal);
					store.finishReview(cr, model.model, result);
				} catch (err) {
					if (err instanceof CancelledError) {
						store.finishReview(cr, model.model, "cancelled");
					} else {
						streamDeck.logger.error(`Review of ${cr.id} with ${model.label} failed: ${(err as Error).message}`);
						store.finishReview(cr, model.model, err as Error);
					}
				}
			}
		} finally {
			if (this.inFlight.get(cr.id)?.controller === controller) this.inFlight.delete(cr.id);
		}
	}

	/** Records a failure that stopped every model from reviewing the change, e.g. the diff could not be fetched. */
	private markFailed(cr: ChangeRequest, message: string): void {
		streamDeck.logger.error(`Review of ${cr.id} failed: ${message}`);
		for (const model of REVIEW_MODELS) {
			store.startReview(cr, model.model, model.label);
			store.finishReview(cr, model.model, new Error(message));
		}
	}

	/**
	 * Keeps a change request's metadata fresh while preserving reviews from the store when the
	 * head is unchanged. My own changes never carry reviews.
	 */
	upsertChange(cr: ChangeRequest): void {
		store.update((s) => {
			const list = s[cr.platform].changes;
			const i = list.findIndex((c) => c.id === cr.id);
			const prior = i >= 0 ? list[i] : undefined;
			const keepReviews = cr.kind === "review" && prior?.headSha === cr.headSha;
			const merged = { ...cr, reviews: keepReviews ? prior.reviews : [] };
			if (i >= 0) list[i] = merged;
			else list.push(merged);
		});
	}

	/**
	 * Asks one model (through pi, non-interactively) to review a diff and returns the parsed result.
	 * The diff is passed as a file reference so very large changes don't hit argv limits.
	 */
	private async reviewWith(model: (typeof REVIEW_MODELS)[number], input: ReviewInput, signal: AbortSignal): Promise<ModelReview> {
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
					BASE_PROMPT,
					...(existsSync(SKILL_PATH) ? ["--append-system-prompt", SKILL_PATH] : []),
					"--append-system-prompt",
					OUTPUT_FORMAT,
					`@${diffPath}`,
					message
				],
				{ cwd: dir, timeoutMs: 15 * 60 * 1000, signal }
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
