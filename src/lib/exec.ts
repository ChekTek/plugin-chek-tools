import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stream Deck launches plugins with a minimal PATH, so the CLIs this plugin relies on
 * (gh, glab, acli, pi) are usually not discoverable. We prepend the common install
 * locations on macOS so they resolve the same way they do in a terminal.
 */
function buildPath(): string {
	const home = homedir();
	const extra = [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];

	// nvm installs: add every installed node version's bin dir (newest first).
	const nvmDir = join(home, ".nvm", "versions", "node");
	if (existsSync(nvmDir)) {
		readdirSync(nvmDir)
			.sort()
			.reverse()
			.forEach((v) => extra.push(join(nvmDir, v, "bin")));
	}

	return [...extra, process.env.PATH ?? ""].filter(Boolean).join(":");
}

export const PATH = buildPath();

export type RunResult = { stdout: string; stderr: string };

/**
 * Runs a command with the augmented PATH and returns its output. Rejects with the
 * stderr text when the command exits non-zero or exceeds the timeout.
 *
 * Output goes through temp files rather than pipes: pi never finishes when its stdout
 * is one of Node's socket-pair pipes, but behaves normally writing to a file. Stdin is
 * closed unless input is given, so tools never wait on an empty pipe.
 */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const dir = mkdtempSync(join(tmpdir(), "chek-run-"));
		const outPath = join(dir, "stdout");
		const errPath = join(dir, "stderr");
		const out = openSync(outPath, "w");
		const err = openSync(errPath, "w");

		// A failed spawn emits both "error" and "close", so settle exactly once.
		let settled = false;
		const finish = (): RunResult | undefined => {
			if (settled) return undefined;
			settled = true;
			closeSync(out);
			closeSync(err);
			const result = { stdout: readFileSync(outPath, "utf8"), stderr: readFileSync(errPath, "utf8") };
			rmSync(dir, { recursive: true, force: true });
			return result;
		};

		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: { ...process.env, PATH, NO_COLOR: "1", GLAB_CHECK_UPDATE: "0" },
			stdio: [opts.input === undefined ? "ignore" : "pipe", out, err],
			timeout: opts.timeoutMs ?? 10 * 60 * 1000
		});
		child.on("error", (e) => {
			if (finish()) reject(new Error(`${cmd} failed to start: ${e.message}`));
		});
		child.on("close", (code, signal) => {
			const result = finish();
			if (!result) return;
			if (code === 0) {
				resolve(result);
			} else {
				const why = signal ? `killed by ${signal}, probably the timeout` : `exit ${code}`;
				reject(new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed (${why}): ${result.stderr.trim().slice(0, 500)}`));
			}
		});
		if (opts.input !== undefined) {
			child.stdin?.end(opts.input);
		}
	});
}

/**
 * Runs a command and parses its stdout as JSON.
 */
export async function runJson<T>(cmd: string, args: string[], opts?: Parameters<typeof run>[2]): Promise<T> {
	const { stdout } = await run(cmd, args, opts);
	return JSON.parse(stdout) as T;
}
