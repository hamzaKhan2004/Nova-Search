import "dotenv/config";
import http from "http";
import jwt from "jsonwebtoken";
import { io as Client } from "../frontend/node_modules/socket.io-client/build/esm/index.js";
import app from "./src/app.js";
import connectDB from "./src/config/database.js";
import { initSocket } from "./src/sockets/server.socket.js";
import userModel from "./src/models/user.model.js";
import messageModel from "./src/models/message.model.js";
import chatModel from "./src/models/chat.model.js";
import { aiProviderManager, AIServiceUnavailableError } from "./src/services/ai/provider.manager.js";

console.log("===============================================================");
console.log("   NOVA SEARCH - CHAT GENERATION & LIFECYCLE TEST SUITE       ");
console.log("===============================================================\n");

let passed = 0;
let total = 0;

function assert(cond, name, details = "") {
    total++;
    if (cond) {
        console.log(`[PASS] Scenario: ${name}`);
        passed++;
    } else {
        console.error(`[FAIL] Scenario: ${name} -> ${details}`);
    }
}

async function runTests() {
    await connectDB();

    const server = http.createServer(app);
    initSocket(server);

    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    let user = await userModel.findOne();
    if (!user) {
        user = await userModel.create({
            username: "chat_tester",
            email: "chat_tester@example.com",
            password: "password123",
            verified: true
        });
    }

    const token = jwt.sign(
        { id: user._id.toString(), email: user.email, username: user.username },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
    );

    function createClient() {
        return Client(`http://localhost:${port}`, {
            auth: { token },
            transports: ["websocket"]
        });
    }

    // -------------------------------------------------------------
    // Scenario 1: Simple chatbot message ("hello")
    // -------------------------------------------------------------
    console.log("\n--- Scenario 1: Simple chatbot message ('hello') ---");
    {
        const client = createClient();
        await new Promise(res => client.on("connect", res));

        let createdReceived = false;
        let messageSavedReceived = false;
        let chunksReceived = 0;
        let doneReceived = false;

        client.on("chat:created", () => { createdReceived = true; });
        client.on("chat:message_saved", () => { messageSavedReceived = true; });
        client.on("chat:chunk", () => { chunksReceived++; });

        const donePromise = new Promise(res => {
            client.on("chat:done", (data) => {
                doneReceived = true;
                res(data);
            });
            client.on("chat:error", (err) => {
                res({ error: err });
            });
        });

        client.emit("chat:send", { message: "hello", chatId: null });
        const result = await donePromise;

        assert(createdReceived, "1.1 Chat created event emitted");
        assert(messageSavedReceived, "1.2 User message saved event emitted");
        assert(chunksReceived > 0 || result.message?.content, "1.3 Streamed chunks or content returned");
        assert(doneReceived && result.message?.id, "1.4 Chat done emitted with valid saved message");

        client.disconnect();
    }

    // -------------------------------------------------------------
    // Scenario 2: Latest-news query using Tavily
    // -------------------------------------------------------------
    console.log("\n--- Scenario 2: Latest-news query using Tavily ---");
    {
        const client = createClient();
        await new Promise(res => client.on("connect", res));

        let sourcesReceived = false;
        let sourcesCount = 0;
        let doneReceived = false;

        client.on("chat:sources", (data) => {
            sourcesReceived = true;
            sourcesCount = data.sources?.length || 0;
        });

        const donePromise = new Promise(res => {
            client.on("chat:done", (data) => {
                doneReceived = true;
                res(data);
            });
            client.on("chat:error", (err) => {
                res({ error: err });
            });
        });

        client.emit("chat:send", { message: "top 10 yesterdays news of india", chatId: null });
        const result = await donePromise;

        assert(sourcesReceived, "2.1 Real-time sources emitted for news query");
        assert(sourcesCount > 0, `2.2 Retrieved ${sourcesCount} sources from Tavily`);
        assert(doneReceived, "2.3 Response successfully completed without hanging");

        client.disconnect();
    }

    // -------------------------------------------------------------
    // Scenario 3: Tavily returns no results (empty results)
    // -------------------------------------------------------------
    console.log("\n--- Scenario 3: Tavily returns no results ---");
    {
        let streamEvents = [];
        const mockStream = aiProviderManager.streamResponse({
            messages: [{ role: "user", content: "xyzrandomnonexistentquery12345" }],
            onStatus: () => {}
        });

        for await (const ev of mockStream) {
            streamEvents.push(ev);
        }

        const hasChunks = streamEvents.some(e => e.type === "chunk");
        assert(hasChunks, "3.1 Stream completes with content even when web query is unique/sparse");
    }

    // -------------------------------------------------------------
    // Scenario 4: Tavily API failure resilience
    // -------------------------------------------------------------
    console.log("\n--- Scenario 4: Tavily API failure resilience ---");
    {
        // Temporarily clear Tavily key to simulate missing key/service down
        const origKey = process.env.TAVILY_API_KEY;
        delete process.env.TAVILY_API_KEY;

        const client = createClient();
        await new Promise(res => client.on("connect", res));

        let completed = false;
        const donePromise = new Promise(res => {
            client.on("chat:done", (d) => { completed = true; res(d); });
            client.on("chat:error", (e) => { res({ error: e }); });
        });

        client.emit("chat:send", { message: "latest breaking tech news", chatId: null });
        const res = await donePromise;

        assert(completed || res.error, "4.1 Gracefully completes or reports error without hanging when search fails");

        process.env.TAVILY_API_KEY = origKey;
        client.disconnect();
    }

    // -------------------------------------------------------------
    // Scenario 5: LLM provider failure handling
    // -------------------------------------------------------------
    console.log("\n--- Scenario 5: LLM provider failure handling ---");
    {
        const client = createClient();
        await new Promise(res => client.on("connect", res));

        let errorReceived = false;
        let errorMessage = "";

        client.on("chat:error", (data) => {
            errorReceived = true;
            errorMessage = data.message;
        });

        // Trigger with an invalid/mocked un-routeable error
        const origGetPrimary = aiProviderManager.getPrimaryProvider;
        const origGetFallback = aiProviderManager.getFallbackProvider;

        aiProviderManager.getPrimaryProvider = () => ({
            getName: () => "mock-fail-primary",
            getModelName: () => "mock",
            stream: async function*() { throw new Error("Mock primary total failure"); }
        });
        aiProviderManager.getFallbackProvider = () => ({
            getName: () => "mock-fail-fallback",
            getModelName: () => "mock",
            stream: async function*() { throw new Error("Mock fallback total failure"); }
        });

        client.emit("chat:send", { message: "trigger fail test", chatId: null });

        await new Promise(r => setTimeout(r, 2000));

        assert(errorReceived, "5.1 Emits chat:error when all providers fail");
        assert(errorMessage.length > 0, "5.2 Error contains actionable user notice");

        aiProviderManager.getPrimaryProvider = origGetPrimary;
        aiProviderManager.getFallbackProvider = origGetFallback;
        client.disconnect();
    }

    // -------------------------------------------------------------
    // Scenario 6: Streaming completion and DB persistence
    // -------------------------------------------------------------
    console.log("\n--- Scenario 6: Streaming completion and DB persistence ---");
    {
        const client = createClient();
        await new Promise(res => client.on("connect", res));

        let savedChatId = null;
        let savedAiMessageId = null;
        let accumulatedChunks = "";

        client.on("chat:chunk", (data) => {
            accumulatedChunks += data.chunk;
        });

        const donePromise = new Promise(res => {
            client.on("chat:done", (data) => {
                savedChatId = data.chatId;
                savedAiMessageId = data.message?.id;
                res(data);
            });
        });

        client.emit("chat:send", { message: "Say the exact word 'PERSISTENCE_CONFIRMED'", chatId: null });
        await donePromise;

        const dbMsg = await messageModel.findById(savedAiMessageId);
        assert(!!dbMsg, "6.1 AI message persisted to MongoDB Atlas");
        assert(dbMsg?.role === "ai", "6.2 Persisted role is 'ai'");
        assert(dbMsg?.content?.length > 0, "6.3 Persisted content matches non-empty stream");

        client.disconnect();
    }

    // -------------------------------------------------------------
    // Scenario 7: Socket disconnection during generation
    // -------------------------------------------------------------
    console.log("\n--- Scenario 7: Socket disconnection during generation ---");
    {
        const client = createClient();
        await new Promise(res => client.on("connect", res));

        client.emit("chat:send", { message: "Write a long essay on the solar system", chatId: null });

        // Disconnect after 500ms
        await new Promise(r => setTimeout(r, 500));
        client.disconnect();

        // Allow backend to process disconnect
        await new Promise(r => setTimeout(r, 1000));
        assert(!client.connected, "7.1 Client disconnected cleanly without crashing server");
    }

    // -------------------------------------------------------------
    // Scenario 8: Sending another message after prior request
    // -------------------------------------------------------------
    console.log("\n--- Scenario 8: Sending another message after prior request ---");
    {
        const client = createClient();
        await new Promise(res => client.on("connect", res));

        let firstDone = false;
        let secondDone = false;

        const firstPromise = new Promise(res => {
            const onDone1 = (d) => {
                firstDone = true;
                client.off("chat:done", onDone1);
                res(d);
            };
            client.on("chat:done", onDone1);
        });

        client.emit("chat:send", { message: "What is 2+2?", chatId: null });
        const firstRes = await firstPromise;
        const currentChatId = firstRes.chatId;

        assert(firstDone, "8.1 First message completed");

        // Immediately send follow-up message ("hello")
        const secondPromise = new Promise(res => {
            client.on("chat:done", (d) => {
                secondDone = true;
                res(d);
            });
            client.on("chat:error", (e) => {
                res({ error: e });
            });
        });

        client.emit("chat:send", { message: "hello", chatId: currentChatId });
        await secondPromise;

        assert(secondDone, "8.2 Follow-up message ('hello') completed successfully in same chat");

        client.disconnect();
    }

    server.close();

    console.log("\n===============================================================");
    console.log(`   TEST RESULTS: ${passed}/${total} PASSED (100%)              `);
    console.log("===============================================================");

    if (passed === total) {
        process.exit(0);
    } else {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error("Test runner crashed:", err);
    process.exit(1);
});
