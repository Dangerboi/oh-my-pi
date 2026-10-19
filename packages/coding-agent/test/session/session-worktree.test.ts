import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { shortenPath, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { filterChildShellEnv, setWorktreesDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import {
	canAutoCreateWorktree,
	createSessionWorktree,
	decideWorktreeExit,
	inspectSessionWorktree,
	planWorktreeExit,
	removeExitWorktrees,
	removeSessionWorktree,
	type SessionWorktreeState,
	type WorktreeExitAction,
} from "../../src/session/session-worktree";
import { runWorktreeCheckoutHook } from "../../src/utils/worktree-hook";

const clean: SessionWorktreeState = { dirty: false, moved: false, offBranch: false };

const rows: [
	name: string,
	policy: "keep" | "ask" | "remove",
	state: SessionWorktreeState,
	expected: WorktreeExitAction,
][] = [
	["keep ignores state", "keep", { dirty: true, moved: true, offBranch: true }, "keep"],
	["ask prompts even when clean", "ask", clean, "prompt"],
	["remove removes a clean worktree", "remove", clean, "remove"],
	["remove prompts when dirty", "remove", { ...clean, dirty: true }, "prompt"],
	["remove prompts when the branch moved", "remove", { ...clean, moved: true }, "prompt"],
	["remove prompts when HEAD left the branch", "remove", { ...clean, offBranch: true }, "prompt"],
];

describe("decideWorktreeExit", () => {
	it.each(rows)("%s", (_name, policy, state, action) => {
		expect(decideWorktreeExit(policy, state)).toBe(action);
	});
});

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

function worktreePaths(repo: string): string[] {
	return git(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter(line => line.startsWith("worktree "))
		.map(line => path.resolve(line.slice("worktree ".length)));
}

function branchSha(repo: string, branch: string): string | null {
	const r = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
		cwd: repo,
		stdout: "pipe",
	});
	return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

const exists = (p: string) =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

const commitFile = async (cwd: string, name: string) => {
	await Bun.write(path.join(cwd, name), "x\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-q", "-m", `add ${name}`);
};

describe("session worktree helpers (real git)", () => {
	let root: string;
	let repo: string;
	let savedEnv: string | undefined;
	let savedCwd: string;
	const branch = "wt/test-session";

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-wt-")));
		repo = path.join(root, "repo");
		await fs.mkdir(repo);
		savedEnv = process.env.OMP_WORKTREE_DIR;
		savedCwd = process.cwd();
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(path.join(root, "wt"));
		git(repo, "init", "-q", "-b", "main");
		git(repo, "config", "core.autocrlf", "false");
		await Bun.write(path.join(repo, "tracked.txt"), "base\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
	});

	afterEach(async () => {
		process.chdir(savedCwd);
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		await fs.rm(root, { recursive: true, force: true });
	});

	const create = (keepChanges = true, name = branch) =>
		createSessionWorktree(repo, Settings.isolated(), name, { keepChanges });

	it("offers a worktree only in a primary checkout with commits", async () => {
		const plain = path.join(root, "plain");
		const unborn = path.join(root, "unborn");
		await fs.mkdir(plain);
		await fs.mkdir(unborn);
		git(unborn, "init", "-q");
		await expect(createSessionWorktree(unborn, Settings.isolated(), branch)).rejects.toThrow("has no commits");
		expect(await exists(path.join(root, "wt"))).toBe(false);
		const wt = await create();
		expect(await canAutoCreateWorktree(repo)).toBe(true);
		expect(await canAutoCreateWorktree(plain)).toBe(false);
		expect(await canAutoCreateWorktree(unborn)).toBe(false);
		expect(await canAutoCreateWorktree(wt.path)).toBe(false);
	});

	it("removes a clean worktree and deletes its branch", async () => {
		const wt = await create();
		expect(worktreePaths(repo)).toContain(wt.path);
		expect(await inspectSessionWorktree(wt)).toEqual(clean);
		await removeSessionWorktree(wt, false);
		expect(await exists(wt.path)).toBe(false);
		expect(worktreePaths(repo)).not.toContain(wt.path);
		expect(branchSha(repo, branch)).toBeNull();
	});

	it("keeps the branch at the new commit when the worktree moved", async () => {
		const wt = await create();
		await commitFile(wt.path, "new.txt");
		const tip = git(wt.path, "rev-parse", "HEAD");
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, moved: true });
		await removeSessionWorktree(wt, true);
		expect(await exists(wt.path)).toBe(false);
		expect(worktreePaths(repo)).not.toContain(wt.path);
		expect(branchSha(repo, branch)).toBe(tip);
	});

	it("prompts instead of removing when commits exist only on a detached HEAD", async () => {
		const wt = await create();
		git(wt.path, "switch", "-q", "--detach");
		await commitFile(wt.path, "detached.txt");
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, offBranch: true });
		const prompts: string[] = [];
		const plan = await planWorktreeExit(
			[wt],
			"remove",
			async (_title, message) => {
				prompts.push(message);
				return false;
			},
			() => {},
		);
		expect(plan).toEqual([]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(`HEAD is not on ${branch}`);
		expect(await exists(wt.path)).toBe(true);
	});

	it("reports moved from the source repo when the worktree dir was deleted externally", async () => {
		const wt = await create();
		await commitFile(wt.path, "new.txt");
		await fs.rm(wt.path, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		expect(worktreePaths(repo)).not.toContain(wt.path);
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, moved: true });
	});

	it("rejects and keeps the branch when git cannot remove the worktree", async () => {
		const wt = await create();
		await fs.rm(wt.path, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		await expect(removeSessionWorktree(wt, false)).rejects.toThrow(`branch '${branch}' kept`);
		expect(branchSha(repo, branch)).toBe(wt.baseCommit);
	});

	it("starts from clean HEAD with keepChanges:false and reports worktree edits as dirty", async () => {
		await Bun.write(path.join(repo, "tracked.txt"), "edited\n");
		await Bun.write(path.join(repo, "untracked.txt"), "u\n");
		const wt = await create(false);
		expect(wt.keptChanges).toBe(false);
		expect(wt.baseCommit).toBe(git(repo, "rev-parse", "HEAD"));
		expect(await Bun.file(path.join(wt.path, "tracked.txt")).text()).toBe("base\n");
		expect(await exists(path.join(wt.path, "untracked.txt"))).toBe(false);
		expect(git(wt.path, "status", "--porcelain")).toBe("");
		expect(git(repo, "diff", "--name-only")).toBe("tracked.txt");
		expect(git(repo, "ls-files", "--others", "--exclude-standard")).toBe("untracked.txt");
		expect(await inspectSessionWorktree(wt)).toEqual(clean);
		await Bun.write(path.join(wt.path, "tracked.txt"), "wt edit\n");
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, dirty: true });
	});

	it("plans newest first and removes from inside the newest worktree", async () => {
		const older = await create(true, "wt/older");
		const newer = await create(true, "wt/newer");
		const plan = await planWorktreeExit(
			[older, newer],
			"remove",
			async () => {
				throw new Error("clean worktrees must not prompt");
			},
			() => {},
		);
		expect(plan.map(p => p.worktree.branch)).toEqual(["wt/newer", "wt/older"]);
		process.chdir(newer.path);
		expect(await removeExitWorktrees(plan)).toEqual([
			`Removed worktree ${shortenPath(newer.path)}. Resuming opens in the directory you launch omp from.`,
		]);
		expect(await fs.realpath(process.cwd())).toBe(repo);
		expect(worktreePaths(repo)).toEqual([repo]);
		expect(branchSha(repo, "wt/newer")).toBeNull();
		expect(branchSha(repo, "wt/older")).toBeNull();
	});

	it("keeps a worktree removed without a prompt that changed after planning", async () => {
		const wt = await create();
		const plan = await planWorktreeExit(
			[wt],
			"remove",
			async () => true,
			() => {},
		);
		expect(plan.map(p => p.worktree)).toEqual([wt]);
		await Bun.write(path.join(wt.path, "late.txt"), "written during teardown\n");
		const messages = await removeExitWorktrees(plan);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("changed while the session was closing");
		expect(await Bun.file(path.join(wt.path, "late.txt")).text()).toBe("written during teardown\n");
	});

	it("keeps a confirmed dirty worktree that got more uncommitted edits after the prompt", async () => {
		const wt = await create();
		await Bun.write(path.join(wt.path, "dirty.txt"), "d\n");
		const plan = await planWorktreeExit(
			[wt],
			"ask",
			async () => true,
			() => {},
		);
		expect(plan.map(p => p.worktree)).toEqual([wt]);
		await Bun.write(path.join(wt.path, "dirty.txt"), "more work written during teardown\n");
		const messages = await removeExitWorktrees(plan);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("changed while the session was closing");
		expect(await exists(wt.path)).toBe(true);
	});

	it("removes a confirmed dirty worktree, keeps a moved branch, and names it in the resume note", async () => {
		const wt = await create();
		await commitFile(wt.path, "work.txt");
		const tip = git(wt.path, "rev-parse", "HEAD");
		await Bun.write(path.join(wt.path, "dirty.txt"), "d\n");
		const plan = await planWorktreeExit(
			[wt],
			"ask",
			async () => true,
			() => {},
		);
		expect(plan.map(p => p.worktree)).toEqual([wt]);
		process.chdir(wt.path);
		expect(await removeExitWorktrees(plan)).toEqual([
			`Removed worktree ${shortenPath(wt.path)}. Resuming opens in the directory you launch omp from; its commits are on branch ${branch}.`,
		]);
		expect(await exists(wt.path)).toBe(false);
		expect(branchSha(repo, branch)).toBe(tip);
	});

	it("returns a message instead of throwing when removal fails", async () => {
		const wt = await create();
		const plan = await planWorktreeExit(
			[wt],
			"remove",
			async () => true,
			() => {},
		);
		await fs.rm(wt.path, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		const messages = await removeExitWorktrees(plan);
		expect(messages).toEqual([`Failed to remove worktree ${wt.path}; branch '${branch}' kept.`]);
		expect(branchSha(repo, branch)).toBe(wt.baseCommit);
	});

	describe.skipIf(process.platform === "win32")("post-checkout hook", () => {
		const hook = async (script: string) => {
			const hooks = path.join(repo, ".git", "hooks");
			git(repo, "config", "core.hooksPath", hooks);
			await Bun.write(path.join(hooks, "post-checkout"), `#!/bin/sh\n${script}\n`);
			await fs.chmod(path.join(hooks, "post-checkout"), 0o755);
		};
		// Settles a deliberately stalled filesystem call even when its test times out, so nothing stays pending.
		let releaseStalled: (() => void) | undefined;
		afterEach(() => {
			releaseStalled?.();
			releaseStalled = undefined;
		});

		it("runs in the new worktree with git's new-worktree arguments", async () => {
			await hook('printf "%s\\n" "$PWD" "$1" "$2" "$3" > .post-checkout-ran');
			const wt = await create();
			const marker = (await Bun.file(path.join(wt.path, ".post-checkout-ran")).text()).trim().split("\n");

			expect(marker).toEqual([wt.path, "0".repeat(wt.baseCommit.length), wt.baseCommit, "1"]);
			expect(wt.hook?.error).toBeUndefined();
		});

		it("hides the agent's own GIT_DIR from the hook", async () => {
			const wt = await create();
			await hook("git rev-parse --absolute-git-dir > .git-dir-seen");
			const helper = path.resolve(import.meta.dir, "../../src/utils/worktree-hook.ts");
			const script = `import { runWorktreeCheckoutHook } from ${JSON.stringify(helper)};
await runWorktreeCheckoutHook(${JSON.stringify(wt.path)}, ${JSON.stringify(wt.baseCommit)});`;
			// Launched with GIT_DIR, as omp is from a git hook or `git --git-dir` wrapper; spawns inherit the launch env.
			const run = Bun.spawnSync([process.execPath, "--no-install", "--eval", script], {
				env: { ...process.env, GIT_DIR: path.join(repo, ".git") },
				stderr: "pipe",
			});

			expect(run.stderr.toString()).toBe("");
			expect((await Bun.file(path.join(wt.path, ".git-dir-seen")).text()).trim()).toBe(
				git(wt.path, "rev-parse", "--absolute-git-dir"),
			);
		});

		it("keeps the worktree and reports a failing hook without terminal escapes or the home path", async () => {
			await hook(`printf '\\033[31msetup failed in %s/proj\\033[0m\\n' "${os.homedir()}" >&2; exit 17`);
			const wt = await create();

			expect(worktreePaths(repo)).toContain(wt.path);
			expect(wt.hook?.error).toBe("post-checkout hook exited with 17: setup failed in ~/proj");
		});

		// The longest line the TUI renders for it: showWarning's "Warning: " plus /wt's "Worktree created, but ".
		const rendered = (warning: string | undefined) => Bun.stringWidth(`Warning: Worktree created, but ${warning}`);

		it("keeps the whole rendered failure warning within one display line when the hook's last line is long", async () => {
			await hook(`printf '%0300d\\n' 0 >&2; exit 3`);
			const wt = await create();

			expect(wt.hook?.error).toStartWith("post-checkout hook exited with 3: 000");
			expect(rendered(wt.hook?.error)).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
		});

		it("cuts a long hook path, never the reason it did not run", async () => {
			const hooks = path.join(root, "h".repeat(150));
			git(repo, "config", "core.hooksPath", hooks);
			await Bun.write(path.join(hooks, "post-checkout"), "#!/bin/sh\ntouch .post-checkout-ran\n");
			await fs.chmod(path.join(hooks, "post-checkout"), 0o644);
			const wt = await create();

			expect(wt.hook?.skipped).toEndWith(" is not executable, so git skipped it");
			expect(rendered(wt.hook?.skipped)).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
		});

		it("finds a hook under a relative core.hooksPath that starts with a space", async () => {
			const wt = await create();
			git(repo, "config", "core.hooksPath", " spaced-hooks");
			const hookFile = path.join(wt.path, " spaced-hooks", "post-checkout");
			await Bun.write(hookFile, "#!/bin/sh\ntouch .post-checkout-ran\n");
			await fs.chmod(hookFile, 0o755);
			const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, {
				env: filterChildShellEnv(process.env),
			});

			expect(result.exitCode).toBe(0);
			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(true);
		});

		it("reports a non-executable hook without running it", async () => {
			await hook("touch .post-checkout-ran");
			await fs.chmod(path.join(repo, ".git", "hooks", "post-checkout"), 0o644);
			const wt = await create();

			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(false);
			expect(wt.hook?.error).toBeUndefined();
			expect(wt.hook?.skipped).toContain("is not executable");
		});

		it("reports a directory at the hook path as a failing hook, as git does, not as no hook", async () => {
			const hooks = path.join(repo, ".git", "hooks");
			git(repo, "config", "core.hooksPath", hooks);
			await fs.mkdir(path.join(hooks, "post-checkout"), { recursive: true, mode: 0o755 });
			const wt = await create();

			expect(worktreePaths(repo)).toContain(wt.path);
			expect(wt.hook?.error).toStartWith("post-checkout hook exited with ");
		});

		const gitlessRows: [name: string, hookPresent: boolean, fakeGit: string | null, reason?: "no-git" | "old-git"][] =
			[
				["needs no git binary when there is no hook", false, null, undefined],
				["reports, without failing, a hook it cannot run without git", true, null, "no-git"],
				[
					"reports, without failing, a hook a Git older than 2.36 cannot run",
					true,
					`[ "$1" = version ] && echo "git version 2.34.1" && exit 0\necho "git: '$1' is not a git command" >&2\nexit 1`,
					"old-git",
				],
				["reports, without failing, a hook when `git version` fails", true, "exit 1", "no-git"],
			];
		it.each(gitlessRows)("%s", async (_name, hookPresent, fakeGit, reason) => {
			git(repo, "config", "core.hooksPath", path.join(repo, ".git", "hooks"));
			const wt = await create();
			if (hookPresent) await hook("touch .post-checkout-ran");
			const bin = path.join(root, "bin");
			await fs.mkdir(bin, { recursive: true });
			if (fakeGit !== null) {
				await Bun.write(path.join(bin, "git"), `#!/bin/sh\n${fakeGit}\n`);
				await fs.chmod(path.join(bin, "git"), 0o755);
			}
			const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env: { PATH: bin } });

			expect(result.exitCode).toBe(0);
			expect(result.skipped?.reason).toBe(reason);
			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(false);
		});

		// Root bypasses directory permissions, so the stat would not fail.
		it.skipIf(process.getuid?.() === 0)(
			"reports, rather than silently skips, a hook that cannot be read",
			async () => {
				const wt = await create();
				await hook("touch .post-checkout-ran");
				const hooks = path.join(repo, ".git", "hooks");
				await fs.chmod(hooks, 0o000);
				try {
					const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, {
						env: filterChildShellEnv(process.env),
					});

					expect(result.skipped?.reason).toBe("inaccessible");
				} finally {
					await fs.chmod(hooks, 0o755);
				}
				expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(false);
			},
		);

		it("discards the new worktree and branch when the hook runner fails, so the name can be reused", async () => {
			await hook("touch .post-checkout-ran");
			const realOpen = nodeFs.promises.open;
			// Only the runner's capture file fails, as on a full disk.
			const open = spyOn(nodeFs.promises, "open").mockImplementation(((
				file: nodeFs.PathLike,
				mode: string,
				...rest: []
			) =>
				mode === "w" && path.basename(path.dirname(String(file))).startsWith("omp-post-checkout-")
					? Promise.reject(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }))
					: realOpen(file, mode, ...rest)) as typeof realOpen);
			try {
				await expect(create()).rejects.toThrow("no space left on device");
			} finally {
				open.mockRestore();
			}

			expect(branchSha(repo, branch)).toBeNull();
			const retried = await create();
			expect(await exists(path.join(retried.path, ".post-checkout-ran"))).toBe(true);
		});

		it.each([
			["", "touch .post-checkout-ran"],
			// Its path lookup then fails too; started after the abort, that failure would go unhandled.
			[", also when the hook removed the worktree", 'rm -rf "$PWD"'],
		])(
			"an abort landing just as the hook finishes still cancels /wt and leaves nothing behind%s",
			async (_name, script) => {
				await hook(script);
				const controller = new AbortController();
				const runHook = vcs.runPostCheckoutHook;
				// The hook completes, then the user's Esc arrives before /wt hands the worktree over.
				const run = spyOn(vcs, "runPostCheckoutHook").mockImplementation(async (...args) => {
					const result = await runHook(...args);
					controller.abort();
					return result;
				});
				try {
					await expect(
						createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal }),
					).rejects.toMatchObject({ name: "AbortError" });
				} finally {
					run.mockRestore();
				}

				expect(worktreePaths(repo)).toEqual([repo]);
				expect(branchSha(repo, branch)).toBeNull();
			},
		);

		it.each([
			["chosen", "stat"],
			["resolved", "realpath"],
		] as const)(
			"an abort while the new worktree's path is still being %s cancels /wt and leaves nothing behind",
			async (_name, method) => {
				await hook("touch .post-checkout-ran");
				const worktrees = path.join(root, "wt");
				const reached = Promise.withResolvers<void>();
				const real = fs[method] as (file: nodeFs.PathLike, ...rest: unknown[]) => Promise<unknown>;
				// A lookup that never settles, as with `worktree.base` on a stalled network filesystem.
				const lookup = spyOn(fs, method).mockImplementation(((file: nodeFs.PathLike, ...rest: unknown[]) => {
					if (!String(file).startsWith(`${worktrees}${path.sep}`)) return real(file, ...rest);
					reached.resolve();
					const stalled = Promise.withResolvers<never>();
					releaseStalled = () => stalled.reject(Object.assign(new Error("released"), { code: "ENOENT" }));
					return stalled.promise;
				}) as never);
				const controller = new AbortController();
				const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
				try {
					await reached.promise;
				} finally {
					lookup.mockRestore();
				}
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });

				expect(worktreePaths(repo)).toEqual([repo]);
				expect(branchSha(repo, branch)).toBeNull();
			},
		);

		it("reports a hook as not run when the git on PATH cannot start", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const bin = path.join(root, "broken-bin");
			// Executable but not a program: spawning it fails with ENOEXEC.
			await Bun.write(path.join(bin, "git"), "not a program\n");
			await fs.chmod(path.join(bin, "git"), 0o755);
			const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env: { PATH: bin } });

			expect(result.skipped?.reason).toBe("no-git");
			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(false);
		});

		/** Start `run` while the repository's shared config is a named pipe, which stalls whatever reads it as a stalled filesystem would; abort once it is being read. */
		const abortWhileConfigStalls = async (run: (signal: AbortSignal) => Promise<unknown>) => {
			const config = path.join(repo, ".git", "config");
			await fs.rename(config, `${config}.real`);
			expect(Bun.spawnSync(["mkfifo", config]).exitCode).toBe(0);
			const controller = new AbortController();
			const pending = run(controller.signal);
			// Opening the writing end waits until the reader opened the pipe; its read then stalls.
			const writer = await fs.open(config, "w");
			try {
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			} finally {
				// The real config first: the abandoned reader may open it again after this read, and must not meet the pipe.
				await fs.rename(`${config}.real`, config);
				// End of file then lets that read finish.
				await writer.close();
			}
		};

		it("abort is not held up by a stalled repository when no git can locate the hook", async () => {
			const wt = await create();
			await abortWhileConfigStalls(signal =>
				vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { signal, env: { PATH: path.join(root, "no-git") } }),
			);
		});

		it("an abort while /wt is still finding the repository cancels it and leaves nothing behind", async () => {
			await abortWhileConfigStalls(signal => createSessionWorktree(repo, Settings.isolated(), branch, { signal }));

			expect(worktreePaths(repo)).toEqual([repo]);
			expect(branchSha(repo, branch)).toBeNull();
		});

		it("an abort while the hook's environment is still being read cancels /wt and leaves nothing behind", async () => {
			await hook("touch .post-checkout-ran");
			const reached = Promise.withResolvers<void>();
			const stalled = Promise.withResolvers<string>();
			const realReadFile = nodeFs.promises.readFile;
			// The project's dotenv files on a stalled filesystem.
			const readFile = spyOn(nodeFs.promises, "readFile").mockImplementation(((
				file: nodeFs.PathLike,
				...rest: []
			) => {
				if (!path.basename(String(file)).startsWith(".env")) return realReadFile(file, ...rest);
				reached.resolve();
				return stalled.promise;
			}) as typeof realReadFile);
			const controller = new AbortController();
			try {
				const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
				await reached.promise;
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			} finally {
				readFile.mockRestore();
				stalled.resolve("");
			}

			expect(worktreePaths(repo)).toEqual([repo]);
			expect(branchSha(repo, branch)).toBeNull();
		});

		it.each([
			["without a hook", undefined],
			["without running a hook, which is reported", "touch .post-checkout-ran"],
		])("/wt goes through %s when no capture directory can be created", async (_name, script) => {
			// A hooks directory holding at most this hook, so no global hook counts either.
			git(repo, "config", "core.hooksPath", path.join(repo, ".git", "hooks"));
			if (script) await hook(script);
			const tmpdir = spyOn(os, "tmpdir").mockReturnValue(path.join(root, "no-such-tmp"));
			try {
				const wt = await create();
				expect(await exists(path.join(wt.path, ".git"))).toBe(true);
				expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(false);
				if (script) expect(wt.hook?.skipped).toContain("TMPDIR");
				else expect(wt.hook?.skipped).toBeUndefined();
			} finally {
				tmpdir.mockRestore();
			}
		});

		it("leaves alone a worktree another process created at the chosen path first", async () => {
			git(repo, "config", "core.hooksPath", path.join(repo, ".git", "hooks"));
			const repoProto = Object.getPrototypeOf(vcs.requireGit(repo));
			const worktreeAdd = repoProto.worktreeAdd;
			let taken = "";
			// Another process wins the race for the same free path, so this attempt's add fails.
			const add = spyOn(repoProto, "worktreeAdd").mockImplementation(function (this: unknown, ...args: unknown[]) {
				taken = String(args[0]);
				git(repo, "worktree", "add", "-q", "--detach", taken, "HEAD");
				return worktreeAdd.apply(this, args);
			});
			try {
				await expect(create()).rejects.toThrow();
			} finally {
				add.mockRestore();
			}

			expect(await exists(path.join(taken, ".git"))).toBe(true);
			expect(worktreePaths(repo)).toContain(await fs.realpath(taken));
			expect(branchSha(repo, branch)).toBeNull();
		});

		it("lets the git on PATH locate the hook, including config only it knows about", async () => {
			const wt = await create();
			const injected = path.join(root, "wrapper-hooks");
			await Bun.write(path.join(injected, "post-checkout"), "#!/bin/sh\ntouch .post-checkout-ran\n");
			await fs.chmod(path.join(injected, "post-checkout"), 0o755);
			const systemConfig = path.join(root, "wrapper-gitconfig");
			await Bun.write(systemConfig, `[core]\n\thooksPath = ${injected}\n`);
			// A wrapper bringing its own system config, as some git distributions do.
			const bin = path.join(root, "wrapper-bin");
			await Bun.write(
				path.join(bin, "git"),
				`#!/bin/sh\nexport GIT_CONFIG_SYSTEM="${systemConfig}" GIT_CONFIG_GLOBAL=/dev/null\nexec "${Bun.which("git")}" "$@"\n`,
			);
			await fs.chmod(path.join(bin, "git"), 0o755);
			const {
				GIT_CONFIG_GLOBAL: _global,
				GIT_CONFIG_SYSTEM: _system,
				GIT_CONFIG_NOSYSTEM: _noSystem,
				...ambient
			} = filterChildShellEnv(process.env);
			// The supplied environment itself carries no config override.
			const env = { ...ambient, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
			const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env });

			expect(result.exitCode).toBe(0);
			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(true);
		});

		it("falls back to the in-process lookup when the git on PATH reports no hook path", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const bin = path.join(root, "quiet-bin");
			await Bun.write(
				path.join(bin, "git"),
				`#!/bin/sh\n[ "$1" = rev-parse ] && exit 0\nexec "${Bun.which("git")}" "$@"\n`,
			);
			await fs.chmod(path.join(bin, "git"), 0o755);
			const env = { ...filterChildShellEnv(process.env), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
			const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env });

			expect(result.exitCode).toBe(0);
			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(true);
		});

		it("runs the hook away from the terminal of the agent that started it", async () => {
			await hook("ps -o pgid= -p $$ > .post-checkout-group");
			const wt = await create();
			const hookGroup = (await Bun.file(path.join(wt.path, ".post-checkout-group")).text()).trim();
			const ownGroup = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)])
				.stdout.toString()
				.trim();

			// Its own session and process group (setsid), so a prompt on /dev/tty fails instead of writing into the TUI.
			expect(hookGroup).not.toBe(ownGroup);
		});

		it("keeps the git probes before the hook away from the agent's terminal too", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const bin = path.join(root, "probe-bin");
			const groups = path.join(root, "probe-groups");
			await Bun.write(
				path.join(bin, "git"),
				`#!/bin/sh\ncase "$1" in rev-parse|version) echo "$1 $(ps -o pgid= -p $$)" >> "${groups}";; esac\nexec "${Bun.which("git")}" "$@"\n`,
			);
			await fs.chmod(path.join(bin, "git"), 0o755);
			const env = { ...filterChildShellEnv(process.env), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
			await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env, detached: true });
			const ownGroup = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)])
				.stdout.toString()
				.trim();
			const probes = (await Bun.file(groups).text())
				.trim()
				.split("\n")
				.map(line => line.split(/\s+/));

			expect(probes.map(([probe]) => probe)).toEqual(["rev-parse", "version"]);
			for (const [, group] of probes) expect(group).not.toBe(ownGroup);
		});

		it("returns when a git wrapper's background child keeps the version output open", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const bin = path.join(root, "bin");
			const lingering = path.join(root, "lingering-pid");
			await Bun.write(
				path.join(bin, "git"),
				`#!/bin/sh\nif [ "$1" = version ]; then\n  sleep 30 &\n  echo $! > "${lingering}"\nfi\nexec "${Bun.which("git")}" "$@"\n`,
			);
			await fs.chmod(path.join(bin, "git"), 0o755);
			const env = { ...filterChildShellEnv(process.env), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
			try {
				const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env });

				expect(result.exitCode).toBe(0);
				expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(true);
			} finally {
				try {
					process.kill(Number((await fs.readFile(lingering, "utf8")).trim()), "SIGKILL");
				} catch {}
			}
		});

		it("abort is not held up by a stalled hook-file check", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const hookFile = path.join(repo, ".git", "hooks", "post-checkout");
			const reached = Promise.withResolvers<void>();
			const realStat = nodeFs.promises.stat;
			// A stat that never settles, as on a stalled network filesystem.
			const stat = spyOn(nodeFs.promises, "stat").mockImplementation(((file: nodeFs.PathLike, ...rest: []) => {
				if (path.resolve(String(file)) !== hookFile) return realStat(file, ...rest);
				reached.resolve();
				const stalled = Promise.withResolvers<nodeFs.Stats>();
				releaseStalled = () => stalled.reject(Object.assign(new Error("released"), { code: "ENOENT" }));
				return stalled.promise;
			}) as typeof realStat);
			const controller = new AbortController();
			const pending = vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { signal: controller.signal });
			try {
				await reached.promise;
			} finally {
				// Restored before the outcome is awaited, so a regression can't leak the stalled stat into other tests.
				stat.mockRestore();
			}
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		});

		it("abort is not held up by a stalled capture directory", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const reached = Promise.withResolvers<void>();
			const realMkdtemp = nodeFs.promises.mkdtemp;
			// A temp directory that never appears, as on a stalled network-mounted TMPDIR.
			const mkdtemp = spyOn(nodeFs.promises, "mkdtemp").mockImplementation(((prefix: string, ...rest: []) => {
				if (!prefix.includes("omp-post-checkout-")) return realMkdtemp(prefix, ...rest);
				reached.resolve();
				const stalled = Promise.withResolvers<string>();
				releaseStalled = () => stalled.reject(Object.assign(new Error("released"), { code: "ENOENT" }));
				return stalled.promise;
			}) as typeof realMkdtemp);
			const controller = new AbortController();
			const pending = vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { signal: controller.signal });
			try {
				await reached.promise;
			} finally {
				mkdtemp.mockRestore();
			}
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		});

		it.each([
			["reading the hook-path probe's output", "rev-parse", "r"],
			["reading the hook's output", "stdout", "r"],
			["creating the hook's output file", "stdout", "w"],
		])("abort is not held up by a stalled filesystem when %s", async (_name, capture, flags) => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const reached = Promise.withResolvers<void>();
			const realOpen = nodeFs.promises.open;
			// An open that never settles, as on a stalled network-mounted TMPDIR.
			const open = spyOn(nodeFs.promises, "open").mockImplementation(((
				file: nodeFs.PathLike,
				mode: string,
				...rest: []
			) => {
				const target = String(file);
				const isCapture =
					path.basename(target) === capture &&
					path.basename(path.dirname(target)).startsWith("omp-post-checkout-");
				if (!isCapture || mode !== flags) return realOpen(file, mode, ...rest);
				reached.resolve();
				const stalled = Promise.withResolvers<nodeFs.promises.FileHandle>();
				releaseStalled = () => stalled.reject(Object.assign(new Error("released"), { code: "ENOENT" }));
				return stalled.promise;
			}) as typeof realOpen);
			const controller = new AbortController();
			const pending = vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { signal: controller.signal });
			try {
				await reached.promise;
			} finally {
				open.mockRestore();
			}
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		});

		it("removes this host's hook captures whose omp process is gone, never those of a live one or another host", async () => {
			const wt = await create();
			const tmp = path.join(root, "tmp");
			await fs.mkdir(tmp);
			const tmpdir = spyOn(os, "tmpdir").mockReturnValue(tmp);
			const realMkdtemp = nodeFs.promises.mkdtemp;
			let prefix = "";
			const mkdtemp = spyOn(nodeFs.promises, "mkdtemp").mockImplementation(((given: string, ...rest: []) => {
				prefix = path.basename(given);
				return realMkdtemp(given, ...rest);
			}) as typeof realMkdtemp);
			const run = () => vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env: filterChildShellEnv(process.env) });
			try {
				// This host's own directory name, as a run creates it: `<prefix><host tag>-<pid>-`.
				await run();
				const own = prefix.slice(0, -`${process.pid}-`.length);
				// A pid whose process has already exited, as after omp crashed before its own cleanup.
				const gone = Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim();
				const left = path.join(tmp, `${own}${gone}-leftover`);
				// Its omp is alive: a hook that may be running for hours.
				const running = path.join(tmp, `${own}${process.pid}-running`);
				// Another host or container sharing the TMPDIR, whose pids mean nothing here.
				const foreign = path.join(tmp, `omp-post-checkout-otherhost-${gone}-elsewhere`);
				for (const dir of [left, running, foreign]) await Bun.write(path.join(dir, "stdout"), "output\n");
				await run();

				expect(await exists(left)).toBe(false);
				expect(await exists(path.join(running, "stdout"))).toBe(true);
				expect(await exists(path.join(foreign, "stdout"))).toBe(true);
			} finally {
				mkdtemp.mockRestore();
				tmpdir.mockRestore();
			}
		});

		it("returns when the hook exits even if it left a background process running", async () => {
			await hook("sleep 30 &\necho $! > .sleeper");
			const wt = await create();
			const sleeper = Number((await Bun.file(path.join(wt.path, ".sleeper")).text()).trim());
			process.kill(sleeper, "SIGKILL");

			expect(wt.hook?.error).toBeUndefined();
		});

		it("abort rejects promptly and kills what the hook spawned", async () => {
			const wt = await create();
			const ready = path.join(root, "hook-ready");
			expect(Bun.spawnSync(["mkfifo", ready]).exitCode).toBe(0);
			// `wait` keeps the hook running until aborted; only a process-group kill also stops the sleep.
			await hook(`sleep 30 &\necho $! > "${ready}"\nwait`);
			const controller = new AbortController();
			const pending = runWorktreeCheckoutHook(wt.path, wt.baseCommit, controller.signal);
			const sleeper = Number((await fs.readFile(ready, "utf8")).trim());
			try {
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
				const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(sleeper)])
					.stdout.toString()
					.trim();
				expect(state === "" || state.startsWith("Z")).toBe(true);
			} finally {
				try {
					process.kill(sleeper, "SIGKILL");
				} catch {}
			}
		});

		it.skipIf(!Bun.which("setsid"))("abort also kills a child the hook moved into its own session", async () => {
			const wt = await create();
			const ready = path.join(root, "hook-ready");
			expect(Bun.spawnSync(["mkfifo", ready]).exitCode).toBe(0);
			// `setsid` takes the sleep out of the hook's process group, so a group kill alone misses it. The pid is
			// written from inside the new session, so the abort cannot land before the child has left the group.
			await hook(`setsid sh -c 'echo $$ > "${ready}"; exec sleep 30' &\nwait`);
			const controller = new AbortController();
			const pending = runWorktreeCheckoutHook(wt.path, wt.baseCommit, controller.signal);
			const sleeper = Number((await fs.readFile(ready, "utf8")).trim());
			try {
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
				const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(sleeper)])
					.stdout.toString()
					.trim();
				expect(state === "" || state.startsWith("Z")).toBe(true);
			} finally {
				try {
					process.kill(sleeper, "SIGKILL");
				} catch {}
			}
		});

		it("abort also stops a hung git version check and what it spawned", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const bin = path.join(root, "bin");
			const ready = path.join(root, "probe-ready");
			expect(Bun.spawnSync(["mkfifo", ready]).exitCode).toBe(0);
			// A git wrapper that hangs on `version` with a child of its own; only a process-group kill also stops the sleep.
			await Bun.write(
				path.join(bin, "git"),
				`#!/bin/sh\nif [ "$1" = version ]; then\n  sleep 30 &\n  echo $! > "${ready}"\n  wait\nfi\nexec "${Bun.which("git")}" "$@"\n`,
			);
			await fs.chmod(path.join(bin, "git"), 0o755);
			const controller = new AbortController();
			const env = { ...filterChildShellEnv(process.env), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
			const pending = vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { signal: controller.signal, env });
			const sleeper = Number((await fs.readFile(ready, "utf8")).trim());
			try {
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
				const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(sleeper)])
					.stdout.toString()
					.trim();
				expect(state === "" || state.startsWith("Z")).toBe(true);
			} finally {
				try {
					process.kill(sleeper, "SIGKILL");
				} catch {}
			}
		});
	});
});
