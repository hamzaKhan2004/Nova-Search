import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { searchInternet, isNewsQuery } from "../internet.service.js";

let geminiClient = null;

function getGeminiModel() {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is not configured");
    }

    const modelName = process.env.PRIMARY_AI_MODEL || "gemini-3.1-flash-lite";
    return new ChatGoogleGenerativeAI({
        model: modelName,
        apiKey: process.env.GEMINI_API_KEY,
        temperature: 0.4
    });
}

/**
 * Determine if search is needed based on prompt intent
 */
export function needsInternetSearch(query = "") {
    const q = query.toLowerCase();
    const triggerPatterns = [
        /\b(latest|news|today|yesterday|current|price|stock|update|recent|released|score|weather|now)\b/i,
        /\b(who is the (current|new)|what happened|who won)\b/i,
        /\b(search|google|browse|find online)\b/i
    ];
    return triggerPatterns.some(pattern => pattern.test(q));
}

/**
 * Check if the prompt is an email drafting or sending request
 */
export function isEmailDraftRequest(query = "") {
    if (!query || typeof query !== "string") return false;
    const q = query.trim().toLowerCase();

    // Ignore generic coding / tech inquiries unless specific email sending target is given
    const isCodeQuery = /\b(how\s+to|code|example|tutorial|library|package|nodemailer|api|syntax|script)\b/i.test(q);
    const hasEmailAddress = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/.test(q);

    if (isCodeQuery && !hasEmailAddress) {
        return false;
    }

    // Direct action match: "draft email", "send an email", "compose a mail", "send mail", "shoot an email"
    const hasEmailIntent = /\b(draft|write|compose|send|shoot|dispatch|prepare)\s+(an?\s+)?(e-?mail|mail)\b/i.test(q);

    // Direct target match: "email user@example.com" or "mail user@example.com"
    const hasDirectTarget = /\b(e-?mail|mail)\s+(to\s+)?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/i.test(q);

    // General send intent with email address present: e.g. "send this to abc@xyz.com"
    const hasSendAndAddress = hasEmailAddress && /\b(send|email|mail|forward|shoot|deliver)\b/i.test(q);

    return hasEmailIntent || hasDirectTarget || hasSendAndAddress;
}

/**
 * Extract recipient, subject, and body heuristics from email drafting query
 */
