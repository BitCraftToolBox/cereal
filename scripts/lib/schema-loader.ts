import fs from "node:fs";
import type {SpacetimeDBSchema} from "../../src/lib/schema";

export function loadSchema(schemaFile: string): { regionSchema: SpacetimeDBSchema; typeIndexToName: Map<number, string> } {
    if (!fs.existsSync(schemaFile)) {
        throw new Error(`Schema file not found: ${schemaFile}`);
    }

    const regionSchema = JSON.parse(fs.readFileSync(schemaFile, "utf-8")) as SpacetimeDBSchema;
    const typeIndexToName = new Map<number, string>();
    for (const namedType of regionSchema.types ?? []) {
        typeIndexToName.set(namedType.ty, namedType.name.name);
    }

    return {regionSchema, typeIndexToName};
}

