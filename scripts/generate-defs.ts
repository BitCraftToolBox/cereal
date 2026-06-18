/**
 * generate-defs.ts
 *
 * Standalone tool that reads <versionDir>/static/*.json and <versionDir>/region_schema.json,
 * computes table metadata and foreign-key mappings, and writes the results
 * to <versionDir>/version_<tag>.json.
 *
 * Usage:
 *   npm run gen-defs -- <versionDir>
 *   e.g. npm run gen-defs -- public/data/2026-04-30
 */

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import type {DefManifest, SpacetimeDBSchema, TableMeta, VersionEntry,} from "../src/lib/schema";
import {getNestedValue} from "../src/lib/schema";
import {printCandidateReport, writeCandidateReport} from "./lib/candidate-report";
import {type CandidateMatch, detectForeignKeys, type FkDetectionConfig, loadStateDumpCandidates,} from "./lib/fk-detector";
import {parseJsonLossless} from "./lib/json-lossless";
import {buildSchemaAnalysis} from "./lib/schema-analysis";
import {loadSchema} from "./lib/schema-loader";
import {buildSearchIndex} from "./lib/search-index";
import {type BuildTableMeta, buildTableMeta} from "./lib/table-meta";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANNOTATIONS = path.resolve(__dirname, "version_annotations.json");
const FK_CONFIG_PATH = path.resolve(__dirname, "fk-detection.config.json");

// Accept a version folder path as the first non-flag argument.
const args = process.argv.slice(2);
let versionArg: string | undefined;
let cliCandidateOutput: string | undefined;
const cliStateDumpDirs: string[] = [];
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--fk-candidates-output") {
        const next = args[i + 1];
        if (!next) {
            console.error("Missing value for --fk-candidates-output");
            process.exit(1);
        }
        cliCandidateOutput = next;
        i++;
        continue;
    }
    if (a === "--state-dump-dir") {
        const next = args[i + 1];
        if (!next) {
            console.error("Missing value for --state-dump-dir");
            process.exit(1);
        }
        cliStateDumpDirs.push(next);
        i++;
        continue;
    }
    if (a.startsWith("--")) {
        console.error(`Unknown flag: ${a}`);
        process.exit(1);
    }
    if (!versionArg) {
        versionArg = a;
    } else {
        console.error(`Unexpected argument: ${a}`);
        process.exit(1);
    }
}

if (!versionArg) {
    console.error("Usage: tsx scripts/generate-defs.ts <versionDir> [--fk-candidates-output <path>] [--state-dump-dir <path>]...");
    console.error("  e.g. tsx scripts/generate-defs.ts public/data/2026-04-30");
    process.exit(1);
}

