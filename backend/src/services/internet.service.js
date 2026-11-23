import { tavily as Tavily } from "@tavily/core";

let tavilyClient = null;

function getTavilyClient() {
    if (!tavilyClient && process.env.TAVILY_API_KEY) {
        tavilyClient = Tavily({
            apiKey: process.env.TAVILY_API_KEY
        });
    }
    return tavilyClient;
}

/**
 * Determine if query intent seeks current news, recent events, or breaking updates
 */
export function isNewsQuery(query = "") {
    if (!query || typeof query !== "string") return false;
    const q = query.toLowerCase();

    const newsPatterns = [
        /\b(news|breaking|headline|headlines|updates?)\b/i,
        /\b(latest|recent|recently|newest)\b/i,
        /\b(today|yesterday|tonight|this\s+morning|this\s+evening)\b/i,
        /\b(this\s+week|past\s+week|last\s+week|past\s+24\s+hours|last\s+24\s+hours|past\s+few\s+days)\b/i,
        /\b(happening\s+now|what\s+happened|current\s+events?|who\s+won|match\s+score|election\s+results?)\b/i
    ];

    return newsPatterns.some(pattern => pattern.test(q));
}

/**
 * Clean conversational filler and command prefixes from the search query
 */
export function cleanSearchQuery(query = "") {
    if (!query || typeof query !== "string") return "";

    let cleaned = query.trim();

    // 1. Remove polite / conversational prefixes (e.g. "can you please", "please can you")
    cleaned = cleaned.replace(/^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|would\s+you\s+)?(?:please\s+)?(?:mind\s+)?/i, "");

    // 2. Remove search / retrieval commands at the start
    cleaned = cleaned.replace(/^(?:search\s+(?:the\s+web\s+|the\s+internet\s+|google\s+|online\s+)?(?:for\s+)?|look\s+up\s+|browse\s+(?:for\s+)?|find\s+(?:me\s+)?(?:online\s+)?(?:information\s+(?:on|about)\s+)?|tell\s+me\s+(?:about\s+)?|give\s+me\s+(?:the\s+)?(?:details\s+(?:on|about)\s+)?)/i, "");

    // 3. Remove trailing question marks
    cleaned = cleaned.replace(/[?]+$/, "").trim();

    // Fall back to original trimmed query if cleaning removed everything
    return cleaned.length > 0 ? cleaned : query.trim();
}

/**
 * Build dynamic search parameters for Tavily based on query intent and options
 */
export function detectSearchParameters(query = "", options = {}) {
    const cleanQuery = cleanSearchQuery(query);
    const qLower = query.toLowerCase();

    // 1. Determine topic
    let topic = options.topic;
    if (!topic) {
        topic = isNewsQuery(query) ? "news" : "general";
    }

    // 2. Determine recency (days / timeRange)
    let days = options.days;
    let timeRange = options.timeRange;

    if (topic === "news") {
        if (!days && !timeRange) {
            if (/\b(today|past\s+24\s+hours|last\s+24\s+hours|tonight|this\s+morning|breaking|now)\b/i.test(qLower)) {
                days = 1;
            } else if (/\b(yesterday)\b/i.test(qLower)) {
                days = 2;
            } else if (/\b(this\s+week|past\s+week|last\s+week|past\s+few\s+days|recent|latest)\b/i.test(qLower)) {
                days = 7;
            } else {
                days = Number(process.env.TAVILY_NEWS_DAYS) || 7;
            }
        }
    } else {
        // General search with temporal intent
        if (!timeRange && !days) {
            if (/\b(today|past\s+24\s+hours|last\s+24\s+hours)\b/i.test(qLower)) {
                timeRange = "day";
            } else if (/\b(this\s+week|past\s+week)\b/i.test(qLower)) {
                timeRange = "week";
            } else if (/\b(this\s+month|past\s+month)\b/i.test(qLower)) {
                timeRange = "month";
            } else if (/\b(this\s+year|past\s+year)\b/i.test(qLower)) {
                timeRange = "year";
            }
        }
    }

    // 3. Determine searchDepth
    let searchDepth = options.searchDepth;
    if (!searchDepth) {
        searchDepth = topic === "news" ? "advanced" : "basic";
    }

    // 4. Max results
    const maxResults = options.maxResults || 5;

    return {
        query: cleanQuery || query.trim(),
        originalQuery: query,
        topic,
        days,
        timeRange,
        searchDepth,
        maxResults,
        includeAnswer: options.includeAnswer !== false
    };
}

/**
 * Format raw Tavily results into clean, normalized source objects
 */
export function formatSearchSources(results = []) {
    if (!Array.isArray(results)) return [];

    return results.map(item => {
        let domain = "";
        try {
            domain = new URL(item.url).hostname.replace(/^www\./, "");
        } catch {
            domain = "web";
        }

        const rawDate = item.publishedDate || item.published_date || null;
        const publishedDate = rawDate && typeof rawDate === "string" ? rawDate.trim() : null;

        return {
            title: item.title || domain,
            url: item.url,
            domain,
            snippet: item.content || item.snippet || "",
            publishedDate,
            score: typeof item.score === "number" ? item.score : null
        };
    });
}

/**
 * Format search sources into a structured context string for the AI model
 */
export function formatSearchContext(sources = []) {
    if (!Array.isArray(sources) || sources.length === 0) return "";

    const contextLines = sources.map((s, idx) => {
        const datePart = s.publishedDate ? ` | Published: ${s.publishedDate}` : "";
        return `[${idx + 1}] "${s.title}" (${s.url})${datePart}\n${s.snippet}`;
    });

    return contextLines.join("\n\n");
}

/**
 * Execute web search via Tavily with dynamic news and freshness awareness
 */
export const searchInternet = async ({
    query = "",
    topic,
    days,
    timeRange,
    searchDepth,
    maxResults,
    includeAnswer
} = {}) => {
    if (!query || typeof query !== "string" || !query.trim()) {
        return {
            sources: [],
            answer: null,
            text: "",
            raw: null
        };
    }

    const client = getTavilyClient();
    if (!client) {
        console.warn("[SEARCH] Tavily API key is missing or not configured");
        return {
            sources: [],
            answer: null,
            text: "",
            raw: null,
            error: "API_KEY_MISSING"
        };
    }

    // Resolve query parameters with news detection and freshness heuristics
    const params = detectSearchParameters(query, {
        topic,
        days,
        timeRange,
        searchDepth,
        maxResults,
        includeAnswer
    });

    const searchOptions = {
        maxResults: params.maxResults,
        searchDepth: params.searchDepth,
        includeAnswer: params.includeAnswer
    };

    if (params.topic) {
        searchOptions.topic = params.topic;
    }
    if (params.days) {
        searchOptions.days = params.days;
    }
    if (params.timeRange) {
        searchOptions.timeRange = params.timeRange;
    }

    try {
        console.log(`[SEARCH] Querying Tavily: "${params.query}" (topic: ${params.topic}${params.days ? `, days: ${params.days}` : ""}${params.timeRange ? `, timeRange: ${params.timeRange}` : ""}, depth: ${params.searchDepth})`);
        const response = await client.search(params.query, searchOptions);

        const sources = formatSearchSources(response.results || []);
        const formattedContext = formatSearchContext(sources);

        return {
            sources,
            answer: response.answer || null,
            text: formattedContext,
            raw: response,
            params
        };
    } catch (error) {
        console.error(`[SEARCH] Tavily search failed for "${params.query}":`, error.message);
        return {
            sources: [],
            answer: null,
            text: "",
            raw: null,
            error: error.message,
            params
        };
    }
};
