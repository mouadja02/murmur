export interface ProgressiveInjectorDeps {
  typeFn: (text: string) => Promise<unknown>;
}

/** What reached the target so far, and whether typing stopped on an error. */
export interface ProgressiveInjectResult {
  /** Chunks `typeFn` completed, in order. A chunk whose `typeFn` rejected is not included. */
  typed: string;
  failed: boolean;
  error?: unknown;
}

export interface ProgressiveInjector {
  pushToken(token: string): void;
  /** Resolves once every queued chunk was typed, or typing stopped on its first failure. */
  flush(): Promise<ProgressiveInjectResult>;
  /** Stops typing queued chunks; resolves after the chunk being typed (if any) settles. */
  abort(): Promise<ProgressiveInjectResult>;
}

export function createProgressiveInjector(deps: ProgressiveInjectorDeps): ProgressiveInjector {
  let chain: Promise<void> = Promise.resolve();
  let aborted = false;
  let typed = '';
  let failure: { error: unknown } | null = null;

  function pushToken(token: string): void {
    if (aborted || failure) return;
    // Typing must stop at the first failure: skipping a chunk and carrying on
    // would drop words from the middle of the prompt ("do not touch" → "touch").
    chain = chain.then(async () => {
      if (aborted || failure) return;
      try {
        await deps.typeFn(token);
        typed += token;
      } catch (error) {
        failure = { error };
      }
    });
  }

  function result(): ProgressiveInjectResult {
    return failure ? { typed, failed: true, error: failure.error } : { typed, failed: false };
  }

  async function flush(): Promise<ProgressiveInjectResult> {
    await chain;
    return result();
  }

  function abort(): Promise<ProgressiveInjectResult> {
    aborted = true;
    return flush();
  }

  return { pushToken, flush, abort };
}
