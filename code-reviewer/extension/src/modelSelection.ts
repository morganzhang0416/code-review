// Copilot model selection helpers.
// Portable seam copied so the Reviewer runs standalone.
// Re-sync with: npm run sync-core  —  do not hand-edit.

export interface ModelCatalogSelector {
  readonly vendor: string;
  readonly family?: string;
}

export interface ModelCatalogEntry {
  readonly vendor: string;
  readonly id: string;
  readonly family: string;
  readonly version: string;
}

export type ModelCatalog<Model extends ModelCatalogEntry> = (
  selector: ModelCatalogSelector,
) => readonly Model[] | Promise<readonly Model[]>;

function formatIdentity(model: ModelCatalogEntry): string {
  return [
    `vendor=${JSON.stringify(model.vendor)}`,
    `id=${JSON.stringify(model.id)}`,
    `family=${JSON.stringify(model.family)}`,
    `version=${JSON.stringify(model.version)}`,
  ].join(", ");
}

export async function selectStrictCopilotModel<Model extends ModelCatalogEntry>(
  family: string,
  catalog: ModelCatalog<Model>,
): Promise<Model> {
  const candidates = await catalog({ vendor: "copilot", family });
  const selected = candidates.find(
    (model) => model.vendor === "copilot" && model.family === family,
  );
  if (selected) return selected;

  const available = await catalog({ vendor: "copilot" });
  const identities = available.map(formatIdentity).join("; ") || "(none)";
  throw new Error(
    `Copilot model family ${JSON.stringify(family)} is unavailable. ` +
      `Available models: ${identities}.`,
  );
}
