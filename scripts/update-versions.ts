/**
 * update-versions.ts
 *
 * Manages the public/versions.json manifest and per-version definition files.
 *
 * What it does:
 *  1. Reads the existing public/versions.json (if present).
 *  2. If --compress-patches <N> is passed, finds patch versions older than N days,
 *     deletes the older patch folders, and renames the highest-numbered patch to
 *     the base date name.
 *  3. For every folder in public/data/, if version_<tag>.json exists, ensures that
 *     version is in the manifest. If not, runs generate-defs for that folder.
 *  4. Writes the updated public/versions.json.
 *
 * Usage:
 *   tsx scripts/update-versions.ts [--compress-patches <N>] [--annotations-only]
 */

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execSync} from "node:child_process";
import type {DefManifest, VersionEntry} from "../src/lib/schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANNOTATIONS = path.resolve(__dirname, "version_annotations.json");

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let compressPatchesDays: number | null = null;
let dataRoot = path.resolve(__dirname, "..", "public");
let annotationsOnly = false;
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--compress-patches" && args[i + 1]) {
        compressPatchesDays = parseInt(args[i + 1], 10);
        i++;
    } else if (args[i] === "--root-dir" && args[i + 1]) {
        dataRoot = path.resolve(args[i + 1]);
        i++;
    } else if (args[i] === "--annotations-only") {
        annotationsOnly = true;
    }
}

const DATA_DIR = path.join(dataRoot, "data");
const VERSIONS_FILE = path.join(dataRoot, "versions.json");
const LATEST_FILE = path.join(dataRoot, "latest.json");

function parseVersionTag(tag: string): {base: string; patch: number} {
    const match = tag.match(/^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/);
    if (!match) return {base: tag, patch: 0};
    return {
        base: match[1],
        patch: parseInt(match[2] ?? "0", 10),
    };
}

function compareVersionTagsDesc(a: string, b: string): number {
    const pa = parseVersionTag(a);
    const pb = parseVersionTag(b);
    if (pa.base !== pb.base) return pb.base.localeCompare(pa.base);
    return pb.patch - pa.patch;
}


// ---------------------------------------------------------------------------
// 1. Read existing versions.json
// ---------------------------------------------------------------------------
let manifest: VersionEntry[] = [];
if (fs.existsSync(VERSIONS_FILE)) {
    try {
        manifest = JSON.parse(fs.readFileSync(VERSIONS_FILE, "utf-8")) as VersionEntry[];
        console.log(`Loaded ${manifest.length} existing version entries from versions.json`);
    } catch (e) {
        console.warn("Could not parse versions.json, starting fresh:", e);
    }
}

const manifestByTag = new Map<string, VersionEntry>(manifest.map((v) => [v.tag, v]));

let annotations: VersionEntry[] = [];
if (fs.existsSync(ANNOTATIONS)) {
    try {
        annotations = JSON.parse(fs.readFileSync(ANNOTATIONS, "utf-8")) as VersionEntry[];
        console.log(`Loaded ${annotations.length} version annotations`);
    } catch (e) {
        console.warn("Could not parse version_annotations.json, ignoring:", e);
    }
}

const annotationsByTag = new Map<string, VersionEntry>(annotations.map((v) => [v.tag, v]));

