import type { SandboxConfig } from './config.ts';
import type { SandboxState } from './state.ts';
import type { ViewContext } from './views.ts';

/** Everything a handler needs: settings, the in-memory data, and a timer helper that `reset` can cancel. */
export type Sandbox = {
  config: SandboxConfig;
  state: SandboxState;
  view: ViewContext;
  later: (task: () => void, delayMs: number) => void;
  log: (message: string) => void;
};

export function createLater(state: SandboxState) {
  return (task: () => void, delayMs: number): void => {
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      task();
    }, delayMs);
    state.timers.add(timer);
  };
}
