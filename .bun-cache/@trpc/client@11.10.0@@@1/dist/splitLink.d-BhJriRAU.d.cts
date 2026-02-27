import { Operation, TRPCLink } from "./types.d-Cs0iOdcD.cjs";
import { AnyRouter } from "@trpc/server/unstable-core-do-not-import";

//#region src/links/splitLink.d.ts
declare function splitLink<TRouter extends AnyRouter = AnyRouter>(opts: {
  condition: (op: Operation) => boolean;
  /**
   * The link to execute next if the test function returns `true`.
   */
  true: TRPCLink<TRouter> | TRPCLink<TRouter>[];
  /**
   * The link to execute next if the test function returns `false`.
   */
  false: TRPCLink<TRouter> | TRPCLink<TRouter>[];
}): TRPCLink<TRouter>;
//# sourceMappingURL=splitLink.d.ts.map

//#endregion
export { splitLink };
//# sourceMappingURL=splitLink.d-BhJriRAU.d.cts.map