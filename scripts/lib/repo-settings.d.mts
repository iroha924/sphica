type Observed = { status: number | null; body: unknown };
export function settingsState(input: { immutable: Observed; actions: Observed }): {
  name: string;
  state: "on" | "off" | "unknown";
}[];
export function observe(run: (args: string[]) => string, endpoint: string): Observed;
