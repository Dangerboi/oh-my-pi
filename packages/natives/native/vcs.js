import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadNative } from "./loader-state.js";

let native;
function api() {
	native ??= loadNative();
	return native;
}
function vcsError(code, message) {
	const error = new Error(message);
	error.name = "VcsError";
	error.code = code;
	error.exitCode = 1;
	error.stdout = "";
	error.stderr = message;
	return error;
}

/**
 * True when `error` is a native VCS failure. The native layer constructs these
 * on the JS thread as real `Error` objects with `name: "VcsError"`, a
 * machine-readable `code`, and `exitCode`/`stdout`/`stderr` properties — an
 * `instanceof` check is impossible for foreign-constructed errors, so identity
 * rides on `name`.
 */
export function isVcsError(error) {
	return error instanceof Error && error.name === "VcsError";
}

/** True when a cherry-pick failed because the commit is already applied. */
export function isEmptyCherryPick(error) {
	return isVcsError(error) && error.code === "EmptyCherryPick";
}

/** Discover the git repository containing `dir`; `null` outside any checkout. */
export function git(dir) {
	return api().vcsGitDiscover(dir);
}
/** Discover the repository owning `dir`; `null` outside any repository. */
export function repo(dir) {
	return api().vcsDiscover(dir);
}

/** Like {@link repo}, but equal-root jj+git ties prefer Jujutsu for display. Git-safe automation must keep using {@link repo}. */
export function repoForDisplay(dir) {
	return api().vcsDiscoverForDisplay(dir);
}

/** Like {@link repo}, asserting any requested backend capabilities. */
export function require(dir, ...features) {
	const discovered = repo(dir);
	if (!discovered) throw vcsError("NotARepository", `not a repository: ${dir}`);
	for (const feature of features) {
		if (!discovered.supports(feature)) {
			throw vcsError(
				"Unsupported",
				`\`${feature}\` is not supported on a ${discovered.kind()} repository`,
			);
		}
	}
	return discovered;
}

/** Like {@link git}, but throws a `NotARepository` VcsError. */
export function requireGit(dir) {
	const repo = git(dir);
	if (!repo) {
		throw vcsError("NotARepository", `not a repository: ${dir}`);
	}
	return repo;
}

/** Repository metadata only (cheap fs walk) — for synchronous render paths. */
export function gitInfo(dir) {
	return api().vcsGitRepoInfo(dir);
}

/** Discover the Jujutsu workspace containing `dir`; `null` when absent. */
export function jj(dir) {
	return api().vcsJjDiscover(dir);
}

/** Whether jj is the nearest VCS ancestor, making git automation unsafe. */
export function isPureJj(dir) {
	return api().vcsIsPureJj(dir);
}

/** Clone a repository (git CLI under the hood for credential parity). */
export function clone(url, target, options = {}, signal) {
	return api().vcsGitClone(url, target, options, signal);
}

/** Sever a copied working tree from shared git metadata. */
export function detachGitDir(worktreeRoot, sourceCommonDir, signal) {
	return api().vcsDetachGitDir(worktreeRoot, sourceCommonDir, signal);
}

/**
 * Publish `from` at `to` only once fully written: copy to a sibling temp name,
 * then hard-link it into place (Git's own `finalize_object_file` strategy) so
 * readers never see a partial file and an interrupted copy leaves only a
 * `tmp_` file that `git gc` prunes. An existing `to` was itself published
 * whole and holds the same content-addressed bytes, so it is kept.
 */
async function publishGitObjectFile(from, to) {
	const tmp = path.join(path.dirname(to), `tmp_obj_omp_${crypto.randomUUID()}`);
	try {
		await fs.promises.copyFile(from, tmp, fs.constants.COPYFILE_EXCL);
		try {
			await fs.promises.link(tmp, to);
		} catch (error) {
			if (error?.code === "EEXIST") return;
			// Filesystems without hard links: rename is still atomic, and any
			// file it replaces holds identical content-addressed bytes.
			if (error?.code !== "EPERM" && error?.code !== "ENOTSUP" && error?.code !== "EXDEV") throw error;
			await fs.promises.rename(tmp, to);
		}
	} finally {
		await fs.promises.rm(tmp, { force: true });
	}
}

/**
 * Keep objects created in an isolated Git repository reachable after its
 * worktree is removed, without changing the destination's refs or index.
 * Every file is published atomically; a pack is published before its index.
 */
