# Embedded VS Code Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new tab type that embeds the user's local `code serve-web` instance, rendered via Electron `WebContentsView`, scoped to the active workspace's worktree path.

**Architecture:** Main process owns two per-pane singletons: a `code serve-web` child process and a `WebContentsView` pointing at its localhost URL. The renderer owns a transparent placeholder `<div>` whose bounds are observed and forwarded to main over tRPC so the WebContentsView floats exactly on top of the pane area. The child process and view are torn down when the pane is removed from the tabs store, when the window closes, or when the app quits.

**Tech Stack:** Electron `WebContentsView` + `BaseWindow.contentView.addChildView`, `node:child_process.spawn`, `node:net` port discovery, trpc-electron observable subscriptions, Zustand tabs store (same `PaneType` mechanism that already backs terminal / chat / webview / devtools / file-viewer panes), React + `ResizeObserver`.

---

## Constraints & Conventions

- **IPC uses tRPC only** (`apps/desktop/AGENTS.md`). No `ipcRenderer.invoke` / `ipcMain.handle`. Subscriptions use `observable()` (async generators are not supported by trpc-electron).
- **Pane lifetime drives process lifetime.** Start on first mount; `setVisible(false)` on unmount (tab switched away); full tear-down only on `removePane` / `removeTab` / window close / app quit.
- **Happy path only.** If the `code` binary is not resolvable on `$PATH` (after merging the user's login-shell PATH), the pane renders a fallback UI — no auto-download.
- **No `<iframe>` and no `<webview>` tag.** The pane is a transparent placeholder `<div>`; pixels come from a main-process-owned `WebContentsView`.
- **Token-less local server.** `--without-connection-token --accept-server-license-terms`, bound to `127.0.0.1` only.

## File Structure

**New files (main process)**
- `apps/desktop/src/main/lib/vscode/find-free-port.ts` — returns an available TCP port on `127.0.0.1`
- `apps/desktop/src/main/lib/vscode/find-free-port.test.ts`
- `apps/desktop/src/main/lib/vscode/check-code-cli.ts` — resolves whether the `code` binary is on `$PATH` (after shell-env merge)
- `apps/desktop/src/main/lib/vscode/check-code-cli.test.ts`
- `apps/desktop/src/main/lib/vscode/vscode-server.ts` — spawns `code serve-web`, waits for the `http://127.0.0.1:PORT` line on stdout, emits `ready` / `exit`
- `apps/desktop/src/main/lib/vscode/vscode-server.test.ts`
- `apps/desktop/src/main/lib/vscode/vscode-manager.ts` — per-paneId coordinator tying server + `WebContentsView` together. Public API: `start`, `setBounds`, `setVisible`, `stop`, `stopAll`, `isCodeCliAvailable`.
- `apps/desktop/src/main/lib/vscode/vscode-manager.test.ts`
- `apps/desktop/src/main/lib/vscode/index.ts` — barrel

**New files (tRPC)**
- `apps/desktop/src/lib/trpc/routers/vscode.ts` — `isAvailable`, `start`, `setBounds`, `setVisible`, `stop`, `onStatus` subscription

**New files (renderer)**
- `apps/desktop/src/renderer/stores/tabs/utils/vscode-cleanup.ts` — `killVscodeForPane(paneId)` companion to `killTerminalForPane`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/VscodePane.tsx`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/hooks/useEmbeddedVscode/useEmbeddedVscode.ts`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/hooks/useEmbeddedVscode/index.ts`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/components/VscodeMissingCli/VscodeMissingCli.tsx`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/components/VscodeMissingCli/index.ts`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/index.ts`

**Modified files**
- `apps/desktop/src/shared/tabs-types.ts` — add `"vscode"` to `PaneType`, add `VscodePaneState`, add `vscode?: VscodePaneState` on `Pane`
- `apps/desktop/src/lib/trpc/routers/index.ts` — register `createVscodeRouter`
- `apps/desktop/src/renderer/stores/tabs/utils.ts` — add `createVscodePane`, `createVscodeTabWithPane`
- `apps/desktop/src/renderer/stores/tabs/types.ts` — add `addVscodeTab` to `TabsStore`
- `apps/desktop/src/renderer/stores/tabs/store.ts` — wire `addVscodeTab`, import + call `killVscodeForPane` in `removePane` and `removeTab`, add `"vscode"` to imports
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/index.tsx` — route `paneInfo.type === "vscode"` to `VscodePane`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/GroupStrip/components/AddTabButton/AddTabButton.tsx` — `onAddVscode` prop + menu item
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/GroupStrip/GroupStrip.tsx` — `handleAddVscode` + pass prop
- `apps/desktop/src/main/windows/main.ts` — call `vscodeManager.stopAll()` on `window.on("close")`
- `apps/desktop/src/main/index.ts` — call `vscodeManager.stopAll()` on `app.on("before-quit")`

---

### Task 1: Extend shared pane types with `"vscode"`

**Files:**
- Modify: `apps/desktop/src/shared/tabs-types.ts:11-16,128-150`

- [ ] **Step 1.1: Add `"vscode"` to `PaneType` union**

Edit `apps/desktop/src/shared/tabs-types.ts` at the `PaneType` declaration. Old:

```ts
export type PaneType =
	| "terminal"
	| "webview"
	| "file-viewer"
	| "chat"
	| "devtools";
```

New:

```ts
export type PaneType =
	| "terminal"
	| "webview"
	| "file-viewer"
	| "chat"
	| "devtools"
	| "vscode";
```

- [ ] **Step 1.2: Add `VscodePaneState` interface**

Still in `apps/desktop/src/shared/tabs-types.ts`, append after the existing `DevToolsPaneState` block:

```ts
/**
 * VS Code pane-specific properties
 * The server and WebContentsView live in the main process keyed by paneId —
 * this state only captures what's needed to re-render after reload.
 */
export interface VscodePaneState {
	/** Absolute worktree path this pane was opened against */
	worktreePath: string;
}
```

- [ ] **Step 1.3: Add `vscode?: VscodePaneState` to `Pane`**

Inside the `Pane` interface, add after the `devtools?: DevToolsPaneState;` line:

```ts
	vscode?: VscodePaneState; // For vscode panes
```

- [ ] **Step 1.4: Run typecheck from worktree root**

Run: `bun run typecheck`
Expected: PASS (or pre-existing failures only — no new errors referencing `tabs-types.ts`).

- [ ] **Step 1.5: Commit**

```bash
git add apps/desktop/src/shared/tabs-types.ts
git commit -m "feat(desktop): add vscode pane type and state"
```

---

### Task 2: Free-port discovery utility

**Files:**
- Create: `apps/desktop/src/main/lib/vscode/find-free-port.ts`
- Test: `apps/desktop/src/main/lib/vscode/find-free-port.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `apps/desktop/src/main/lib/vscode/find-free-port.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { findFreePort } from "./find-free-port";

describe("findFreePort", () => {
	it("returns a port in the ephemeral range bound to 127.0.0.1", async () => {
		const port = await findFreePort();
		expect(port).toBeGreaterThan(1023);
		expect(port).toBeLessThanOrEqual(65535);
	});

	it("returns a port that a server can immediately bind to", async () => {
		const port = await findFreePort();
		await new Promise<void>((resolve, reject) => {
			const server = createServer();
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
		});
	});
});
```

- [ ] **Step 2.2: Run it to verify it fails**

Run: `cd apps/desktop && bun test src/main/lib/vscode/find-free-port.test.ts`
Expected: FAIL — `find-free-port` module does not exist.

- [ ] **Step 2.3: Implement the helper**

Create `apps/desktop/src/main/lib/vscode/find-free-port.ts`:

```ts
import { createServer } from "node:net";

/**
 * Asks the OS for a free ephemeral TCP port on 127.0.0.1.
 * There's always a small race between close() and re-bind, but for a
 * single local consumer on loopback this is acceptable.
 */
export async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr && typeof addr === "object") {
				const { port } = addr;
				server.close((err) => (err ? reject(err) : resolve(port)));
			} else {
				server.close(() => reject(new Error("Could not resolve port")));
			}
		});
	});
}
```

- [ ] **Step 2.4: Run the test to verify it passes**

Run: `cd apps/desktop && bun test src/main/lib/vscode/find-free-port.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 2.5: Commit**

```bash
git add apps/desktop/src/main/lib/vscode/find-free-port.ts apps/desktop/src/main/lib/vscode/find-free-port.test.ts
git commit -m "feat(desktop): add find-free-port helper for vscode server"
```

---

### Task 3: `code` CLI availability check

**Files:**
- Create: `apps/desktop/src/main/lib/vscode/check-code-cli.ts`
- Test: `apps/desktop/src/main/lib/vscode/check-code-cli.test.ts`

- [ ] **Step 3.1: Write the failing test**

Create `apps/desktop/src/main/lib/vscode/check-code-cli.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { isCodeCliAvailable } from "./check-code-cli";

describe("isCodeCliAvailable", () => {
	it("returns false when PATH contains no resolvable 'code' binary", async () => {
		const result = await isCodeCliAvailable({ PATH: "/nonexistent/dir" });
		expect(result).toBe(false);
	});

	it("returns true when given a PATH that contains a 'code' executable", async () => {
		// Create a temp dir with an executable named "code"
		const fs = await import("node:fs/promises");
		const os = await import("node:os");
		const path = await import("node:path");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-cli-"));
		const bin = path.join(dir, process.platform === "win32" ? "code.cmd" : "code");
		await fs.writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		try {
			const result = await isCodeCliAvailable({ PATH: dir });
			expect(result).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 3.2: Run it to verify it fails**

Run: `cd apps/desktop && bun test src/main/lib/vscode/check-code-cli.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3.3: Implement the helper**

Create `apps/desktop/src/main/lib/vscode/check-code-cli.ts`:

```ts
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { getProcessEnvWithShellPath } from "../../../lib/trpc/routers/workspaces/utils/shell-env";

const BINARY_NAMES =
	process.platform === "win32" ? ["code.cmd", "code.exe"] : ["code"];

/**
 * Returns true if the `code` binary is resolvable on PATH.
 * Accepts an optional env override so tests can pin a PATH deterministically.
 */
export async function isCodeCliAvailable(
	envOverride?: NodeJS.ProcessEnv,
): Promise<boolean> {
	const env = envOverride ?? (await getProcessEnvWithShellPath());
	const rawPath = env.PATH ?? env.Path ?? "";
	if (!rawPath) return false;

	const sep = process.platform === "win32" ? ";" : ":";
	for (const dir of rawPath.split(sep)) {
		if (!dir) continue;
		for (const name of BINARY_NAMES) {
			try {
				await access(path.join(dir, name), constants.X_OK);
				return true;
			} catch {
				// try next candidate
			}
		}
	}
	return false;
}
```

- [ ] **Step 3.4: Run the test to verify it passes**

Run: `cd apps/desktop && bun test src/main/lib/vscode/check-code-cli.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3.5: Commit**

```bash
git add apps/desktop/src/main/lib/vscode/check-code-cli.ts apps/desktop/src/main/lib/vscode/check-code-cli.test.ts
git commit -m "feat(desktop): add code CLI availability check"
```

---

### Task 4: VS Code server spawner

Manages one `code serve-web` child process. Spawns the process, scans stdout for the ready line, emits `ready` with `{ url }` or `exit` with a reason.

**Files:**
- Create: `apps/desktop/src/main/lib/vscode/vscode-server.ts`
- Test: `apps/desktop/src/main/lib/vscode/vscode-server.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `apps/desktop/src/main/lib/vscode/vscode-server.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { VscodeServer } from "./vscode-server";

async function writeFakeCode(
	dir: string,
	script: string,
): Promise<{ command: string; env: NodeJS.ProcessEnv }> {
	const bin = path.join(dir, "code");
	await fs.writeFile(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	return { command: bin, env: { PATH: dir } };
}

describe("VscodeServer", () => {
	it("emits 'ready' when stdout advertises a localhost URL", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-server-"));
		try {
			const { command, env } = await writeFakeCode(
				tmp,
				`printf 'Web UI available at http://127.0.0.1:12345/?tkn=abc\\n'; sleep 30`,
			);
			const server = new VscodeServer({
				command,
				worktreePath: tmp,
				port: 12345,
				env,
			});
			const url = await new Promise<string>((resolve, reject) => {
				server.once("ready", (info: { url: string }) => resolve(info.url));
				server.once("exit", () => reject(new Error("exited before ready")));
				void server.start();
			});
			expect(url).toBe("http://127.0.0.1:12345/?tkn=abc");
			server.stop();
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("emits 'exit' if the child quits before becoming ready", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-server-"));
		try {
			const { command, env } = await writeFakeCode(tmp, `exit 2`);
			const server = new VscodeServer({
				command,
				worktreePath: tmp,
				port: 12346,
				env,
			});
			const reason = await new Promise<{ code: number | null }>((resolve) => {
				server.once("exit", (info: { code: number | null }) => resolve(info));
				void server.start();
			});
			expect(reason.code).toBe(2);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 4.2: Run it to verify it fails**

Run: `cd apps/desktop && bun test src/main/lib/vscode/vscode-server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4.3: Implement `VscodeServer`**

Create `apps/desktop/src/main/lib/vscode/vscode-server.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface VscodeServerOptions {
	/** Path or name of the `code` binary. Pass "code" in production. */
	command: string;
	worktreePath: string;
	port: number;
	env?: NodeJS.ProcessEnv;
}

export interface VscodeServerReadyEvent {
	url: string;
}

export interface VscodeServerExitEvent {
	code: number | null;
	signal: NodeJS.Signals | null;
	reason: "exited" | "killed";
}

const READY_REGEX = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?[^\s]*/i;

/**
 * Wraps a `code serve-web` child process. Emits:
 *  - "ready"    { url }               once stdout surfaces a localhost URL
 *  - "exit"     { code, signal, reason } when the process dies
 *  - "stderr"   string                raw stderr chunks (for diagnostics)
 */
export class VscodeServer extends EventEmitter {
	private child: ChildProcess | null = null;
	private readyResolved = false;

	constructor(private readonly options: VscodeServerOptions) {
		super();
	}

	async start(): Promise<void> {
		if (this.child) return;
		const { command, worktreePath, port, env } = this.options;
		const args = [
			"serve-web",
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--without-connection-token",
			"--accept-server-license-terms",
			worktreePath,
		];
		this.child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: env ?? process.env,
			detached: false,
		});

		this.child.stdout?.on("data", (buf: Buffer) => {
			const text = buf.toString();
			if (!this.readyResolved) {
				const match = text.match(READY_REGEX);
				if (match) {
					this.readyResolved = true;
					this.emit("ready", { url: match[0] } satisfies VscodeServerReadyEvent);
				}
			}
		});

		this.child.stderr?.on("data", (buf: Buffer) => {
			this.emit("stderr", buf.toString());
		});

		this.child.once("exit", (code, signal) => {
			const event: VscodeServerExitEvent = {
				code,
				signal,
				reason: signal ? "killed" : "exited",
			};
			this.child = null;
			this.emit("exit", event);
		});
	}

	/** SIGTERM then force-kill after 500ms if the child is still alive. */
	stop(): void {
		const child = this.child;
		if (!child) return;
		try {
			child.kill("SIGTERM");
		} catch {
			// process may already be gone
		}
		const pid = child.pid;
		setTimeout(() => {
			if (pid && this.child) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already exited
				}
			}
		}, 500).unref();
	}
}
```

- [ ] **Step 4.4: Run the test to verify it passes**

Run: `cd apps/desktop && bun test src/main/lib/vscode/vscode-server.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4.5: Commit**

```bash
git add apps/desktop/src/main/lib/vscode/vscode-server.ts apps/desktop/src/main/lib/vscode/vscode-server.test.ts
git commit -m "feat(desktop): add VscodeServer process wrapper"
```

---

### Task 5: WebContentsView + server coordinator (`vscodeManager`)

Owns one `{ server, view }` pair per `paneId`, wires lifecycle (start → hidden view → ready → show at bounds), and exposes the public API consumed by the tRPC router.

**Files:**
- Create: `apps/desktop/src/main/lib/vscode/vscode-manager.ts`
- Create: `apps/desktop/src/main/lib/vscode/index.ts`
- Test: `apps/desktop/src/main/lib/vscode/vscode-manager.test.ts`

- [ ] **Step 5.1: Write the failing test** (lightweight unit test with injectable factories — we don't boot real Electron)

Create `apps/desktop/src/main/lib/vscode/vscode-manager.test.ts`:

```ts
import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { VscodeManager, type VscodeManagerDeps } from "./vscode-manager";

class FakeServer extends EventEmitter {
	started = false;
	stopped = false;
	constructor(public readonly port: number) {
		super();
	}
	async start() {
		this.started = true;
		queueMicrotask(() =>
			this.emit("ready", { url: `http://127.0.0.1:${this.port}/` }),
		);
	}
	stop() {
		this.stopped = true;
	}
}

interface FakeView {
	webContents: { loadURL: ReturnType<typeof mock>; close: ReturnType<typeof mock> };
	setBounds: ReturnType<typeof mock>;
	setVisible: ReturnType<typeof mock>;
	destroyed: boolean;
}

function makeFakeView(): FakeView {
	return {
		webContents: { loadURL: mock(() => {}), close: mock(() => {}) },
		setBounds: mock(() => {}),
		setVisible: mock(() => {}),
		destroyed: false,
	};
}

function makeManager(overrides: Partial<VscodeManagerDeps> = {}) {
	const window = {
		contentView: {
			addChildView: mock(() => {}),
			removeChildView: mock(() => {}),
		},
		isDestroyed: () => false,
	};
	const deps: VscodeManagerDeps = {
		getWindow: () => window as never,
		findFreePort: async () => 40000,
		isCodeCliAvailable: async () => true,
		createServer: (port) => new FakeServer(port) as never,
		createView: () => makeFakeView() as never,
		...overrides,
	};
	return { manager: new VscodeManager(deps), window, deps };
}

describe("VscodeManager", () => {
	it("start() spawns a server and attaches a hidden view", async () => {
		const { manager, window } = makeManager();
		const result = await manager.start({
			paneId: "p1",
			worktreePath: "/tmp/repo",
		});
		expect(result.status).toBe("ready");
		expect(window.contentView.addChildView).toHaveBeenCalledTimes(1);
	});

	it("start() is idempotent for the same paneId", async () => {
		const { manager, window } = makeManager();
		await manager.start({ paneId: "p1", worktreePath: "/tmp/repo" });
		await manager.start({ paneId: "p1", worktreePath: "/tmp/repo" });
		expect(window.contentView.addChildView).toHaveBeenCalledTimes(1);
	});

	it("stop() removes the view and kills the server", async () => {
		const { manager, window } = makeManager();
		await manager.start({ paneId: "p1", worktreePath: "/tmp/repo" });
		manager.stop("p1");
		expect(window.contentView.removeChildView).toHaveBeenCalledTimes(1);
	});

	it("start() resolves with status 'cli-missing' when the binary is absent", async () => {
		const { manager } = makeManager({ isCodeCliAvailable: async () => false });
		const result = await manager.start({
			paneId: "p1",
			worktreePath: "/tmp/repo",
		});
		expect(result.status).toBe("cli-missing");
	});
});
```

- [ ] **Step 5.2: Run it to verify it fails**

Run: `cd apps/desktop && bun test src/main/lib/vscode/vscode-manager.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 5.3: Implement `VscodeManager`**

Create `apps/desktop/src/main/lib/vscode/vscode-manager.ts`:

```ts
import { EventEmitter } from "node:events";
import { type BrowserWindow, WebContentsView } from "electron";
import { getProcessEnvWithShellPath } from "../../../lib/trpc/routers/workspaces/utils/shell-env";
import { isCodeCliAvailable as defaultIsCodeCliAvailable } from "./check-code-cli";
import { findFreePort as defaultFindFreePort } from "./find-free-port";
import { VscodeServer } from "./vscode-server";

export type VscodeStartStatus = "ready" | "cli-missing" | "failed";

export interface VscodeStartResult {
	status: VscodeStartStatus;
	port?: number;
	error?: string;
}

export interface VscodeBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface VscodeStatusEvent {
	paneId: string;
	status: "starting" | "ready" | "exited" | "error";
	error?: string;
}

export interface VscodeManagerDeps {
	getWindow: () => BrowserWindow | null;
	findFreePort?: () => Promise<number>;
	isCodeCliAvailable?: () => Promise<boolean>;
	createServer?: (port: number, worktreePath: string) => VscodeServer;
	createView?: () => WebContentsView;
}

interface Entry {
	server: VscodeServer;
	view: WebContentsView;
	port: number;
	ready: boolean;
}

/**
 * One coordinator for the whole app. Keyed by paneId.
 * Not exported as a singleton — `main/windows/main.ts` instantiates it with `getWindow`.
 */
export class VscodeManager extends EventEmitter {
	private readonly entries = new Map<string, Entry>();
	private readonly pending = new Map<string, Promise<VscodeStartResult>>();

	constructor(private readonly deps: VscodeManagerDeps) {
		super();
	}

	async start(args: {
		paneId: string;
		worktreePath: string;
	}): Promise<VscodeStartResult> {
		const { paneId, worktreePath } = args;
		const existing = this.entries.get(paneId);
		if (existing) {
			return { status: "ready", port: existing.port };
		}
		const inflight = this.pending.get(paneId);
		if (inflight) return inflight;

		const promise = this.doStart(paneId, worktreePath);
		this.pending.set(paneId, promise);
		try {
			return await promise;
		} finally {
			this.pending.delete(paneId);
		}
	}

	private async doStart(
		paneId: string,
		worktreePath: string,
	): Promise<VscodeStartResult> {
		const isAvailable = this.deps.isCodeCliAvailable ?? defaultIsCodeCliAvailable;
		if (!(await isAvailable())) {
			this.emitStatus({ paneId, status: "error", error: "cli-missing" });
			return { status: "cli-missing" };
		}

		const window = this.deps.getWindow();
		if (!window || window.isDestroyed()) {
			return { status: "failed", error: "no-window" };
		}

		const findPort = this.deps.findFreePort ?? defaultFindFreePort;
		const port = await findPort();

		const server =
			this.deps.createServer?.(port, worktreePath) ??
			new VscodeServer({
				command: "code",
				worktreePath,
				port,
				env: await getProcessEnvWithShellPath(),
			});

		const view =
			this.deps.createView?.() ??
			new WebContentsView({
				webPreferences: { backgroundThrottling: false },
			});
		view.setVisible(false);
		view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
		window.contentView.addChildView(view);

		const entry: Entry = { server, view, port, ready: false };
		this.entries.set(paneId, entry);
		this.emitStatus({ paneId, status: "starting" });

		const result = await new Promise<VscodeStartResult>((resolve) => {
			const onReady = (info: { url: string }) => {
				entry.ready = true;
				view.webContents.loadURL(info.url);
				this.emitStatus({ paneId, status: "ready" });
				resolve({ status: "ready", port });
			};
			const onExit = (info: {
				code: number | null;
				signal: NodeJS.Signals | null;
			}) => {
				server.off("ready", onReady);
				this.cleanup(paneId);
				this.emitStatus({
					paneId,
					status: "exited",
					error: `exited (code=${info.code ?? "null"})`,
				});
				if (!entry.ready) {
					resolve({
						status: "failed",
						error: `child exited before ready (code=${info.code ?? "null"})`,
					});
				}
			};
			server.once("ready", onReady);
			server.once("exit", onExit);
			void server.start();
		});

		return result;
	}

	setBounds(paneId: string, bounds: VscodeBounds): void {
		const entry = this.entries.get(paneId);
		if (!entry) return;
		entry.view.setBounds({
			x: Math.round(bounds.x),
			y: Math.round(bounds.y),
			width: Math.max(0, Math.round(bounds.width)),
			height: Math.max(0, Math.round(bounds.height)),
		});
	}

	setVisible(paneId: string, visible: boolean): void {
		const entry = this.entries.get(paneId);
		if (!entry) return;
		entry.view.setVisible(visible);
	}

	stop(paneId: string): void {
		this.cleanup(paneId);
	}

	stopAll(): void {
		for (const paneId of [...this.entries.keys()]) {
			this.cleanup(paneId);
		}
	}

	has(paneId: string): boolean {
		return this.entries.has(paneId);
	}

	private cleanup(paneId: string): void {
		const entry = this.entries.get(paneId);
		if (!entry) return;
		this.entries.delete(paneId);
		const window = this.deps.getWindow();
		try {
			if (window && !window.isDestroyed()) {
				window.contentView.removeChildView(entry.view);
			}
		} catch {
			// view may already be detached
		}
		try {
			entry.view.webContents.close();
		} catch {
			// webContents may already be destroyed
		}
		try {
			entry.server.stop();
		} catch {
			// process may already be gone
		}
	}

	private emitStatus(event: VscodeStatusEvent): void {
		this.emit("status", event);
		this.emit(`status:${event.paneId}`, event);
	}
}
```

- [ ] **Step 5.4: Create the barrel**

Create `apps/desktop/src/main/lib/vscode/index.ts`:

```ts
export { isCodeCliAvailable } from "./check-code-cli";
export { findFreePort } from "./find-free-port";
export {
	VscodeManager,
	type VscodeBounds,
	type VscodeStartResult,
	type VscodeStartStatus,
	type VscodeStatusEvent,
} from "./vscode-manager";
export { VscodeServer } from "./vscode-server";
```

- [ ] **Step 5.5: Run the test to verify it passes**

Run: `cd apps/desktop && bun test src/main/lib/vscode/vscode-manager.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5.6: Commit**

```bash
git add apps/desktop/src/main/lib/vscode/vscode-manager.ts apps/desktop/src/main/lib/vscode/vscode-manager.test.ts apps/desktop/src/main/lib/vscode/index.ts
git commit -m "feat(desktop): add vscode manager coordinating server + view"
```

---

### Task 6: tRPC router for vscode

Exposes `isAvailable`, `start`, `setBounds`, `setVisible`, `stop`, and an `onStatus` subscription. Router is parameterised on `VscodeManager` so tests / alternate windows can inject a different instance.

**Files:**
- Create: `apps/desktop/src/lib/trpc/routers/vscode.ts`

- [ ] **Step 6.1: Write the router**

Create `apps/desktop/src/lib/trpc/routers/vscode.ts`:

```ts
import { observable } from "@trpc/server/observable";
import type {
	VscodeManager,
	VscodeStatusEvent,
} from "main/lib/vscode";
import { z } from "zod";
import { publicProcedure, router } from "..";

const BoundsInput = z.object({
	paneId: z.string().min(1),
	x: z.number(),
	y: z.number(),
	width: z.number().min(0),
	height: z.number().min(0),
});

export const createVscodeRouter = (vscodeManager: VscodeManager) => {
	return router({
		isAvailable: publicProcedure.query(async () => {
			const { isCodeCliAvailable } = await import("main/lib/vscode");
			return { available: await isCodeCliAvailable() };
		}),

		start: publicProcedure
			.input(
				z.object({
					paneId: z.string().min(1),
					worktreePath: z.string().min(1),
				}),
			)
			.mutation(async ({ input }) => {
				return vscodeManager.start(input);
			}),

		setBounds: publicProcedure.input(BoundsInput).mutation(({ input }) => {
			const { paneId, ...bounds } = input;
			vscodeManager.setBounds(paneId, bounds);
			return { success: true };
		}),

		setVisible: publicProcedure
			.input(z.object({ paneId: z.string().min(1), visible: z.boolean() }))
			.mutation(({ input }) => {
				vscodeManager.setVisible(input.paneId, input.visible);
				return { success: true };
			}),

		stop: publicProcedure
			.input(z.object({ paneId: z.string().min(1) }))
			.mutation(({ input }) => {
				vscodeManager.stop(input.paneId);
				return { success: true };
			}),

		onStatus: publicProcedure
			.input(z.object({ paneId: z.string().min(1) }))
			.subscription(({ input }) => {
				return observable<VscodeStatusEvent>((emit) => {
					const handler = (event: VscodeStatusEvent) => emit.next(event);
					vscodeManager.on(`status:${input.paneId}`, handler);
					return () => {
						vscodeManager.off(`status:${input.paneId}`, handler);
					};
				});
			}),
	});
};
```

- [ ] **Step 6.2: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no new errors pointing at the new router).

- [ ] **Step 6.3: Commit**

```bash
git add apps/desktop/src/lib/trpc/routers/vscode.ts
git commit -m "feat(desktop): add vscode tRPC router"
```

---

### Task 7: Register the vscode router + wire `VscodeManager` into the window

**Files:**
- Modify: `apps/desktop/src/lib/trpc/routers/index.ts:1-62`
- Modify: `apps/desktop/src/main/windows/main.ts:36-145,300-325`

- [ ] **Step 7.1: Change `createAppRouter` signature to accept `VscodeManager`**

Edit `apps/desktop/src/lib/trpc/routers/index.ts`. Replace:

```ts
import type { BrowserWindow } from "electron";
import { router } from "..";
import { createAnalyticsRouter } from "./analytics";
```

with:

```ts
import type { BrowserWindow } from "electron";
import type { VscodeManager } from "main/lib/vscode";
import { router } from "..";
import { createAnalyticsRouter } from "./analytics";
```

Add import near the other router imports (keep alphabetical placement):

```ts
import { createVscodeRouter } from "./vscode";
```

Replace the `createAppRouter` signature + body:

```ts
export const createAppRouter = (
	getWindow: () => BrowserWindow | null,
	vscodeManager: VscodeManager,
) => {
	return router({
		// ...existing routers unchanged...
		vscode: createVscodeRouter(vscodeManager),
	});
};
```

Insert the `vscode: createVscodeRouter(vscodeManager),` entry right after the last existing router (`hostServiceCoordinator: ...`).

- [ ] **Step 7.2: Instantiate `VscodeManager` in the main window**

Edit `apps/desktop/src/main/windows/main.ts`. Add import at the top with the other `../lib` imports:

```ts
import { VscodeManager } from "../lib/vscode";
```

Inside `MainWindow()`, immediately after `currentWindow = window;`, add:

```ts
const vscodeManager = new VscodeManager({ getWindow });
```

Replace the `createIPCHandler` call so the router gets the manager:

Old:

```ts
ipcHandler = createIPCHandler({
	router: createAppRouter(getWindow),
	windows: [window],
});
```

New:

```ts
ipcHandler = createIPCHandler({
	router: createAppRouter(getWindow, vscodeManager),
	windows: [window],
});
```

- [ ] **Step 7.3: Tear down all vscode panes on window close**

In `apps/desktop/src/main/windows/main.ts`, inside the existing `window.on("close", () => { ... })` handler, add **before** `browserManager.unregisterAll();`:

```ts
vscodeManager.stopAll();
```

- [ ] **Step 7.4: Tear down on app quit**

Edit `apps/desktop/src/main/index.ts`. At the top, add near existing `import` blocks:

```ts
import type { VscodeManager } from "./lib/vscode";
```

Add a module-level reference that the window can register:

```ts
let activeVscodeManager: VscodeManager | null = null;
export function registerVscodeManager(manager: VscodeManager | null): void {
	activeVscodeManager = manager;
}
```

Place these near the top of `index.ts`, below the existing `focusMainWindow` export.

Back in `apps/desktop/src/main/windows/main.ts`, import the registrar:

```ts
import { registerVscodeManager } from "../index";
```

…and call it right after instantiating the manager:

```ts
registerVscodeManager(vscodeManager);
```

…and nullify it in the `window.on("close", ...)` handler alongside the `stopAll()` call:

```ts
vscodeManager.stopAll();
registerVscodeManager(null);
```

Finally, in `apps/desktop/src/main/index.ts`, in whichever `app.on("before-quit", ...)` or `app.on("will-quit", ...)` handler already exists (or add a new one at the bottom before `void app.whenReady()...`):

```ts
app.on("before-quit", () => {
	activeVscodeManager?.stopAll();
});
```

- [ ] **Step 7.5: Typecheck + build dev main bundle**

Run: `bun run typecheck`
Expected: PASS — no new errors referencing the router / manager.

- [ ] **Step 7.6: Commit**

```bash
git add apps/desktop/src/lib/trpc/routers/index.ts apps/desktop/src/main/windows/main.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): register vscode router and wire window/app cleanup"
```

---

### Task 8: Renderer store cleanup helper

Mirrors `killTerminalForPane` — called from `removePane` / `removeTab` when the pane being deleted is a `"vscode"` pane.

**Files:**
- Create: `apps/desktop/src/renderer/stores/tabs/utils/vscode-cleanup.ts`

- [ ] **Step 8.1: Write the helper**

Create `apps/desktop/src/renderer/stores/tabs/utils/vscode-cleanup.ts`:

```ts
import { electronTrpcClient } from "../../../lib/trpc-client";

/**
 * Tears down the main-process `code serve-web` process and WebContentsView
 * associated with a vscode pane. Uses the standalone tRPC client so we don't
 * depend on React context — `removePane`/`removeTab` run outside components.
 */
export const killVscodeForPane = (paneId: string): void => {
	electronTrpcClient.vscode.stop.mutate({ paneId }).catch((error) => {
		console.warn(`Failed to stop vscode server for pane ${paneId}:`, error);
	});
};
```

- [ ] **Step 8.2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 8.3: Commit**

```bash
git add apps/desktop/src/renderer/stores/tabs/utils/vscode-cleanup.ts
git commit -m "feat(desktop): add killVscodeForPane cleanup helper"
```

---

### Task 9: Renderer store — pane/tab factories and `addVscodeTab`

**Files:**
- Modify: `apps/desktop/src/renderer/stores/tabs/utils.ts:245-360`
- Modify: `apps/desktop/src/renderer/stores/tabs/types.ts:200-245`
- Modify: `apps/desktop/src/renderer/stores/tabs/store.ts:33-54,350-410,1039-1109,1600-1650`

- [ ] **Step 9.1: Add `createVscodePane` and `createVscodeTabWithPane`**

In `apps/desktop/src/renderer/stores/tabs/utils.ts`, append after the `createDevToolsPane` block (around line 315):

```ts
/**
 * Options for creating a vscode pane
 */
export interface CreateVscodePaneOptions {
	worktreePath: string;
}

/**
 * Creates a new vscode pane. The main process owns the server + WebContentsView;
 * the pane state only records the worktree path for re-render.
 */
export const createVscodePane = (
	tabId: string,
	options: CreateVscodePaneOptions,
): Pane => {
	const id = generateId("pane");
	return {
		id,
		tabId,
		type: "vscode",
		name: "VS Code",
		vscode: { worktreePath: options.worktreePath },
	};
};

/**
 * Creates a new tab with a vscode pane atomically.
 */
export const createVscodeTabWithPane = (
	workspaceId: string,
	existingTabs: Tab[],
	worktreePath: string,
): { tab: Tab; pane: Pane } => {
	const tabId = generateId("tab");
	const pane = createVscodePane(tabId, { worktreePath });

	const workspaceTabs = existingTabs.filter(
		(t) => t.workspaceId === workspaceId,
	);
	const tab: Tab = {
		id: tabId,
		name: `VS Code ${workspaceTabs.filter((t) => t.name.startsWith("VS Code")).length + 1}`,
		workspaceId,
		layout: pane.id,
		createdAt: Date.now(),
	};
	return { tab, pane };
};
```

- [ ] **Step 9.2: Add `addVscodeTab` to the `TabsStore` type**

In `apps/desktop/src/renderer/stores/tabs/types.ts`, inside the `TabsStore` interface near the other `add*Tab` signatures (right after the `addBrowserTab` declaration — around line 204), add:

```ts
	addVscodeTab: (
		workspaceId: string,
		worktreePath: string,
	) => { tabId: string; paneId: string };
```

- [ ] **Step 9.3: Import new utils + cleanup helper in the store**

Edit `apps/desktop/src/renderer/stores/tabs/store.ts`. In the big utils import block at the top (line 28-53), add:

```ts
	createVscodePane,
	createVscodeTabWithPane,
```

to the `from "./utils"` import list (keep alphabetical placement — goes between `createTabWithPane` and `equalizeSplitPercentages`).

Add a new import below `killTerminalForPane`:

```ts
import { killVscodeForPane } from "./utils/vscode-cleanup";
```

- [ ] **Step 9.4: Fire `killVscodeForPane` in `removePane` and `removeTab`**

In `apps/desktop/src/renderer/stores/tabs/store.ts`:

In `removeTab` (existing block around lines 376-384), replace the cleanup loop:

Old:

```ts
for (const paneId of paneIds) {
	// Only kill terminal sessions for terminal panes (avoids unnecessary IPC for file-viewers)
	const pane = state.panes[paneId];
	if (pane?.type === "terminal") {
		killTerminalForPane(paneId);
	}

	cleanupEditorPaneState(paneId);
}
```

New:

```ts
for (const paneId of paneIds) {
	const pane = state.panes[paneId];
	if (pane?.type === "terminal") {
		killTerminalForPane(paneId);
	}
	if (pane?.type === "vscode") {
		killVscodeForPane(paneId);
	}

	cleanupEditorPaneState(paneId);
}
```

In `removePane` (around lines 1068-1074), replace:

Old:

```ts
for (const id of paneIdsToRemove) {
	if (state.panes[id]?.type === "terminal") {
		killTerminalForPane(id);
	}

	cleanupEditorPaneState(id);
}
```

New:

```ts
for (const id of paneIdsToRemove) {
	const p = state.panes[id];
	if (p?.type === "terminal") {
		killTerminalForPane(id);
	}
	if (p?.type === "vscode") {
		killVscodeForPane(id);
	}

	cleanupEditorPaneState(id);
}
```

- [ ] **Step 9.5: Implement `addVscodeTab`**

In `apps/desktop/src/renderer/stores/tabs/store.ts`, immediately after the existing `addBrowserTab` block (after the `return { tabId: tab.id, paneId: pane.id };` at the end of `addBrowserTab`, around line 1647), insert:

```ts
				addVscodeTab: (workspaceId, worktreePath) => {
					const state = get();
					const { tab, pane } = createVscodeTabWithPane(
						workspaceId,
						state.tabs,
						worktreePath,
					);

					const currentActiveId = state.activeTabIds[workspaceId];
					const historyStack = state.tabHistoryStacks[workspaceId] || [];
					const newHistoryStack = currentActiveId
						? [
								currentActiveId,
								...historyStack.filter((id) => id !== currentActiveId),
							]
						: historyStack;

					set({
						tabs: [...state.tabs, tab],
						panes: { ...state.panes, [pane.id]: pane },
						activeTabIds: { ...state.activeTabIds, [workspaceId]: tab.id },
						focusedPaneIds: { ...state.focusedPaneIds, [tab.id]: pane.id },
						tabHistoryStacks: {
							...state.tabHistoryStacks,
							[workspaceId]: newHistoryStack,
						},
					});

					posthog.capture("panel_opened", {
						panel_type: "vscode",
						workspace_id: workspaceId,
						pane_id: pane.id,
					});

					return { tabId: tab.id, paneId: pane.id };
				},
```

- [ ] **Step 9.6: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no new errors referencing the tabs store).

- [ ] **Step 9.7: Commit**

```bash
git add apps/desktop/src/renderer/stores/tabs/utils.ts apps/desktop/src/renderer/stores/tabs/types.ts apps/desktop/src/renderer/stores/tabs/store.ts
git commit -m "feat(desktop): add vscode pane factories and addVscodeTab store action"
```

---

### Task 10: `VscodePane` renderer component

A transparent placeholder + `ResizeObserver` sync loop. Calls `vscode.start` on mount, forwards bounds, shows fallback UI if the CLI is missing, and hides the view on unmount without tearing it down.

**Files:**
- Create: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/VscodePane.tsx`
- Create: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/index.ts`
- Create: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/hooks/useEmbeddedVscode/useEmbeddedVscode.ts`
- Create: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/hooks/useEmbeddedVscode/index.ts`
- Create: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/components/VscodeMissingCli/VscodeMissingCli.tsx`
- Create: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/components/VscodeMissingCli/index.ts`

- [ ] **Step 10.1: Create the useEmbeddedVscode hook**

Create `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/hooks/useEmbeddedVscode/useEmbeddedVscode.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

export type VscodePhase =
	| "idle"
	| "starting"
	| "ready"
	| "cli-missing"
	| "failed";

interface Options {
	paneId: string;
	worktreePath: string;
}

interface Result {
	containerRef: React.RefObject<HTMLDivElement | null>;
	phase: VscodePhase;
	errorMessage: string | null;
}

/**
 * Owns the main-process VS Code embed for one pane:
 * 1. Mount → call `start` (idempotent on the main side).
 * 2. While mounted → observe container bounds, forward to `setBounds`.
 * 3. Unmount → hide the view via `setVisible(false)`. Full tear-down happens
 *    when the pane is removed from the tabs store (see killVscodeForPane).
 */
export function useEmbeddedVscode({ paneId, worktreePath }: Options): Result {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [phase, setPhase] = useState<VscodePhase>("idle");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const startMutation = electronTrpc.vscode.start.useMutation();
	const setBoundsMutation = electronTrpc.vscode.setBounds.useMutation();
	const setVisibleMutation = electronTrpc.vscode.setVisible.useMutation();

	// Start on mount
	useEffect(() => {
		let cancelled = false;
		setPhase("starting");
		setErrorMessage(null);
		startMutation
			.mutateAsync({ paneId, worktreePath })
			.then((result) => {
				if (cancelled) return;
				if (result.status === "ready") {
					setPhase("ready");
				} else if (result.status === "cli-missing") {
					setPhase("cli-missing");
				} else {
					setPhase("failed");
					setErrorMessage(result.error ?? "Failed to start VS Code server");
				}
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setPhase("failed");
				setErrorMessage(
					error instanceof Error ? error.message : String(error),
				);
			});
		return () => {
			cancelled = true;
			// Hide — do not stop. Stop happens on pane removal.
			setVisibleMutation.mutate({ paneId, visible: false });
		};
		// paneId + worktreePath are stable for a pane's lifetime
	}, [paneId, worktreePath]);

	// Observe container bounds → forward to main
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		if (phase !== "ready") return;

		const push = () => {
			const rect = el.getBoundingClientRect();
			setBoundsMutation.mutate({
				paneId,
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
			});
		};
		push();
		setVisibleMutation.mutate({ paneId, visible: true });

		const ro = new ResizeObserver(push);
		ro.observe(el);
		window.addEventListener("resize", push);
		window.addEventListener("scroll", push, true);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", push);
			window.removeEventListener("scroll", push, true);
		};
	}, [paneId, phase]);

	return { containerRef, phase, errorMessage };
}
```

- [ ] **Step 10.2: Create the hook barrel**

Create `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/hooks/useEmbeddedVscode/index.ts`:

```ts
export { useEmbeddedVscode } from "./useEmbeddedVscode";
export type { VscodePhase } from "./useEmbeddedVscode";
```

- [ ] **Step 10.3: Create the fallback UI component**

Create `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/components/VscodeMissingCli/VscodeMissingCli.tsx`:

```tsx
import { Button } from "@superset/ui/button";
import { shell } from "electron";

const DOCS_URL = "https://code.visualstudio.com/docs/editor/command-line";

export function VscodeMissingCli() {
	return (
		<div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background px-6 text-center">
			<h2 className="text-sm font-medium text-foreground">
				VS Code command line tool not found
			</h2>
			<p className="max-w-md text-xs text-muted-foreground">
				This tab embeds VS Code by running <code>code serve-web</code> locally.
				Install VS Code and make sure the <code>code</code> command is on your
				<code>PATH</code>, then reopen this tab.
			</p>
			<Button
				variant="outline"
				size="sm"
				onClick={() => {
					void shell.openExternal(DOCS_URL);
				}}
			>
				Open install instructions
			</Button>
		</div>
	);
}
```

- [ ] **Step 10.4: Create the fallback barrel**

Create `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/components/VscodeMissingCli/index.ts`:

```ts
export { VscodeMissingCli } from "./VscodeMissingCli";
```

- [ ] **Step 10.5: Create `VscodePane.tsx`**

Create `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/VscodePane.tsx`:

```tsx
import { useCallback } from "react";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { BasePaneWindow, PaneTitle, PaneToolbarActions } from "../components";
import { VscodeMissingCli } from "./components/VscodeMissingCli";
import { useEmbeddedVscode } from "./hooks/useEmbeddedVscode";

interface VscodePaneProps {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	workspaceId: string;
	splitPaneAuto: (
		tabId: string,
		sourcePaneId: string,
		dimensions: { width: number; height: number },
		path?: MosaicBranch[],
	) => void;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
}

export function VscodePane({
	paneId,
	path,
	tabId,
	workspaceId,
	splitPaneAuto,
	removePane,
	setFocusedPane,
}: VscodePaneProps) {
	const pane = useTabsStore((s) => s.panes[paneId]);
	const paneName = pane?.name;
	const setPaneName = useTabsStore((s) => s.setPaneName);

	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId },
		{ enabled: !!workspaceId },
	);
	const worktreePath =
		pane?.vscode?.worktreePath ?? workspace?.worktreePath ?? "";

	const { containerRef, phase, errorMessage } = useEmbeddedVscode({
		paneId,
		worktreePath,
	});

	const handleRename = useCallback(
		(next: string) => setPaneName(paneId, next),
		[paneId, setPaneName],
	);

	return (
		<BasePaneWindow
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center justify-between px-3">
					<PaneTitle
						name={paneName ?? ""}
						fallback="VS Code"
						onRename={handleRename}
					/>
					<PaneToolbarActions
						splitOrientation={handlers.splitOrientation}
						onSplitPane={handlers.onSplitPane}
						onClosePane={handlers.onClosePane}
						closeHotkeyId="CLOSE_TERMINAL"
					/>
				</div>
			)}
		>
			<div className="relative flex-1 h-full w-full">
				{phase === "cli-missing" ? (
					<VscodeMissingCli />
				) : (
					<>
						<div
							ref={containerRef}
							className="h-full w-full"
							style={{ background: "transparent", pointerEvents: "none" }}
						/>
						{phase !== "ready" && (
							<div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
								{phase === "failed"
									? (errorMessage ?? "Failed to start VS Code")
									: "Starting VS Code…"}
							</div>
						)}
					</>
				)}
			</div>
		</BasePaneWindow>
	);
}
```

- [ ] **Step 10.6: Create the pane barrel**

Create `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane/index.ts`:

```ts
export { VscodePane } from "./VscodePane";
```

- [ ] **Step 10.7: Typecheck**

Run: `bun run typecheck`
Expected: PASS — no new errors inside `VscodePane/`.

- [ ] **Step 10.8: Commit**

```bash
git add apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/VscodePane
git commit -m "feat(desktop): add VscodePane component and embedded vscode hook"
```

---

### Task 11: Route `"vscode"` panes to `VscodePane` in `TabView`

**Files:**
- Modify: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/index.tsx:22-28,160-247`