// ---------------------------------------------------------------------------
// 2. Compress patches (optional)
// ---------------------------------------------------------------------------
if (compressPatchesDays !== null) {
    if (annotationsOnly) {
        console.log("--annotations-only: skipping patch compression.");
    } else {
        console.log(`\nCompressing patch versions older than ${compressPatchesDays} days...`);
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - compressPatchesDays);

        // Group all folders by base date (YYYY-MM-DD)
        const allFolders = fs.readdirSync(DATA_DIR).filter((f) =>
            /^\d{4}-\d{2}-\d{2}(-\d+)?$/.test(f) && fs.statSync(path.join(DATA_DIR, f)).isDirectory()
        );

        const byBase = new Map<string, string[]>();
        for (const folder of allFolders) {
            const baseMatch = folder.match(/^(\d{4}-\d{2}-\d{2})/);
            if (!baseMatch) continue;
            const base = baseMatch[1];
            const existing = byBase.get(base) ?? [];
            existing.push(folder);
            byBase.set(base, existing);
        }

        for (const [base, folders] of byBase) {
            if (folders.length <= 1) continue; // no patches to compress
            const [y, m, d] = base.split("-").map(Number);
            const folderDate = new Date(y, m - 1, d);
            if (folderDate >= cutoffDate) {
                console.log(`  Skipping ${base} (within ${compressPatchesDays}-day window)`);
                continue;
            }

            // Sort: base folder first, then by patch number ascending
            folders.sort((a, b) => {
                const pa = parseInt(a.match(/-(\d+)$/)?.[1] ?? "0", 10);
                const pb = parseInt(b.match(/-(\d+)$/)?.[1] ?? "0", 10);
                return pa - pb;
            });

            const highest = folders[folders.length - 1];
            const toDelete = folders.slice(0, -1); // all except the highest

            console.log(`  Compressing ${base}: keeping ${highest}, deleting ${toDelete.join(", ")}`);

            // Merge label/description: prefer one from any entry that has it
            const highestEntry = manifestByTag.get(highest);
            let mergedLabel = highestEntry?.label;
            let mergedDesc = highestEntry?.description;
            for (const tag of toDelete) {
                const e = manifestByTag.get(tag);
                if (!mergedLabel && e?.label && e.label !== tag) mergedLabel = e.label;
                if (!mergedDesc && e?.description) mergedDesc = e.description;
            }

            // Delete old folders and their manifest entries
            for (const tag of toDelete) {
                const folderPath = path.join(DATA_DIR, tag);
                fs.rmSync(folderPath, {recursive: true, force: true});
                manifestByTag.delete(tag);
                console.log(`    Deleted ${folderPath}`);
            }

            const newLabel = annotationsByTag.get(base)?.label ?? mergedLabel;
            const newDesc = annotationsByTag.get(base)?.description ?? mergedDesc;

            // Rename highest to base date
            if (highest !== base) {
                const oldPath = path.join(DATA_DIR, highest);
                const newPath = path.join(DATA_DIR, base);
                fs.renameSync(oldPath, newPath);
                // Rename the version file inside too
                const oldVersionFile = path.join(newPath, `version_${highest}.json`);
                const newVersionFile = path.join(newPath, `version_${base}.json`);
                if (fs.existsSync(oldVersionFile)) {
                    const vData = JSON.parse(fs.readFileSync(oldVersionFile, "utf-8"));
                    vData.tag = base;
                    vData.label = newLabel;
                    vData.description = newDesc;
                    fs.writeFileSync(newVersionFile, JSON.stringify(vData, null, 2), "utf-8");
                    fs.unlinkSync(oldVersionFile);
                }
                manifestByTag.delete(highest);
                console.log(`    Renamed ${oldPath} -> ${newPath}`);
            }

            // Update manifest entry for base
            manifestByTag.set(base, {
                tag: base,
                label: newLabel,
                description: newDesc,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// 3. Scan public/data/ folders and ensure manifests exist
// ---------------------------------------------------------------------------
console.log("\nScanning version folders...");
if (!fs.existsSync(DATA_DIR)) {
    console.error(`Data directory not found: ${DATA_DIR}`);
    process.exit(1);
}

const folders = fs.readdirSync(DATA_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}(-\d+)?$/.test(f) && fs.statSync(path.join(DATA_DIR, f)).isDirectory())
    .sort();

console.log(`Found ${folders.length} version folders`);

for (const tag of folders) {
    const folderPath = path.join(DATA_DIR, tag);
    const versionFile = path.join(folderPath, `version_${tag}.json`);

    const newLabel = annotationsByTag.get(tag)?.label;
    const newDesc = annotationsByTag.get(tag)?.description;

    if (fs.existsSync(versionFile)) {
        // Ensure it's in the manifest and up to date
        if (!manifestByTag.has(tag)) {
            console.log(`  Adding ${tag} to manifest (version file already exists)`);
        } else {
            console.log(`  Updating ${tag} (already in manifest)`);
        }
        try {
            const vData = JSON.parse(fs.readFileSync(versionFile, "utf-8")) as DefManifest;
            manifestByTag.set(tag, { tag, label: newLabel ?? vData.label, description: newDesc ?? vData.description });
            if ((newLabel && newLabel !== vData.label) || (newDesc && newDesc !== vData.description)) {
                // Update the version file with new annotations if they differ
                vData.label = newLabel ?? vData.label;
                vData.description = newDesc ?? vData.description;
                fs.writeFileSync(versionFile, JSON.stringify(vData, null, 2), "utf-8");
                console.log(`    Updated version file for ${tag} with new annotations`);
            }
        } catch {
            console.error(`    Failed to parse version file for ${tag}, things will break later.`);
            manifestByTag.set(tag, { tag, label: newLabel, description: newDesc });
        }
    } else {
        // Need to generate defs for this version
        if (annotationsOnly) {
            console.log(`  Skipping ${tag}: no version file (--annotations-only, not generating)`);
            continue;
        }
        console.log(`  Generating defs for ${tag}...`);
        const staticDir = path.join(folderPath, "static");
        if (!fs.existsSync(staticDir)) {
            console.warn(`    Skipping ${tag}: no static/ directory`);
            continue;
        }
        try {
            execSync(`tsx generate-defs.ts ${folderPath}`, {
                cwd: __dirname,
                stdio: "inherit",
            });
            // these should match generate-defs output since they are reading from the same annotations file
            manifestByTag.set(tag, { tag, label: newLabel, description: newDesc });
        } catch (e) {
            console.error(`    Failed to generate defs for ${tag}:`, e);
        }
    }
}

// ---------------------------------------------------------------------------
// 4. Write updated versions.json (sorted newest first)
// ---------------------------------------------------------------------------
const sortedManifest = [...manifestByTag.values()].sort((a, b) => compareVersionTagsDesc(a.tag, b.tag));
fs.writeFileSync(VERSIONS_FILE, JSON.stringify(sortedManifest, null, 2), "utf-8");
console.log(`\nWrote ${VERSIONS_FILE} with ${sortedManifest.length} entries`);

const latest = sortedManifest[0];
const latestData = {
    tag: latest?.tag ?? null,
    label: latest?.label ?? null,
    description: latest?.description ?? null,
};
fs.writeFileSync(LATEST_FILE, JSON.stringify(latestData, null, 2), "utf-8");
console.log(`Wrote ${LATEST_FILE}`);
console.log("\nDone.");
