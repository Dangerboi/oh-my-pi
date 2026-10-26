/**
 * Runs a new linked worktree's `post-checkout` hook the way `git worktree add`
 * does: git's new-worktree arguments (null old HEAD, new HEAD, branch flag `1`),
 * with the worktree as working directory. Git decides whether a hook exists.
 *
 * A failed or cancelled hook never discards anything; callers keep the worktree
 * and surface {@link formatPostCheckoutHookWarning}.
 */
import { filterChildShellEnv, ptree, sanitizeText } from "@oh-my-pi/pi-utils";
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
	| { status: "error"; message: string };

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
	void stop.then(() => reader.cancel().catch(() => {}));
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			process.stderr.write(chunk.value);
		}
	} catch {
		// A cancelled read ends the forwarding.
	}
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
				env: filterChildShellEnv(process.env, worktreeRoot),
				detached: true,
				signal,
				exitGraceMs: output === "capture" ? HOOK_EXIT_GRACE_MS : undefined,
				stderr: output === "inherit" ? "full" : undefined,
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
		return { status: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

async function inheritOutput(child: ptree.ChildProcess): Promise<PostCheckoutHookResult> {
	const { promise: stop, resolve: cut } = Promise.withResolvers<void>();
	const pumps = Promise.all([forward(child.stdout, stop), child.stderr ? forward(child.stderr, stop) : undefined]);
	let aborted = false;
	try {
		await child.exited;
	} catch (error) {
		if (!(error instanceof ptree.Exception && error.aborted)) throw error;
		aborted = true;
	}
	// Stop reading pipes a background process still holds once the grace period passes.
	const timer = setTimeout(cut, HOOK_EXIT_GRACE_MS);
	await pumps;
	clearTimeout(timer);
	cut();
	if (aborted) return { status: "cancelled" };
	const exitCode = child.exitCode ?? -1;
	return exitCode === 0 ? { status: "ok" } : { status: "failed", exitCode, output: "" };
}

/** One-line, display-ready warning for a hook result, or undefined when nothing went wrong. */
export function formatPostCheckoutHookWarning(result: PostCheckoutHookResult): string | undefined {
	let text: string;
	switch (result.status) {
		case "ok":
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
