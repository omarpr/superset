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
