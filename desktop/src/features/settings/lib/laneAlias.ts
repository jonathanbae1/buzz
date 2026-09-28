/** Follows `@lane` aliases to the concrete model selector; `undefined` for a missing or cyclic chain. */
export function resolveLaneModel(
  model: string,
  lanes: readonly { key: string; model: string }[],
): string | undefined {
  let current = model;
  for (let depth = 0; depth <= lanes.length; depth += 1) {
    if (!current.startsWith("@")) return current;
    const target = lanes.find((lane) => lane.key === current.slice(1));
    if (!target) return undefined;
    current = target.model;
  }
  return undefined;
}
