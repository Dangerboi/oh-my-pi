/**
 * Runs a new linked worktree's `post-checkout` hook the way `git worktree add`
 * does: git's new-worktree arguments (null old HEAD, new HEAD, branch flag `1`),
 * with the worktree as working directory. Git decides whether a hook exists.
 *
 * A failed or cancelled hook never discards anything; callers keep the worktree
 * and surface {@link formatPostCheckoutHookWarning}.
 */
import { $which, procmgr, ptree, sanitizeText, stripGitRepoLocationEnv, WhichCachePolicy } from "@oh-my-pi/pi-utils";
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
	/**
	 * Kills the hook's process group on POSIX (native tree kill on Windows). A descendant that
	 * `setsid`s into its own session is not reached; git does not reach it either. On Windows,
	 * Git runs hooks through MSYS `sh`, whose child processes have no living Windows parent, so
	 * the tree kill ends git and the call returns, but commands the hook started keep running.
	 * An already-aborted signal skips the hook.
	 */
	signal?: AbortSignal;
}

export type PostCheckoutHookResult =
	| { status: "ok" }
	| { status: "failed"; exitCode: number; output: string }
	| { status: "cancelled" }
	/** Git could not run the hook at all (spawn failure); `message` is git's or the OS's own text. */
	| { status: "error"; message: string }
	/** `git` is not on the hook environment's PATH; nothing ran and nothing is reported. Any other spawn failure is `error`. */
	| { status: "no-git" };

function tail(text: string): string {
	return text.length > HOOK_OUTPUT_TAIL_CHARS ? text.slice(-HOOK_OUTPUT_TAIL_CHARS) : text;
}

/** Progress signals the forwarders give `inheritOutput`, which cuts them only once they have gone idle. */
interface ForwardActivity {
	/** A chunk was read or a drain wait ended. */
	touch(): void;
	/** `+1` while waiting on `process.stderr` to drain, `-1` when that wait ends. */
	busy(delta: 1 | -1): void;
}

/**
 * Forward a pipe to `process.stderr` chunk by chunk until it closes or `stop` settles.
 * Live forwarding needs a manual reader loop; `inherit` is only used by the standalone
 * `omp worktree add` CLI, where `process.stderr` is the output sink.
 */
async function forward(
	stream: ReadableStream<Uint8Array>,
	stop: Promise<void>,
	activity: ForwardActivity,
): Promise<void> {
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
			activity.touch();
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
				activity.busy(1);
				await promise;
				activity.busy(-1);
				activity.touch();
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

/** `PATH` from an env whose key may be spelled `Path` (Windows env keys are case-insensitive). */
function pathValue(env: Record<string, string>): string {
	const key = Object.keys(env).find(name => name.toUpperCase() === "PATH");
	return key === undefined ? "" : env[key];
}

/** Run `post-checkout` for a worktree just created at `worktreeRoot` whose HEAD is `head`. */
export async function runPostCheckoutHook(
	worktreeRoot: string,
	head: string,
	options: PostCheckoutHookOptions = {},
): Promise<PostCheckoutHookResult> {
	const { signal, output = "capture" } = options;
	if (signal?.aborted) return { status: "cancelled" };
	const env = hookEnv();
	try {
		const child = ptree.spawn(
			["git", "hook", "run", "--ignore-missing", "post-checkout", "--", "0".repeat(head.length), head, "1"],
			{
				cwd: worktreeRoot,
				env,
				// Capture mode gets its own process group so an abort kills the whole hook tree. Inherit mode
				// (`omp worktree add`, no signal) stays in omp's group so the terminal's Ctrl-C reaches the hook, as with git.
				// Windows has no process groups to kill: `detached` there only means no console (child consoles pop up),
				// and ptree's abort already kills the whole tree natively, so it is POSIX-only.
				detached: output !== "inherit" && process.platform !== "win32",
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
		if (
			(error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" &&
			!$which("git", { PATH: pathValue(env), cache: WhichCachePolicy.Fresh })
		) {
			return { status: "no-git" };
		}
		return { status: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

async function inheritOutput(child: ptree.ChildProcess): Promise<PostCheckoutHookResult> {
	const { promise: stop, resolve: cut } = Promise.withResolvers<void>();
	// After the hook exits the forwarders are cut only once idle for the grace period, so a slow
	// `process.stderr` consumer keeps its buffered output while a background holder of the pipes is dropped.
	let exited = false;
	let aborted = false;
	let busy = 0;
	let timer: NodeJS.Timeout | undefined;
	const arm = () => {
		// An aborted hook keeps its fixed cut; later output must not push it back.
		if (!exited || aborted) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (busy === 0) cut();
		}, HOOK_EXIT_GRACE_MS);
	};
	const activity: ForwardActivity = {
		touch: arm,
		busy: delta => {
			busy += delta;
		},
	};
	const pumps = Promise.all([
		forward(child.stdout, stop, activity),
		child.stderr ? forward(child.stderr, stop, activity) : undefined,
	]);
	let failure: unknown;
	let exitCode: number | undefined;
	try {
		exitCode = await child.exited;
	} catch (error) {
		if (!(error instanceof ptree.Exception)) failure = error;
		else if (error.aborted) aborted = true;
		else exitCode = error.exitCode;
	}
	exited = true;
	// An aborted hook is not waited on for a slow consumer: forwarding ends after the grace regardless.
	if (aborted) timer = setTimeout(cut, HOOK_EXIT_GRACE_MS);
	else arm();
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
			// A carriage return rewrites the line in place, so only the text after the last one is what the user saw.
			const last = result.output
				.split("\n")
				.map(line => {
					const frame = line.replace(/\r+$/, "");
					return sanitizeText(frame.slice(frame.lastIndexOf("\r") + 1)).trim();
				})
				.filter(Boolean)
				.at(-1);
			text = `post-checkout hook exited with ${result.exitCode}${last ? `: ${last}` : ""}`;
			break;
		}
	}
	return truncateToWidth(sanitizeDisplayWarning(text), TRUNCATE_LENGTHS.LONG);
}
