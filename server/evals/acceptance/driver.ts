// Maps acceptance steps and expectations onto Sphica's public entry points (capture hooks, CLI, MCP, delivery hooks).
// Each operation is filled in when its feature is built; until then it fails and names the missing operation.
import type { Step, World } from "./load.ts";

export type Driver = {
  run(step: Step): Promise<void>;
  expect(expectation: Step): Promise<void>;
  done(): Promise<void>;
};

class NotBuilt extends Error {}

export async function createDriver(_world: World): Promise<Driver> {
  const missing = (kind: string, s: Step) =>
    new NotBuilt(`${kind} not built yet: ${Object.keys(s).join(", ")}`);
  return {
    run: async (step) => {
      throw missing("operation", step);
    },
    expect: async (expectation) => {
      throw missing("expectation", expectation);
    },
    done: async () => {},
  };
}