- [ ] **Step 11.1: Add the import**

At the top of `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/index.tsx`, add alongside the other pane imports (around line 22-27):

```ts
import { VscodePane } from "./VscodePane";
```

- [ ] **Step 11.2: Add the routing branch**

Inside `renderPane` (the `useCallback` around lines 161-281), add a new branch after the existing `"webview"` branch (right before the `devtools` branch, around line 232):

```tsx
			if (paneInfo.type === "vscode") {
				return (
					<VscodePane
						paneId={paneId}
						path={path}
						tabId={tab.id}
						workspaceId={tab.workspaceId}
						splitPaneAuto={splitPaneAuto}
						removePane={removePane}
						setFocusedPane={setFocusedPane}
					/>
				);
			}
```

- [ ] **Step 11.3: Typecheck + visually verify**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 11.4: Commit**

```bash
git add apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/index.tsx
git commit -m "feat(desktop): route vscode panes to VscodePane"
```

---

### Task 12: Expose “Open in VS Code (embedded)” in the tab `+` menu

**Files:**
- Modify: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/GroupStrip/components/AddTabButton/AddTabButton.tsx:19-154`
- Modify: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/GroupStrip/GroupStrip.tsx:38-45,225-235,320-335`

- [ ] **Step 12.1: Add the icon + prop in `AddTabButton`**

