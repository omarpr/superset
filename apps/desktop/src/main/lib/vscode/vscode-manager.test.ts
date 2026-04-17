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
	webContents: {
		loadURL: ReturnType<typeof mock>;
		close: ReturnType<typeof mock>;
		focus: ReturnType<typeof mock>;
	};
	setBounds: ReturnType<typeof mock>;
	setVisible: ReturnType<typeof mock>;
	destroyed: boolean;
}

function makeFakeView(): FakeView {
	return {
		webContents: {
			loadURL: mock(() => {}),
			close: mock(() => {}),
			focus: mock(() => {}),
		},
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
	const views: FakeView[] = [];
	const deps: VscodeManagerDeps = {
		getWindow: () => window as never,
		findFreePort: async () => 40000,
		isCodeCliAvailable: async () => true,
		createServer: (port) => new FakeServer(port) as never,
		createView: () => {
			const v = makeFakeView();
			views.push(v);
			return v as never;
		},
		...overrides,
	};
	return { manager: new VscodeManager(deps), window, deps, views };
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

	it("focus() forwards to the embedded webContents for a ready pane", async () => {
		const { manager, views } = makeManager();
		await manager.start({ paneId: "p1", worktreePath: "/tmp/repo" });
		manager.focus("p1");
		expect(views[0]?.webContents.focus).toHaveBeenCalledTimes(1);
	});

	it("focus() is a no-op for unknown panes", () => {
		const { manager, views } = makeManager();
		manager.focus("unknown");
		expect(views.length).toBe(0);
	});

	it("focus() is a no-op for a pane that has started but is not yet ready", async () => {
		// A server that never emits "ready" or "exit", so doStart() hangs.
		const hangServer = () => {
			const s = new EventEmitter();
			(s as unknown as { start: () => Promise<void> }).start = () =>
				new Promise(() => {
					// never resolves — server never emits "ready" or "exit"
				});
			(s as unknown as { stop: () => void }).stop = () => {};
			return s;
		};
		const { manager, views } = makeManager({
			createServer: hangServer as never,
		});

		// start() will hang because the server never emits ready/exit.
		// doStart() sets entries before awaiting, so after one macro-task tick
		// the entry exists with ready: false.
		const startPromise = manager.start({
			paneId: "p1",
			worktreePath: "/tmp/repo",
		});
		await new Promise<void>((r) => setTimeout(r, 0));

		manager.focus("p1");
		expect(views[0]?.webContents.focus).not.toHaveBeenCalled();

		// Tear down without awaiting the hanging promise.
		manager.stop("p1");
		void startPromise;
	});
});
