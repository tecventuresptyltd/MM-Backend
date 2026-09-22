import * as fs from "fs";
import * as path from "path";

export interface GameDataDocument {
  path: string;
  file: string;
  data: Record<string, unknown>;
}

interface ManifestEntry {
  path: string;
  file: string;
}

interface Manifest {
  version: string;
  documents: ManifestEntry[];
}

export const gameDataRoot = path.join(__dirname, "..", "gamedata");

export function loadGameDataDocuments(): GameDataDocument[] {
  const manifestPath = path.join(gameDataRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Game data manifest not found at ${manifestPath}`);
  }

  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf-8"),
  ) as Manifest;

  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new Error("Game data manifest contains no documents.");
  }

  const seenPaths = new Set<string>();
  const seenFiles = new Set<string>();

  return manifest.documents.map((entry) => {
    if (!entry.path || !entry.file) {
      throw new Error(
        `Manifest entry must declare both "path" and "file": ${JSON.stringify(entry)}`,
      );
    }
    if (seenPaths.has(entry.path)) {
      throw new Error(`Manifest declares ${entry.path} more than once.`);
    }
    if (seenFiles.has(entry.file)) {
      throw new Error(`Manifest uses ${entry.file} more than once.`);
    }
    seenPaths.add(entry.path);
    seenFiles.add(entry.file);

    const absolute = path.join(gameDataRoot, entry.file);
    if (!fs.existsSync(absolute)) {
      throw new Error(`Manifest references a missing file: ${entry.file}`);
    }

    const expectedFolder = entry.path.split("/").slice(-2, -1)[0];
    const actualFolder = entry.file.split("/")[0];
    if (expectedFolder !== actualFolder) {
      throw new Error(
        `${entry.file} lives in "${actualFolder}" but is seeded to "${expectedFolder}".`,
      );
    }

    return {
      path: entry.path,
      file: entry.file,
      data: JSON.parse(fs.readFileSync(absolute, "utf-8")) as Record<
        string,
        unknown
      >,
    };
  });
}
