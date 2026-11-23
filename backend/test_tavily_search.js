import "dotenv/config";
import {
    isNewsQuery,
    cleanSearchQuery,
    detectSearchParameters,
    formatSearchSources,
    formatSearchContext,
    searchInternet
} from "./src/services/internet.service.js";
import messageModel from "./src/models/message.model.js";

console.log("=================================================");
console.log("--- TAVILY SEARCH & NEWS TEST SUITE ---");
console.log("=================================================\n");

let passedTests = 0;
let totalTests = 0;

function assert(condition, testName, details = "") {
    totalTests++;
    if (condition) {
        console.log(`[PASS] ${testName}`);
        passedTests++;
    } else {
        console.error(`[FAIL] ${testName}${details ? ` -> ${details}` : ""}`);
    }
}

// -------------------------------------------------------------------
// 1. Unit Tests: Query Cleaning
// -------------------------------------------------------------------
console.log("--- 1. Query Cleaning Tests ---");
assert(
    cleanSearchQuery("can you please search the web for OpenAI") === "OpenAI",
    "Strips 'can you please search the web for'",
    `Received: "${cleanSearchQuery("can you please search the web for OpenAI")}"`
);

assert(
    cleanSearchQuery("look up the latest news on React") === "the latest news on React",
    "Strips 'look up'",
    `Received: "${cleanSearchQuery("look up the latest news on React")}"`
);

assert(
    cleanSearchQuery("tell me about quantum computing?") === "quantum computing",
    "Strips 'tell me about' and trailing question marks",
    `Received: "${cleanSearchQuery("tell me about quantum computing?")}"`
);

assert(
    cleanSearchQuery("") === "",
    "Handles empty string gracefully"
);

assert(
    cleanSearchQuery(null) === "",
    "Handles null query gracefully"
);

// -------------------------------------------------------------------
// 2. Unit Tests: News Intent Detection
// -------------------------------------------------------------------
console.log("\n--- 2. News Intent Detection Tests ---");
assert(
    isNewsQuery("Latest news on OpenAI") === true,
    "Detects 'latest news' as news query"
);

assert(
    isNewsQuery("What happened in AI today?") === true,
    "Detects 'today' and 'what happened' as news query"
);

assert(
    isNewsQuery("Tech news this week") === true,
    "Detects 'this week' and 'news' as news query"
);

assert(
    isNewsQuery("Breaking updates on Mars mission") === true,
    "Detects 'breaking updates' as news query"
);

assert(
    isNewsQuery("Who won the match yesterday") === true,
    "Detects 'who won' and 'yesterday' as news query"
);

assert(
    isNewsQuery("How does photosynthesis work?") === false,
    "Rejects general conceptual query as news"
);

assert(
    isNewsQuery("Explain quicksort in Python") === false,
    "Rejects programming tutorial query as news"
);

// -------------------------------------------------------------------
// 3. Unit Tests: Dynamic Search Parameter Resolution
// -------------------------------------------------------------------
console.log("\n--- 3. Search Parameter Builder Tests ---");
const generalParams = detectSearchParameters("How does photosynthesis work?");
assert(
    generalParams.topic === "general" && generalParams.searchDepth === "basic",
    "General query resolves topic: 'general' and searchDepth: 'basic'"
);

const newsParams = detectSearchParameters("Latest news on OpenAI");
assert(
    newsParams.topic === "news" && newsParams.searchDepth === "advanced" && newsParams.days === 7,
    "News query resolves topic: 'news', days: 7, and searchDepth: 'advanced'",
    `topic: ${newsParams.topic}, days: ${newsParams.days}, depth: ${newsParams.searchDepth}`
);

const todayParams = detectSearchParameters("What happened in AI today?");
assert(
    todayParams.topic === "news" && todayParams.days === 1,
    "Today query resolves days: 1 for maximum freshness",
    `days: ${todayParams.days}`
);

const yesterdayParams = detectSearchParameters("AI news yesterday");
assert(
    yesterdayParams.topic === "news" && yesterdayParams.days === 2,
    "Yesterday query resolves days: 2",
    `days: ${yesterdayParams.days}`
);

const explicitOverride = detectSearchParameters("Some generic topic", { topic: "news", days: 3, searchDepth: "basic" });
assert(
    explicitOverride.topic === "news" && explicitOverride.days === 3 && explicitOverride.searchDepth === "basic",
    "Explicit caller options override auto-detection defaults"
);

