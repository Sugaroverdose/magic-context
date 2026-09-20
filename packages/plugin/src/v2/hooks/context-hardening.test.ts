import { expect, test } from "bun:test";
import { FailClosedBlockingError } from "../../features/magic-context/fail-closed-block";
import { EmergencyFailClosedError } from "../../hooks/magic-context/emergency-fail-closed";
import { isBlockingV2TransformError } from "./context";

test("recognizes typed shared-transform fail-closed errors", () => {
    expect(isBlockingV2TransformError(new EmergencyFailClosedError("unsafe"))).toBe(true);
    expect(
        isBlockingV2TransformError(
            new FailClosedBlockingError("storage unavailable", {
                kind: "storage_failure",
                cause: "unavailable",
            }),
        ),
    ).toBe(true);
    expect(isBlockingV2TransformError(new Error("ordinary transform failure"))).toBe(false);
});
