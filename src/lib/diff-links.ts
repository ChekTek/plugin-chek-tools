import { createHash } from "node:crypto";

/**
 * Builds deep links to a specific line of a PR/MR diff on GitHub or GitLab.
 *
 * GitHub anchors a file by the sha256 of its path and a line by R<new line>.
 * GitLab anchors a file by the sha1 of its path and a line by _<old line>_<new line>,
 * so for GitLab we walk the unified diff to recover the old-line number that pairs
 * with each new-line number.
 */

/** Map of file path -> (new line number -> old line number) for the whole diff. */
export type LineMap = Map<string, Map<number, number>>;

export function buildLineMap(unifiedDiff: string): LineMap {
	const map: LineMap = new Map();
	let current: Map<number, number> | undefined;
	let oldLine = 0;
	let newLine = 0;
	// Lines still expected in the current hunk; while either is positive we are inside hunk
	// content, where "---" is a deleted line starting with "--", not a file header.
	let oldLeft = 0;
	let newLeft = 0;

	for (const raw of unifiedDiff.split("\n")) {
		const inHunk = oldLeft > 0 || newLeft > 0;

		if (!inHunk) {
			if (raw.startsWith("+++ ")) {
				// "+++ b/path" or "+++ path"; strip the optional b/ prefix.
				const path = raw.slice(4).trim().replace(/^b\//, "");
				current = new Map();
				map.set(path, current);
				continue;
			}
			// Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
			const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
			if (hunk) {
				oldLine = Number(hunk[1]);
				oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
				newLine = Number(hunk[3]);
				newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
			}
			continue;
		}

		if (!current || raw.startsWith("\\")) continue; // "\ No newline at end of file"

		if (raw.startsWith("+")) {
			current.set(newLine, oldLine);
			newLine++;
			newLeft--;
		} else if (raw.startsWith("-")) {
			oldLine++;
			oldLeft--;
		} else {
			current.set(newLine, oldLine);
			oldLine++;
			newLine++;
			oldLeft--;
			newLeft--;
		}
	}
	return map;
}

export function githubLineUrl(prUrl: string, file: string, line: number | null): string {
	const hash = createHash("sha256").update(file).digest("hex");
	return `${prUrl}/files#diff-${hash}${line ? `R${line}` : ""}`;
}

export function gitlabLineUrl(mrUrl: string, file: string, line: number | null, lineMap: LineMap): string {
	const hash = createHash("sha1").update(file).digest("hex");
	if (!line) return `${mrUrl}/diffs#${hash}`;
	const old = lineMap.get(file)?.get(line);
	return `${mrUrl}/diffs#${hash}_${old ?? ""}_${line}`;
}