const envCandidateOutput = process.env.GEN_DEFS_FK_CANDIDATES_OUTPUT;
const envStateDumpDirs = (process.env.GEN_DEFS_STATE_DUMP_DIRS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const stateDumpDirs = [...cliStateDumpDirs, ...envStateDumpDirs]
    .map((p) => path.resolve(process.cwd(), p));
const candidateOutputPath = cliCandidateOutput ?? envCandidateOutput
    ? path.resolve(process.cwd(), cliCandidateOutput ?? envCandidateOutput!)
    : undefined;

const VERSION_DIR = path.resolve(process.cwd(), versionArg);
const VERSION_TAG = path.basename(VERSION_DIR);
const DATA_DIR = path.join(VERSION_DIR, "static");
const SCHEMA_FILE = path.join(VERSION_DIR, "region_schema.json");

if (!fs.existsSync(VERSION_DIR)) {
    console.error(`Version directory not found: ${VERSION_DIR}`);
    process.exit(1);
}

if (!fs.existsSync(FK_CONFIG_PATH)) {
    console.error(`FK config not found: ${FK_CONFIG_PATH}`);
    process.exit(1);
}

let fkConfig: FkDetectionConfig;
try {
    fkConfig = JSON.parse(fs.readFileSync(FK_CONFIG_PATH, "utf-8")) as FkDetectionConfig;
} catch (e) {
    console.error(`Failed to parse FK config: ${FK_CONFIG_PATH}`);
    console.error(e);
    process.exit(1);
}

const requiredConfigKeys: Array<keyof FkDetectionConfig> = [
    "nameOverrides",
    "fkOverrides",
    "listOverrides",
    "taggedUnionOverrides",
    "enumTargets",
    "typeConditionalRules",
];
for (const key of requiredConfigKeys) {
    if (!(key in fkConfig)) {
        console.error(`FK config missing key: ${key}`);
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// 1. Parse region_schema.json
// ---------------------------------------------------------------------------
console.log(`Loading DB schema from ${SCHEMA_FILE}...`);
let regionSchema: SpacetimeDBSchema;
try {
    ({regionSchema} = loadSchema(SCHEMA_FILE));
} catch (e) {
    console.error(e);
    process.exit(1);
}

const schemaAnalysis = buildSchemaAnalysis(regionSchema);
const {
    schemaTableInfo,
    globalEnumRegistry,
    collectTaggedUnionFieldsByName,
    collectIdFieldsFromProductForFK,
    collectEnumFieldsFromProductForFK,
    resolveColumnPath,
} = schemaAnalysis;

const IGNORE_TABLE_PREFIXES = fkConfig.ignoreTables ?? [];
const isIgnoredTable = (name: string) => IGNORE_TABLE_PREFIXES.some((p) => name.startsWith(p));

{
    const pub = [...schemaTableInfo.values()].filter((t) => t.isPublic).length;
    console.log(`  Found ${schemaTableInfo.size} tables in schema (${pub} public, ${schemaTableInfo.size - pub} private)`);
}

const NAME_OVERRIDES: Record<string, string | null> = fkConfig.nameOverrides;


// ---------------------------------------------------------------------------
// 4. Load data files
// ---------------------------------------------------------------------------
const jsonFiles = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).sort();
console.log(`\nFound ${jsonFiles.length} data files in ${DATA_DIR}`);

const tableData: Record<string, { meta: BuildTableMeta; rows: Record<string, unknown>[] }> = {};

for (const file of jsonFiles) {
    const tableName = file.replace(/\.json$/, "");
    process.stdout.write(`  Loading ${tableName}...`);
    // Lossless parse: preserve U64 ids beyond 2^53 (as strings) for correct FK matching.
    const rows = parseJsonLossless<Record<string, unknown>[]>(fs.readFileSync(path.join(DATA_DIR, file), "utf-8"));
    tableData[tableName] = {
        meta: buildTableMeta(tableName, rows, schemaTableInfo.get(tableName), NAME_OVERRIDES),
        rows,
    };
    console.log(` ${rows.length} rows`);
}

// Register schema-only (private) tables with empty rows so their schema stays viewable.
// Ignored tables (staged_*, inter_module_message*, …) are still registered here — they are
// excluded only from FK *detection* (handled inside detectForeignKeys), not from the manifest.
let privateOnlyCount = 0;
let ignoredCount = 0;
for (const [tableName, info] of schemaTableInfo) {
    if (tableName in tableData) continue;
    if (isIgnoredTable(tableName)) ignoredCount++;
    tableData[tableName] = {
        meta: buildTableMeta(tableName, [], info, NAME_OVERRIDES),
        rows: [],
    };
    privateOnlyCount++;
}
console.log(`  Registered ${privateOnlyCount} schema-only (private) tables (${ignoredCount} ignored for FK detection)`);

// ---------------------------------------------------------------------------
// 5. Detect FKs and write outputs
// ---------------------------------------------------------------------------
console.log("\nDetecting foreign keys...");
const {mappings: foreignKeys, candidates: staticCandidates} = detectForeignKeys({
    tables: tableData,
    schemaTableInfo,
    regionSchema,
    fkConfig,
    globalEnumRegistry,
    collectTaggedUnionFieldsByName,
    collectIdFieldsFromProductForFK,
    collectEnumFieldsFromProductForFK,
    resolveColumnPath,
    getNestedValue,
});
console.log(`  Found ${foreignKeys.length} foreign key mappings`);

let stateCandidates: CandidateMatch[] = [];
try {
    // Value-based candidates defer to type/name matches already produced above.
    const alreadyMapped = new Set(foreignKeys.map((fk) => `${fk.sourceTable}\u0000${fk.sourceField}`));
    stateCandidates = loadStateDumpCandidates(stateDumpDirs, tableData, getNestedValue, alreadyMapped);
} catch (e) {
    console.error(e);
    process.exit(1);
}
const candidateMatches = [...staticCandidates, ...stateCandidates];
printCandidateReport(VERSION_TAG, candidateMatches);
if (candidateOutputPath) {
    writeCandidateReport(candidateOutputPath, VERSION_TAG, candidateMatches);
    console.log(`\n  Also wrote candidate report to ${candidateOutputPath}`);
}


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

// Strip build-only fields (searchFields, enumColumns) so the manifest stays slim. Structural
// metadata + enums are re-derived from region_schema.json at runtime via schemaDerive.ts.
const toManifestMeta = ({searchFields: _s, enumColumns: _e, ...slim}: BuildTableMeta): TableMeta => slim;

const manifest: DefManifest = {
    tag: VERSION_TAG,
    label: annotationsByTag.get(VERSION_TAG)?.label,
    description: annotationsByTag.get(VERSION_TAG)?.description,
    tables: Object.values(tableData).map(({meta}) => toManifestMeta(meta)),
    foreignKeys,
};

const outputPath = path.join(VERSION_DIR, `version_${VERSION_TAG}.json`);
fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2), "utf-8");
console.log(`\nWrote ${outputPath}`);

// ---------------------------------------------------------------------------
// 6. Generate search index
// ---------------------------------------------------------------------------
console.log("\nBuilding search index...");
const {index: searchIndex, totalEntryCount} = buildSearchIndex(VERSION_TAG, tableData);
const searchPath = path.join(VERSION_DIR, `search_${VERSION_TAG}.json`);
fs.writeFileSync(searchPath, JSON.stringify(searchIndex), "utf-8"); // compact, no indent
const fileSizeKb = Math.round(fs.statSync(searchPath).size / 1024);
console.log(`Wrote ${searchPath} (${totalEntryCount} entries, ${fileSizeKb} KB)`);

console.log("\nDone.");
