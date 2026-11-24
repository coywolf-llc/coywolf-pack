// AI Enrichment unit tests live next to the module (src/ai/*.test.ts); this pulls them into `node --test test/*.test.mjs`.
import "./ts-resolve.mjs";

await import("../src/ai/logic.test.ts");
await import("../src/ai/queue.test.ts");
await import("../src/ai/wikidata.test.ts");
await import("../src/ai/glossary.test.ts");
await import("../src/ai/glossary-links.test.ts");