At the top of `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/GroupStrip/components/AddTabButton/AddTabButton.tsx`, after the existing `react-icons/tb` import, add:

```ts
import { VscVscode } from "react-icons/vsc";
```

(If `react-icons/vsc` is not available in the repo, replace with `import { Code2 } from "lucide-react";` and use `<Code2 className="size-3.5" />` below.)

Update `AddTabButtonProps`:

```ts
interface AddTabButtonProps {
	// ...existing props unchanged...
	onAddVscode: () => void;
}
```

In the function signature destructure, add `onAddVscode`.

Add a new compact-menu `DropdownMenuItem` inside the `{!showBigAddButton && (...)}` block, right after the Browser item:

```tsx
<DropdownMenuItem onClick={onAddVscode} className="gap-2">
	<VscVscode className="size-4" />
	<span>VS Code</span>
</DropdownMenuItem>
```

Inside the `{showBigAddButton && (...)}` block, add a new button between the Browser button and the chevron trigger:

```tsx
<Button
	variant="ghost"
	className="h-7 rounded-none border border-l-0 border-border/60 bg-muted/30 px-1.5 gap-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
	onClick={onAddVscode}
>
	<VscVscode className="size-3.5" />
	VS Code
</Button>
```

- [ ] **Step 12.2: Wire the handler in `GroupStrip`**