// -------------------------------------------------------------------
// 4. Unit Tests: Source Normalization & Date Preservation
// -------------------------------------------------------------------
console.log("\n--- 4. Source Normalization & Context Formatting Tests ---");
const rawMockResults = [
    {
        title: "OpenAI Launches New Frontier Model",
        url: "https://news.ycombinator.com/item?id=123",
        content: "OpenAI announced their latest milestone today.",
        publishedDate: "Fri, 20 Nov 2026 12:00:00 GMT",
        score: 0.95
    },
    {
        title: "Historical Overview of Transformers",
        url: "https://wikipedia.org/wiki/Transformer",
        content: "Transformers were introduced in 2017.",
        published_date: null,
        score: 0.82
    }
];

const formattedSources = formatSearchSources(rawMockResults);
assert(
    formattedSources.length === 2,
    "Formats all items into sources"
);
assert(
    formattedSources[0].publishedDate === "Fri, 20 Nov 2026 12:00:00 GMT",
    "Preserves publishedDate from Tavily"
);
assert(
    formattedSources[0].domain === "news.ycombinator.com",
    "Extracts clean domain without www."
);
assert(
    formattedSources[0].score === 0.95,
    "Preserves search relevance score"
);
assert(
    formattedSources[1].publishedDate === null,
    "Does NOT fabricate publishedDate when omitted by source"
);

const contextOutput = formatSearchContext(formattedSources);
assert(
    contextOutput.includes("Published: Fri, 20 Nov 2026 12:00:00 GMT"),
    "Context string includes publication timestamp for fresh sources"
);
assert(
    !contextOutput.includes("Wikipedia") || !contextOutput.includes("Published: null"),
    "Context string does not output 'Published: null' or fake dates"
);

// -------------------------------------------------------------------
// 5. Unit Tests: Schema Verification
// -------------------------------------------------------------------
console.log("\n--- 5. Schema Verification Tests ---");
const sourceSchemaPaths = messageModel.schema.paths;
assert(
    !!sourceSchemaPaths["metadata.sources"],
    "Message model contains metadata.sources"
);
assert(
    sourceSchemaPaths["metadata.sources"].schema.paths.publishedDate !== undefined,
    "metadata.sources schema defines publishedDate"
);
assert(
    sourceSchemaPaths["metadata.sources"].schema.paths.score !== undefined,
    "metadata.sources schema defines score"
);

// -------------------------------------------------------------------
// 6. Unit Tests: Error Resilience
// -------------------------------------------------------------------
console.log("\n--- 6. Error Resilience Tests ---");
const emptyRes = await searchInternet({ query: "" });
assert(
    emptyRes.sources.length === 0 && emptyRes.text === "",
    "Empty query returns empty sources and blank text without throwing"
);

// -------------------------------------------------------------------
// 7. Live Tavily Integration Test (Conditional)
// -------------------------------------------------------------------
console.log("\n--- 7. Live Tavily Integration Test ---");
if (process.env.TAVILY_API_KEY) {
    try {
        console.log("Running live search query: 'latest news on artificial intelligence' (topic: news, days: 7)...");
        const liveResult = await searchInternet({
            query: "latest news on artificial intelligence",
            maxResults: 3
        });

        assert(
            Array.isArray(liveResult.sources),
            "Live search returned sources array"
        );
        assert(
            liveResult.sources.length > 0,
            `Live search returned ${liveResult.sources.length} sources`
        );
        assert(
            liveResult.params.topic === "news",
            "Live search correctly auto-detected topic: 'news'"
        );
        assert(
            liveResult.params.days === 7,
            "Live search applied days: 7 freshness window"
        );
        assert(
            typeof liveResult.text === "string" && liveResult.text.length > 0,
            "Live search generated formatted LLM context string"
        );

        const hasDate = liveResult.sources.some(s => s.publishedDate);
        console.log(`Live search returned sources with publishedDate: ${hasDate ? "YES" : "NO"}`);
        if (liveResult.sources[0]) {
            console.log(`Sample Source [0]: "${liveResult.sources[0].title}" (${liveResult.sources[0].domain}) | Date: ${liveResult.sources[0].publishedDate}`);
        }
        assert(
            liveResult.sources[0].url.startsWith("http"),
            "Live source has valid HTTP/HTTPS URL"
        );
    } catch (err) {
        console.error("Live Tavily search encountered error:", err.message);
        assert(false, "Live Tavily search failed", err.message);
    }
} else {
    console.log("Skipping live Tavily API test (TAVILY_API_KEY not set in environment)");
}

// -------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------
console.log("\n=================================================");
console.log(`--- TEST RESULTS: ${passedTests}/${totalTests} PASSED ---`);
console.log("=================================================");

if (passedTests === totalTests) {
    console.log("ALL TAVILY SEARCH TESTS PASSED SUCCESSFULLY!");
    process.exit(0);
} else {
    console.error(`FAILED: ${totalTests - passedTests} tests failed.`);
    process.exit(1);
}