export function parseEmailDraftDetails(query = "") {
    const text = (query || "").trim();

    // 1. Extract email recipient
    const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const to = emailMatch ? emailMatch[1] : "";

    // 2. Extract subject if specified
    let subject = "Update from Nova";
    const subjectQuoted = text.match(/(?:with\s+)?subject\s*[:="']+\s*([^"'\n\r]+)["']/i);
    const subjectColon = text.match(/subject:\s*([^\n\r,]+)/i);
    const subjectAbout = text.match(/(?:about|regarding)\s+([^,.\n\r]+)/i);

    if (subjectQuoted && subjectQuoted[1].trim()) {
        subject = subjectQuoted[1].trim();
    } else if (subjectColon && subjectColon[1].trim()) {
        subject = subjectColon[1].trim();
    } else if (subjectAbout && subjectAbout[1].trim()) {
        subject = subjectAbout[1].trim();
    }

    // 3. Extract body content
    let body = "";
    const bodyExplicit = text.match(/(?:saying|with\s+(?:the\s+)?(?:body|content|message)|body:|message:)\s*[:"']*\s*([\s\S]+)/i);
    if (bodyExplicit && bodyExplicit[1].trim()) {
        body = bodyExplicit[1].replace(/["']+$/, "").trim();
    } else {
        // Fallback: strip command prefixes and recipient
        body = text
            .replace(/^(?:please\s+)?(?:draft|write|compose|send|shoot)\s+(?:an?\s+)?(?:e-?mail|mail)\s+/i, "")
            .replace(/(?:to\s+)?[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i, "")
            .replace(/(?:with\s+)?subject\s*[:="']+\s*[^"'\n\r]+["']?/i, "")
            .replace(/^(?:about|saying|that|with)\s+/i, "")
            .trim();
    }

    if (!body) {
        body = "Hi,\n\nFollowing up on our recent conversation.\n\nBest regards,";
    }

    return { to, subject, body };
}


export class GeminiProvider {
    getName() {
        return "gemini";
    }

    getModelName() {
        return process.env.PRIMARY_AI_MODEL || "gemini-3.1-flash-lite";
    }

    async generate({ messages, systemPrompt, sources = [], onStatus }) {
        const model = getGeminiModel();
        const lastUserMsg = [...messages].reverse().find(m => m.role === "user")?.content || "";

        let currentSources = sources;
        let formattedSystem = systemPrompt;

        if (currentSources.length === 0 && needsInternetSearch(lastUserMsg) && !systemPrompt.includes("[REAL-TIME SEARCH RESULTS]")) {
            const isNews = isNewsQuery(lastUserMsg);
            if (onStatus) onStatus({ status: "searching", label: isNews ? "Searching latest news..." : "Searching the web..." });
            const searchRes = await searchInternet({ query: lastUserMsg });
            currentSources = searchRes.sources || [];
            if (searchRes.text) {
                formattedSystem = `${systemPrompt}\n\n[REAL-TIME SEARCH RESULTS]\n${searchRes.text}\n\n[SEARCH DIRECTIVE]: Prioritize recent and up-to-date information from the real-time search results above when answering. Use the provided publication dates to establish timeline and recency. Do not fabricate dates or cite sources outside the provided results.`;
            }
            if (onStatus) onStatus({ status: "reading", label: "Reading sources..." });
        }

        const langChainMessages = [
            new SystemMessage(formattedSystem),
            ...messages.map(m => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)))
        ];

        if (onStatus) onStatus({ status: "generating", label: "Generating response..." });

        const requestSignal = AbortSignal.timeout(30000);
        const result = await model.invoke(langChainMessages, { signal: requestSignal });
        const text = typeof result.content === "string" ? result.content : result.text || "";

        return {
            content: text,
            sources: currentSources,
            provider: "gemini",
            model: this.getModelName()
        };
    }

    async *stream({ messages, systemPrompt, sources = [], onStatus, signal }) {
        const model = getGeminiModel();
        const lastUserMsg = [...messages].reverse().find(m => m.role === "user")?.content || "";

        let currentSources = sources;
        let formattedSystem = systemPrompt;

        // Only search if search results were not preloaded and not in prompt
        if (currentSources.length === 0 && needsInternetSearch(lastUserMsg) && !systemPrompt.includes("[REAL-TIME SEARCH RESULTS]")) {
            const isNews = isNewsQuery(lastUserMsg);
            if (onStatus) onStatus({ status: "searching", label: isNews ? "Searching latest news..." : "Searching the web..." });
            const searchRes = await searchInternet({ query: lastUserMsg });
            currentSources = searchRes.sources || [];
            if (searchRes.text) {
                formattedSystem = `${systemPrompt}\n\n[REAL-TIME SEARCH RESULTS]\n${searchRes.text}\n\n[SEARCH DIRECTIVE]: Prioritize recent and up-to-date information from the real-time search results above when answering. Use the provided publication dates to establish timeline and recency. Do not fabricate dates or cite sources outside the provided results.`;
            }
            if (onStatus) onStatus({ status: "reading", label: "Reading sources..." });
            if (currentSources.length > 0) {
                yield { type: "sources", sources: currentSources };
            }
        }

        const langChainMessages = [
            new SystemMessage(formattedSystem),
            ...messages.map(m => (m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)))
        ];

        if (onStatus) onStatus({ status: "generating", label: "Generating response..." });

        const requestSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
            : AbortSignal.timeout(30000);

        const stream = await model.stream(langChainMessages, { signal: requestSignal });

        for await (const chunk of stream) {
            if (signal?.aborted || requestSignal?.aborted) break;
            const textChunk = typeof chunk.content === "string" ? chunk.content : chunk.text || "";
            if (textChunk) {
                yield { type: "chunk", text: textChunk };
            }
        }
    }
}
