export type PiExecutableHarnessKind = "pi" | "omp";

/** Executable images recognized as Pi-compatible hosts. */
export const PI_IMAGE_NAMES = new Set(["pi", "pi.cmd", "omp", "oh-my-pi"]);

/** Classify a process title or executable path using the shared Pi image vocabulary. */
export function piHarnessKindFromExecutable(
    value: string | undefined,
): PiExecutableHarnessKind | undefined {
    const executable = (value ?? "")
        .trim()
        .replace(/^['"]|['"]$/g, "")
        .replaceAll("\\", "/")
        .split("/")
        .at(-1)
        ?.toLowerCase()
        .replace(/\.(?:exe|cmd)$/, "");
    if (!executable || !PI_IMAGE_NAMES.has(executable)) return undefined;
    return executable === "pi" ? "pi" : "omp";
}
