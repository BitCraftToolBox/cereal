import fs from "node:fs";
import path from "node:path";
import type {CandidateMatch} from "./fk-detector";

interface CandidateReport {
    generatedAt: string;
    tags: Record<string, CandidateMatch[]>;
}


function sortCandidates(a: CandidateMatch, b: CandidateMatch) {
    if (a.overrideType !== b.overrideType) return a.overrideType.localeCompare(b.overrideType);
    if (a.sourceKind !== b.sourceKind) return a.sourceKind.localeCompare(b.sourceKind);
    if (b.matchRate !== a.matchRate) return b.matchRate - a.matchRate;
    if (a.sourceTable !== b.sourceTable) return a.sourceTable.localeCompare(b.sourceTable);
    return a.sourceField.localeCompare(b.sourceField);
}

export function writeCandidateReport(reportPath: string, tag: string, matches: CandidateMatch[]): void {
    const sorted = [...matches].sort(sortCandidates);

    let report: CandidateReport = {
        generatedAt: new Date().toISOString(),
        tags: {},
    };
    if (fs.existsSync(reportPath)) {
        report = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as CandidateReport;
    }

    report.generatedAt = new Date().toISOString();
    report.tags[tag] = sorted;

    fs.mkdirSync(path.dirname(reportPath), {recursive: true});
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
}

export function printCandidateReport(tag: string, matches: CandidateMatch[]): void {
    if (matches.length === 0) {
        console.log("  No value-based FK candidates.");
        return;
    }

    const sorted = [...matches].sort(sortCandidates);

    console.log(`  Value-based FK candidates for ${tag}: ${sorted.length}`);
    let currentGroup = "";
    for (const c of sorted) {
        const group = `${c.overrideType}:${c.sourceKind}`;
        if (group !== currentGroup) {
            currentGroup = group;
            console.log(`\n  [${c.overrideType} / ${c.sourceKind}]`);
        }
        const rev = c.reverseRate !== undefined ? ` rev=${(c.reverseRate * 100).toFixed(0)}%` : "";
        const alts = c.alternateTargets?.length ? ` alt=[${c.alternateTargets.join(", ")}]` : "";
        console.log(`  ${c.configSnippet} // ${c.targetTable} ${(c.matchRate * 100).toFixed(0)}%${rev} n=${c.sampleSize}${alts}`);
    }
}
