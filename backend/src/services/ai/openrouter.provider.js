import { searchInternet, isNewsQuery } from "../internet.service.js";
import { needsInternetSearch } from "./gemini.provider.js";

export class OpenRouterProvider {
    getName() {
        return "openrouter";
    }

    getModelName() {
        return process.env.FALLBACK_AI_MODEL || "openrouter/free";
    }

    getApiKey() {
        if (!process.env.OPEN_ROUTER_API_KEY) {
            throw new Error("OPEN_ROUTER_API_KEY is not configured");
        }
        return process.env.OPEN_ROUTER_API_KEY;
    }

    async generate({ messages, systemPrompt, sources = [], onStatus }) {
        const apiKey = this.getApiKey();
        const model = this.getModelName();
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

        if (onStatus) onStatus({ status: "generating", label: "Generating response via fallback..." });

        const openRouterMessages = [
            { role: "system", content: formattedSystem },
            ...messages.map(m => ({
                role: m.role === "ai" ? "assistant" : "user",
                content: m.content
            }))
        ];

        const candidateModels = [
            process.env.FALLBACK_AI_MODEL || "openrouter/free",
            "openrouter/auto"
        ];

        let lastError = null;

        for (const model of candidateModels) {
            try {
                const requestSignal = AbortSignal.timeout(35000);
                const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:5173",
                        "X-Title": "Nova-Search"
                    },
                    body: JSON.stringify({
                        model,
                        messages: openRouterMessages,
                        temperature: 0.5
                    }),
                    signal: requestSignal
                });

                const data = await response.json();

                if (!response.ok) {
                    const err = new Error(data?.error?.message || `OpenRouter (${model}) failed with status ${response.status}`);
                    err.status = response.status;
                    lastError = err;
                    continue;
                }

                const content = data.choices?.[0]?.message?.content || "";

                return {
                    content,
                    sources: currentSources,
                    provider: "openrouter",
                    model
                };
            } catch (err) {
                lastError = err;
            }
        }

        if (lastError) {
            throw lastError;
        }
    }

    async *stream({ messages, systemPrompt, sources = [], onStatus, signal }) {
        const apiKey = this.getApiKey();
        const model = this.getModelName();
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
            if (currentSources.length > 0) {
                yield { type: "sources", sources: currentSources };
            }
        }

        if (onStatus) onStatus({ status: "generating", label: "Generating response..." });

        const openRouterMessages = [
            { role: "system", content: formattedSystem },
            ...messages.map(m => ({
                role: m.role === "ai" ? "assistant" : "user",
                content: m.content
            }))
        ];

        const candidateModels = [
            process.env.FALLBACK_AI_MODEL || "openrouter/free",
            "openrouter/auto"
        ];

        let lastError = null;

        for (const candidate of candidateModels) {
            try {
                const requestSignal = signal
                    ? AbortSignal.any([signal, AbortSignal.timeout(35000)])
                    : AbortSignal.timeout(35000);

                const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:5173",
                        "X-Title": "Nova-Search"
                    },
                    body: JSON.stringify({
                        model: candidate,
                        messages: openRouterMessages,
                        stream: true,
                        temperature: 0.5
                    }),
                    signal: requestSignal
                });

                if (!response.ok) {
                    const errorBody = await response.text();
                    let parsedMessage = errorBody;
                    try {
                        const parsed = JSON.parse(errorBody);
                        parsedMessage = parsed.error?.message || errorBody;
                    } catch {
                        // Keep raw
                    }
                    const err = new Error(`OpenRouter (${candidate}) error: ${parsedMessage}`);
                    err.status = response.status;
                    lastError = err;
                    continue; // try next candidate model
                }

                if (!response.body) {
                    throw new Error("No response body received from OpenRouter stream");
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                let chunksYielded = 0;

                while (true) {
                    if (signal?.aborted || requestSignal?.aborted) {
                        reader.cancel();
                        break;
                    }

                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith(":")) continue;

                        if (trimmed === "data: [DONE]") {
                            return;
                        }

                        if (trimmed.startsWith("data: ")) {
                            try {
                                const json = JSON.parse(trimmed.slice(6));
                                const delta = json.choices?.[0]?.delta?.content;
                                if (delta) {
                                    chunksYielded++;
                                    yield { type: "chunk", text: delta };
                                }
                            } catch {
                                // Ignore malformed intermediate chunk
                            }
                        }
                    }
                }

                if (chunksYielded > 0 || signal?.aborted) {
                    return;
                }
            } catch (modelErr) {
                if (signal?.aborted) throw modelErr;
                lastError = modelErr;
            }
        }

        if (lastError) {
            throw lastError;
        }
    }
}
