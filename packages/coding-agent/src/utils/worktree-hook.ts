/**
 * Runs a new linked worktree's `post-checkout` hook the way `git worktree add`
 * does: git's new-worktree arguments (null old HEAD, new HEAD, branch flag `1`),
 * with the worktree as working directory. Git decides whether a hook exists.
 *
 * A failed or cancelled hook never discards anything; callers keep the worktree
 * and surface {@link formatPostCheckoutHookWarning}.
 */
import { procmgr, ptree, sanitizeText, stripGitRepoLocationEnv } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayWarning, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";

/** After git's hook process exits, stop waiting on pipes a background process still holds. */
const HOOK_EXIT_GRACE_MS = 250;
/** Captured output kept per stream; only the last line is ever shown. */
const HOOK_OUTPUT_TAIL_CHARS = 4096;

export interface PostCheckoutHookOptions {
	/**
	 * `capture` keeps a bounded tail of the hook's output for the warning.
	 * `inherit` forwards stdout and stderr live to `process.stderr` (git sends a
	 * hook's stdout to stderr) and reports a failure with an empty `output`.
	 */
	output?: "capture" | "inherit";
	/** Stops the hook's whole process tree. An already-aborted signal skips the hook. */
	signal?: AbortSignal;
}

export type PostCheckoutHookResult =
	| { status: "ok" }
	| { status: "failed"; exitCode: number; output: string }
	| { status: "cancelled" }
	/** Git could not run the hook at all (spawn failure); `message` is git's or the OS's own text. */
	| { status: "error"; message: string }
	/** No `git` executable could be found to run the hook; nothing ran and nothing is reported. */
	| { status: "no-git" };

function tail(text: string): string {
	return text.length > HOOK_OUTPUT_TAIL_CHARS ? text.slice(-HOOK_OUTPUT_TAIL_CHARS) : text;
}

/**
 * Forward a pipe to `process.stderr` chunk by chunk until it closes or `stop` settles.
 * Live forwarding needs a manual reader loop; `inherit` is only used by the standalone
 * `omp worktree add` CLI, where `process.stderr` is the output sink.
 */
async function forward(stream: ReadableStream<Uint8Array>, stop: Promise<void>): Promise<void> {
	const reader = stream.getReader();
	// `stop` is observed once; a pending drain wait registers its release here instead of adding a reaction per write.
	let stopped = false;
	let releaseDrain: (() => void) | undefined;
	void stop.then(() => {
		stopped = true;
		releaseDrain?.();
		return reader.cancel().catch(() => {});
	});
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			// A false return means process.stderr's buffer is full; wait for it to drain instead of
			// growing it. Bun.spawn still reads the hook's pipes eagerly, so this doesn't slow the hook.
			// Once forwarding is cut, nothing would release the wait, so don't start one.
			if (!process.stderr.write(chunk.value) && !stopped) {
				const { promise, resolve } = Promise.withResolvers<void>();
				const done = () => {
					process.stderr.off("drain", done);
					process.stderr.off("close", done);
					releaseDrain = undefined;
					resolve();
				};
				process.stderr.once("drain", done);
				process.stderr.once("close", done);
				releaseDrain = done;
				await promise;
			}
		}
	} catch {
		// A cancelled read ends the forwarding.
	}
}

/**
 * The bash tool's child-shell env (dotenv values of the launch project filtered out, as procmgr
 * pinned them), re-stripped of git repository-location vars in case they were set after the capture.
 */
function hookEnv(): Record<string, string> {
	const env = procmgr.getChildShellEnv();
	stripGitRepoLocationEnv(env);
	return env;
}

/** Run `post-checkout` for a worktree just created at `worktreeRoot` whose HEAD is `head`. */
export async function runPostCheckoutHook(
	worktreeRoot: string,
	head: string,
	options: PostCheckoutHookOptions = {},
): Promise<PostCheckoutHookResult> {
	const { signal, output = "capture" } = options;
	if (signal?.aborted) return { status: "cancelled" };
	try {
		const child = ptree.spawn(
			["git", "hook", "run", "--ignore-missing", "post-checkout", "--", "0".repeat(head.length), head, "1"],
			{
				cwd: worktreeRoot,
				env: hookEnv(),
				// Capture mode gets its own process group so an abort kills the whole hook tree. Inherit mode
				// (`omp worktree add`, no signal) stays in omp's group so the terminal's Ctrl-C reaches the hook, as with git.
				detached: output !== "inherit",
				signal,
				exitGraceMs: HOOK_EXIT_GRACE_MS,
				stderr: output === "inherit" ? "stream" : undefined,
			},
		);
		if (output === "inherit") return await inheritOutput(child);
		const result = await child.wait({ allowNonZero: true, allowAbort: true });
		if (result.exitError?.aborted) return { status: "cancelled" };
		if (result.ok) return { status: "ok" };
		return {
			status: "failed",
			exitCode: result.exitCode ?? -1,
			output: `${tail(result.stdout)}\n${tail(result.stderr)}`,
		};
	} catch (error) {
		if (signal?.aborted) return { status: "cancelled" };
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { status: "no-git" };
		return { status: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

async function inheritOutput(child: ptree.ChildProcess): Promise<PostCheckoutHookResult> {
	const { promise: stop, resolve: cut } = Promise.withResolvers<void>();
	const pumps = Promise.all([forward(child.stdout, stop), child.stderr ? forward(child.stderr, stop) : undefined]);
	let aborted = false;
	let failure: unknown;
	let exitCode: number | undefined;
	try {
		exitCode = await child.exited;
	} catch (error) {
		if (!(error instanceof ptree.Exception)) failure = error;
		else if (error.aborted) aborted = true;
		else exitCode = error.exitCode;
	}
	// ptree's own grace releases its readers; this timer only cancels the forwarding reads
	// a background process still holds.
	const timer = setTimeout(cut, HOOK_EXIT_GRACE_MS);
	try {
		await pumps;
	} finally {
		clearTimeout(timer);
		cut();
	}
	if (failure !== undefined) throw failure;
	if (aborted) return { status: "cancelled" };
	const status = exitCode ?? child.exitCode ?? -1;
	return status === 0 ? { status: "ok" } : { status: "failed", exitCode: status, output: "" };
}

/** One-line, display-ready warning for a hook result, or undefined when nothing went wrong. */
export function formatPostCheckoutHookWarning(result: PostCheckoutHookResult): string | undefined {
	let text: string;
	switch (result.status) {
		case "ok":
		case "no-git":
			return undefined;
		case "cancelled":
			text = "post-checkout hook cancelled";
			break;
		case "error":
			text = `post-checkout hook could not run: ${result.message}`;
			break;
		case "failed": {
			const last = sanitizeText(result.output)
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean)
				.at(-1);
			text = `post-checkout hook exited with ${result.exitCode}${last ? `: ${last}` : ""}`;
			break;
		}
	}
	return truncateToWidth(sanitizeDisplayWarning(text), TRUNCATE_LENGTHS.LONG);
}