export async function copyGitObjects(isolationRoot, sourceRoot) {
	const from = path.join(requireGit(isolationRoot).info().commonDir, "objects");
	const to = path.join(requireGit(sourceRoot).info().commonDir, "objects");
	for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
		await fs.promises.mkdir(path.join(to, entry.name), { recursive: true });
		for (const name of await fs.promises.readdir(path.join(from, entry.name))) {
			if (!/^[0-9a-f]{38,62}$/.test(name)) continue;
			await publishGitObjectFile(path.join(from, entry.name, name), path.join(to, entry.name, name));
		}
	}
	const packs = (await fs.promises.readdir(path.join(from, "pack"))).filter(name => name.startsWith("pack-"));
	await fs.promises.mkdir(path.join(to, "pack"), { recursive: true });
	// The index must only become visible after the pack it describes.
	for (const name of packs.filter(name => name.endsWith(".pack"))) {
		await publishGitObjectFile(path.join(from, "pack", name), path.join(to, "pack", name));
	}
	for (const name of packs.filter(name => /\.(?:idx|rev|keep|promisor|mtimes)$/.test(name))) {
		await publishGitObjectFile(path.join(from, "pack", name), path.join(to, "pack", name));
	}
}

/** Bytes kept from the end of each of the hook's output streams. */
const HOOK_OUTPUT_TAIL_BYTES = 64 * 1024;
const HOOK_CAPTURE_PREFIX = "omp-post-checkout-";
/** Capture directories older than this are leftovers, never a run in progress. */
const HOOK_CAPTURE_STALE_MS = 60 * 60 * 1000;

/**
 * On Windows a background process a hook left running keeps its capture files open, so their
 * cleanup fails; delete such leftovers on later runs, once that process has exited.
 */
