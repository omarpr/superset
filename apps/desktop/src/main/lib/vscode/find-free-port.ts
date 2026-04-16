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