Edit `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/GroupStrip/GroupStrip.tsx`.

Near the existing `addBrowserTab` selector (line 41), add:

```ts
	const addVscodeTab = useTabsStore((s) => s.addVscodeTab);
```

Import the tRPC helper for the workspace lookup at the top of the file (alongside the other `electronTrpc` import if present):

```ts
import { electronTrpc } from "renderer/lib/electron-trpc";
```

Inside the component body, after existing workspace context derivation, add:

```ts
	const activeWorkspace = electronTrpc.workspaces.get.useQuery(
		{ id: activeWorkspaceId as string },
		{ enabled: !!activeWorkspaceId },
	);
	const activeWorktreePath = activeWorkspace.data?.worktreePath;
```

Next to `handleAddBrowser` (around line 230), add:

```ts
	const handleAddVscode = () => {
		if (!activeWorkspaceId) return;
		if (!activeWorktreePath) return;
		addVscodeTab(activeWorkspaceId, activeWorktreePath);
	};
```

In the `<AddTabButton ...>` JSX invocation (around line 320), add the new prop:

```tsx
			onAddVscode={handleAddVscode}
```

- [ ] **Step 12.3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 12.4: Run the app in dev and manually verify**

Run (from worktree root, in a separate terminal):

```bash
bun dev
```