async function sweepStaleHookCaptures() {
	const tmp = os.tmpdir();
	const cutoff = Date.now() - HOOK_CAPTURE_STALE_MS;
	for (const name of await fs.promises.readdir(tmp).catch(() => [])) {
		if (!name.startsWith(HOOK_CAPTURE_PREFIX)) continue;
		const dir = path.join(tmp, name);
		const stat = await fs.promises.stat(dir).catch(() => null);
		if (stat && stat.mtimeMs < cutoff) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/** Oldest Git with `git hook run`. */
const HOOK_RUN_MIN_GIT = [2, 36];

/** Settle with `promise`, or reject with the abort reason as soon as `signal` aborts. */
async function untilAborted(promise, signal) {
	if (!signal) return promise;
	const aborted = Promise.withResolvers();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		signal.throwIfAborted();
		return await Promise.race([promise, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Run `git <args>` with output to files and resolve with its exit code. Aborting `signal`
 * kills the whole process tree, so nothing a wrapper or hook started outlives the abort,
 * and rejects with the reason. Throws `ENOENT` when no git is on `env`'s PATH.
 */
async function runGitToFiles(args, { cwd, env, stdout, stderr, signal }) {
	const posix = process.platform !== "win32";
	// No await between this check and the abort listener below, so no abort can be missed.
	signal?.throwIfAborted();
	const child = Bun.spawn(["git", ...args], {
		cwd,
		env,
		stdin: "ignore",
		stdout,
		stderr,
		// With a signal, own process group (setsid) so an abort also stops what it spawned, e.g. `npm install`.
		detached: posix && signal !== undefined,
	});
	// Windows has no process groups; pin the root now so killTree still finds its descendants on abort.
	// shortcut: killTree misses descendants of MSYS `sh` fork stubs (taskkill /T does too); a Job Object would catch them.
	const root = signal && !posix ? api().Process.fromPid(child.pid) : null;
	const onAbort = () => {
		try {
			if (posix) process.kill(-child.pid, "SIGKILL");
			else root?.killTree();
		} catch {
			// Already exited.
		}
		child.kill();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	let exitCode;
	try {
		exitCode = await child.exited;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
	signal?.throwIfAborted();
	return exitCode;
}

/**
 * Whether the git on `env`'s PATH can run hooks: "no-git" when none starts or `git version`
 * fails, "old-git" when it predates `git hook run`, else undefined. Output goes to a file in
 * `captureDir`, so a wrapper's lingering child cannot hold the result back.
 */
async function hookRunnerProblem(captureDir, cwd, env, signal) {
	const outPath = path.join(captureDir, "version");
	let exitCode;
	try {
		exitCode = await runGitToFiles(["version"], { cwd, env, stdout: Bun.file(outPath), stderr: "ignore", signal });
	} catch (error) {
		if (error?.code === "ENOENT") return "no-git";
		throw error;
	}
	if (exitCode !== 0) return "no-git";
	const match = /^git version (\d+)\.(\d+)/.exec(await Bun.file(outPath).text());
	// An unrecognised version string gets the benefit of the doubt.
	if (!match) return undefined;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	const [minMajor, minMinor] = HOOK_RUN_MIN_GIT;
	return major < minMajor || (major === minMajor && minor < minMinor) ? "old-git" : undefined;
}

/** Config overrides git honours but gix does not read; `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` gix reads itself. */
const GIX_IGNORED_CONFIG_VARS = new Set([
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
]);

/**
 * Where git looks for the `post-checkout` hook. Found in-process, as `find_hook` does, unless
 * `env` carries a config override gix does not read; then git itself answers. Undefined when
 * that git can't.
 */
async function postCheckoutHookPath(captureDir, worktreeRoot, env, signal) {
	const overridden = Object.keys(env ?? process.env).some(name => GIX_IGNORED_CONFIG_VARS.has(name.toUpperCase()));
	if (!overridden) return git(worktreeRoot)?.hookLocation("post-checkout", signal);
	const outPath = path.join(captureDir, "git-path");
	try {
		const args = ["rev-parse", "--git-path", "hooks/post-checkout"];
		const exitCode = await runGitToFiles(args, { cwd: worktreeRoot, env, stdout: Bun.file(outPath), stderr: "ignore", signal });
		if (exitCode !== 0) return undefined;
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
	// A relative result is relative to the worktree, where `git hook run` runs.
	return path.resolve(worktreeRoot, (await Bun.file(outPath).text()).trim());
}

/**
 * Run Git's checkout hook in a newly created linked worktree, using the same
 * null old HEAD and branch-switch flag as `git worktree add`. Without a hook
 * nothing is spawned unless `GIT_CONFIG*` overrides make git locate it. Returns
 * once `git hook run` exits, even if the hook left a background process running,
 * with the last 64 KiB of each output stream; `skipped` says why an existing hook
 * did not run. Aborting `options.signal` kills the hook's process tree and rejects
 * with the reason, also while a filesystem check is stalled.
 */
export async function runPostCheckoutHook(worktreeRoot, head, options = {}) {
	const { signal, env } = options;
	signal?.throwIfAborted();
	const notRun = { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
	const posix = process.platform !== "win32";
	if (!posix) void sweepStaleHookCaptures();
	// Files, not pipes: a background process git or the hook starts inherits them, and pipes would stay open until it exits.
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), HOOK_CAPTURE_PREFIX));
	try {
		const hookPath = await postCheckoutHookPath(dir, worktreeRoot, env, signal);
		if (!hookPath) return notRun;
		// Only a missing path means no hook; any other failure (EACCES, EIO) is reported, not mistaken for one.
		const missing = error => error?.code === "ENOENT" || error?.code === "ENOTDIR";
		const stat = await untilAborted(
			fs.promises.stat(hookPath).catch(error => (missing(error) ? null : error)),
			signal,
		);
		if (stat instanceof Error) return { ...notRun, skipped: { path: hookPath, reason: "inaccessible" } };
		if (!stat?.isFile()) return notRun;
		// Git's own `access(X_OK)` check; Git for Windows ignores the bit.
		if (posix) {
			const access = fs.promises.access(hookPath, fs.constants.X_OK).then(
				() => true,
				() => false,
			);
			if (!(await untilAborted(access, signal))) {
				return { ...notRun, skipped: { path: hookPath, reason: "not-executable" } };
			}
		}
		const reason = await hookRunnerProblem(dir, worktreeRoot, env, signal);
		if (reason) return { ...notRun, skipped: { path: hookPath, reason } };
		const outPath = path.join(dir, "stdout");
		const errPath = path.join(dir, "stderr");
		const nullOid = "0".repeat(head.length);
		const exitCode = await runGitToFiles(["hook", "run", "--ignore-missing", "post-checkout", "--", nullOid, head, "1"], {
			cwd: worktreeRoot,
			env,
			stdout: Bun.file(outPath),
			stderr: Bun.file(errPath),
			signal,
		});
		const tail = file => file.slice(Math.max(0, file.size - HOOK_OUTPUT_TAIL_BYTES)).bytes();
		const [stdout, stderr] = await Promise.all([tail(Bun.file(outPath)), tail(Bun.file(errPath))]);
		return { exitCode, stdout, stderr };
	} finally {
		// A lingering child may still hold the files open on Windows; leave them for the OS then.
		await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/** Join patch fragments, preserving each part's trailing newline. */
export function joinPatches(parts) {
	return api().vcsJoinPatches(parts);
}

/** Validate hunk selections against a raw diff. */
export function validateHunkSelections(rawDiff, selections) {
	return api().vcsValidateHunkSelections(rawDiff, selections);
}

/** Stat-poll interval for {@link watch}. */
export const HEAD_WATCH_INTERVAL_MS = 1000;

/**
 * Watch a repository for head changes; returns a disposer.
 *
 * Stat-polls via `fs.watchFile` instead of `fs.watch`: backends may atomically
 * replace the watched entry, permanently silencing inotify-backed watchers.
 */
export function watch(repo, onChange, intervalMs = HEAD_WATCH_INTERVAL_MS) {
	const target = repo.watchTarget();
	const listener = (curr, prev) => {
		if (curr.mtimeMs !== prev.mtimeMs || curr.ino !== prev.ino || curr.size !== prev.size) onChange();
	};
	fs.watchFile(target, { interval: intervalMs }, listener).unref();
	return () => fs.unwatchFile(target, listener);
}
