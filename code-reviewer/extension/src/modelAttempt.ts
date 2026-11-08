// Copilot model selection attempt helpers.
// Portable seam copied so the Reviewer runs standalone.
// Re-sync with: npm run sync-core  —  do not hand-edit.

import { ModelCallFailure } from "./modelFailure";

export interface CancellationSource {
  cancel(): void;
  dispose(): void;
}

export interface AbortSignalBridge<Source extends CancellationSource> {
  readonly source: Source;
  dispose(): void;
}

export function bridgeAbortSignal<Source extends CancellationSource>(
  signal: AbortSignal,
  createSource: () => Source,
): AbortSignalBridge<Source> {
  const source = createSource();
  const onAbort = (): void => source.cancel();
  if (signal.aborted) source.cancel();
  else signal.addEventListener("abort", onAbort, { once: true });

  let disposed = false;
  return {
    source,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", onAbort);
      source.dispose();
    },
  };
}

export async function* observeModelAttempt<RawPart, MappedPart>(
  createStream: () => AsyncIterable<RawPart> | Promise<AsyncIterable<RawPart>>,
  mapPart: (
    part: RawPart,
  ) => MappedPart | undefined | Promise<MappedPart | undefined>,
  signal?: AbortSignal,
): AsyncIterable<MappedPart> {
  let providerStreamStarted = false;
  try {
    const stream = await createStream();
    for await (const rawPart of stream) {
      providerStreamStarted = true;
      const mappedPart = await mapPart(rawPart);
      if (mappedPart !== undefined) yield mappedPart;
    }
  } catch (cause) {
    throw new ModelCallFailure(cause, providerStreamStarted, signal);
  }
}