Verification checklist (manual):
1. Open a workspace — the tab `+` area shows a new `VS Code` button.
2. Click it — new tab labeled `VS Code 1` is created and becomes active.
3. After a few seconds, VS Code loads inside the tab area (if `code` is installed).
4. Resize the window / toggle the sidebar — the embedded VS Code stays glued to the tab area.
5. Switch tabs — VS Code disappears when its tab is inactive, reappears on return.
6. Close the tab — VS Code goes away; the child process (check with `ps ax | grep 'serve-web'`) is gone.
7. Close the window — any remaining `serve-web` processes are gone.
8. Temporarily remove `code` from PATH and open the tab — fallback UI appears.

- [ ] **Step 12.5: Commit**

```bash
git add apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/GroupStrip/components/AddTabButton/AddTabButton.tsx apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/GroupStrip/GroupStrip.tsx
git commit -m "feat(desktop): add VS Code tab creator to the tab plus menu"
```

---

### Task 13: Full test + lint + format pass

- [ ] **Step 13.1: Run the full test suite**

Run: `cd apps/desktop && bun test`
Expected: PASS — all new tests plus no regressions in existing desktop tests.

- [ ] **Step 13.2: Run lint and format fixers from worktree root**

Run: `bun run lint:fix`
Expected: exits 0.

