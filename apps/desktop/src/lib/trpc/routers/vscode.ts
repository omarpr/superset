import { observable } from "@trpc/server/observable";
import type {
	VscodeFocusEvent,
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

		focus: publicProcedure
			.input(z.object({ paneId: z.string().min(1) }))
			.mutation(({ input }) => {
				vscodeManager.focus(input.paneId);
				return { success: true };
			}),

		capture: publicProcedure
			.input(z.object({ paneId: z.string().min(1) }))
			.mutation(async ({ input }) => {
				return { dataUrl: await vscodeManager.capture(input.paneId) };
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

		onFocus: publicProcedure.subscription(() => {
			return observable<VscodeFocusEvent>((emit) => {
				const handler = (event: VscodeFocusEvent) => emit.next(event);
				vscodeManager.on("focus", handler);
				return () => {
					vscodeManager.off("focus", handler);
				};
			});
		}),
	});
};
