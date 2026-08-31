import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const envPath = path.join(repoRoot, ".env.local");
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let minChars = 80;
  let maxLinkDensity = 0.25;
  let minParagraphs = 3;
  let configPath = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--min-chars" && args[i + 1]) {
      minChars = Number(args[i + 1]);
      i++;
    } else if (arg === "--max-link-density" && args[i + 1]) {
      maxLinkDensity = Number(args[i + 1]);
      i++;
    } else if (arg === "--min-paragraphs" && args[i + 1]) {
      minParagraphs = Number(args[i + 1]);
      i++;
    } else if (arg === "--config" && args[i + 1]) {
      configPath = args[i + 1];
      i++;
    }
  }

  if (configPath) {
    const fullConfigPath = path.resolve(repoRoot, configPath);
    if (fs.existsSync(fullConfigPath)) {
      const configData = JSON.parse(fs.readFileSync(fullConfigPath, "utf8"));
      if (configData.minChars !== undefined) minChars = Number(configData.minChars);
      if (configData.maxLinkDensity !== undefined)
        maxLinkDensity = Number(configData.maxLinkDensity);
      if (configData.minParagraphs !== undefined) minParagraphs = Number(configData.minParagraphs);
    } else {
      console.error(`Config file not found: ${fullConfigPath}`);
      process.exit(1);
    }
  }

  const { db } = await import(path.join(repoRoot, "src/lib/db/index.ts"));
  const { evidenceSignalObservations } = await import(path.join(repoRoot, "src/lib/db/schema.ts"));

  console.log("=== COUNTERFACTUAL THRESHOLD REPRODUCTION HARNESS ===");
  console.log(`Thresholds applied:`);
  console.log(`  - minChars: ${minChars}`);
  console.log(`  - maxLinkDensity: ${maxLinkDensity}`);
  console.log(`  - minParagraphs: ${minParagraphs}`);

  const rows = await db.select().from(evidenceSignalObservations);

  if (rows.length === 0) {
    console.log(
      JSON.stringify(
        { total: 0, message: "evidence_signal_observations table is empty." },
        null,
        2,
      ),
    );
    return;
  }

  let totalObservations = rows.length;
  let currentPassCount = 0;
  let currentFailCount = 0;
  let newPassCount = 0;
  let newFailCount = 0;

  let flippedToPass = 0;
  let flippedToFail = 0;

  const hostBreakdown = {};
  const conditionBreakdownCurrent = {
    text_length: 0,
    link_density: 0,
    paragraph_count: 0,
  };
  const conditionBreakdownNew = {
    text_length: 0,
    link_density: 0,
    paragraph_count: 0,
  };

  for (const row of rows) {
    if (!hostBreakdown[row.host]) {
      hostBreakdown[row.host] = {
        total: 0,
        currentPass: 0,
        currentFail: 0,
        newPass: 0,
        newFail: 0,
        flippedToPass: 0,
        flippedToFail: 0,
      };
    }

    const hostStat = hostBreakdown[row.host];
    hostStat.total++;

    // Current pass/fail evaluation
    const currentPassed = row.passedGate;
    if (currentPassed) {
      currentPassCount++;
      hostStat.currentPass++;
    } else {
      currentFailCount++;
      hostStat.currentFail++;
      if (row.failedConditions) {
        for (const cond of row.failedConditions.split(",")) {
          const trimmed = cond.trim();
          if (conditionBreakdownCurrent[trimmed] !== undefined) {
            conditionBreakdownCurrent[trimmed]++;
          }
        }
      }
    }

    // New threshold evaluation
    const newFailedConditions = [];
    if (row.textLength < minChars) newFailedConditions.push("text_length");
    if (row.linkDensity > maxLinkDensity) newFailedConditions.push("link_density");
    if (row.paragraphCount < minParagraphs) newFailedConditions.push("paragraph_count");

    const newPassed = newFailedConditions.length === 0;

    if (newPassed) {
      newPassCount++;
      hostStat.newPass++;
    } else {
      newFailCount++;
      hostStat.newFail++;
      for (const cond of newFailedConditions) {
        if (conditionBreakdownNew[cond] !== undefined) {
          conditionBreakdownNew[cond]++;
        }
      }
    }

    if (!currentPassed && newPassed) {
      flippedToPass++;
      hostStat.flippedToPass++;
    } else if (currentPassed && !newPassed) {
      flippedToFail++;
      hostStat.flippedToFail++;
    }
  }

  const report = {
    thresholds: {
      minChars,
      maxLinkDensity,
      minParagraphs,
    },
    summary: {
      totalObservations,
      current: {
        pass: currentPassCount,
        fail: currentFailCount,
        passRate: ((currentPassCount / totalObservations) * 100).toFixed(2) + "%",
      },
      new: {
        pass: newPassCount,
        fail: newFailCount,
        passRate: ((newPassCount / totalObservations) * 100).toFixed(2) + "%",
      },
      delta: {
        flippedToPass,
        flippedToFail,
        netChange: newPassCount - currentPassCount,
      },
    },
    failedConditions: {
      current: conditionBreakdownCurrent,
      new: conditionBreakdownNew,
    },
    hostBreakdown,
  };

  console.log("\n--- JSON REPORT ---");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("Error running counterfactual tool:", err);
  process.exit(1);
});