- [ ] **Step 13.3: Run typecheck from worktree root**

Run: `bun run typecheck`
Expected: exits 0.

- [ ] **Step 13.4: Commit any auto-fix diffs**

```bash
git add -u
git diff --cached --quiet || git commit -m "chore(desktop): lint/format fixes for vscode tab"
```

---

## Self-Review

- **Spec coverage:**
  - Spec §Step 1 (PATH check, port finder, process registry, `start-vscode-server`) → Tasks 2–5.
  - Spec §Step 2 (WebContentsView, `update-vscode-bounds`, `stop-vscode-server`) → Tasks 5–6.
  - Spec §Step 3 (React component with loading / error / ready, ResizeObserver, cleanup) → Task 10.
  - Spec §Step 4 (tab state support for `vscode-ide`, entry point, renderer mapping) → Tasks 1, 9, 11, 12.
  - Spec §Cleanup (kill on tab close + app quit) → Tasks 7 (app/window) + 8–9 (pane/tab).
- **Placeholder scan:** None — all steps include full code, exact file/line targets, exact commands, and expected outcomes.
- **Type consistency:** `addVscodeTab(workspaceId, worktreePath)` matches `createVscodeTabWithPane(workspaceId, existingTabs, worktreePath)` return type `{ tab, pane }`; store action returns `{ tabId, paneId }` matching the shape declared in `types.ts`. `VscodeManager.start` returns `VscodeStartResult` consumed verbatim in the router and mapped in the hook (`status: "ready" | "cli-missing" | "failed"`). `killVscodeForPane(paneId)` fires `vscode.stop` — matches router mutation input. `vscode.setBounds` / `vscode.setVisible` / `vscode.start` input shapes match exactly what the hook posts.
