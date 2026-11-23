import assert from "assert";
import nodemailer from "nodemailer";
import {
    sendEmail,
    getMailTransportType,
    getTransporter,
    resetTransporter,
    setTransporter,
    getGoogleAccessToken,
    resetTokenCache,
    setCachedAccessToken,
    buildMimeMessage,
    sendViaGmailApi,
    sendViaSmtp
} from "./src/services/mail.service.js";
import { executeConfirmedTool } from "./src/services/ai/tool.service.js";
import authRouter from "./src/routes/auth.routes.js";
import * as authController from "./src/controllers/auth.controller.js";
import userModel from "./src/models/user.model.js";
import jwt from "jsonwebtoken";

async function runTransportSuite() {
    console.log("===============================================================");
    console.log("   NOVA SEARCH - EMAIL TRANSPORT SUITE (SMTP + GMAIL API)      ");
    console.log("===============================================================\n");

    const origEnv = { ...process.env };
    const originalFetch = global.fetch;

    try {
        // -------------------------------------------------------------
        // SECTION 1: Parameter Validation & Transport Selection
        // -------------------------------------------------------------
        console.log("--- 1. Parameter Validation & Transport Selection ---");

        // 1a. Missing 'to'
        try {
            await sendEmail({});
            assert.fail("Should have failed on missing recipient");
        } catch (err) {
            assert(err.message.includes("Recipient email address (to) is required"));
            console.log("✓ Rejects missing recipient email address");
        }

        // 1b. Missing 'subject'
        try {
            await sendEmail({ to: "user@example.com" });
            assert.fail("Should have failed on missing subject");
        } catch (err) {
            assert(err.message.includes("Email subject line is required"));
            console.log("✓ Rejects missing subject");
        }

        // 1c. Missing body
        try {
            await sendEmail({ to: "user@example.com", subject: "Test" });
            assert.fail("Should have failed on missing body");
        } catch (err) {
            assert(err.message.includes("Email body content (html or text) is required"));
            console.log("✓ Rejects missing body content");
        }

        // 1d. Transport selection
        process.env.MAIL_TRANSPORT = "smtp";
        assert.strictEqual(getMailTransportType(), "smtp");
        console.log("✓ Correctly selects 'smtp' when MAIL_TRANSPORT=smtp");

        process.env.MAIL_TRANSPORT = "gmail-api";
        assert.strictEqual(getMailTransportType(), "gmail-api");
        console.log("✓ Correctly selects 'gmail-api' when MAIL_TRANSPORT=gmail-api");

        // Auto-detection when MAIL_TRANSPORT is not set
        delete process.env.MAIL_TRANSPORT;
        process.env.RENDER = "true";
        assert.strictEqual(getMailTransportType(), "gmail-api");
        console.log("✓ Auto-detects 'gmail-api' on Render environment");
        delete process.env.RENDER;

        // -------------------------------------------------------------
        // SECTION 2: Local SMTP Transport Verification (Port 465)
        // -------------------------------------------------------------
        console.log("\n--- 2. Local SMTP Transport Verification (MAIL_TRANSPORT=smtp) ---");
        process.env.MAIL_TRANSPORT = "smtp";
        process.env.GOOGLE_USER = "localdev@gmail.com";
        process.env.GOOGLE_APP_PASSWORD = "abcd efgh ijkl mnop";

        let smtpMailSent = null;
        setTransporter({
            sendMail: async (opts) => {
                smtpMailSent = opts;
                return { messageId: "<local-smtp-msg-12345@gmail.com>" };
            },
            verify: async () => true
        });

        const smtpResult = await sendEmail({
            to: "client@example.com",
            subject: "Local SMTP Test",
            html: "<p>Local SMTP works</p>",
            text: "Local SMTP works"
        });

        assert.strictEqual(smtpResult.success, true);
        assert.strictEqual(smtpResult.method, "nodemailer_smtp");
        assert.strictEqual(smtpResult.messageId, "<local-smtp-msg-12345@gmail.com>");
        assert.strictEqual(smtpMailSent.to, "client@example.com");
        assert.strictEqual(smtpMailSent.subject, "Local SMTP Test");
        console.log("✓ Local SMTP dispatches successfully using GOOGLE_APP_PASSWORD");

        // -------------------------------------------------------------
        // SECTION 3: Gmail REST API over HTTPS (Port 443)
        // -------------------------------------------------------------
        console.log("\n--- 3. Gmail REST API Transport (MAIL_TRANSPORT=gmail-api) ---");
        process.env.MAIL_TRANSPORT = "gmail-api";
        process.env.GOOGLE_USER = "renderuser@gmail.com";
        process.env.GOOGLE_CLIENT_ID = "mock-client-id-123.apps.googleusercontent.com";
        process.env.GOOGLE_CLIENT_SECRET = "mock-client-secret-456";
        process.env.GOOGLE_REFRESH_TOKEN = "mock-refresh-token-789";
        resetTokenCache();

        // 3a. Test MIME construction using streamTransport
        const mimeRaw = await buildMimeMessage({
            from: "renderuser@gmail.com",
            to: "recipient@example.com",
            subject: "MIME Generation Test",
            html: "<p>Testing MIME stream</p>",
            text: "Testing MIME stream"
        });
        assert(typeof mimeRaw === "string", "MIME message is a base64url string");
        assert(mimeRaw.length > 50, "MIME message has substantial length");
        const decodedMime = Buffer.from(mimeRaw, "base64url").toString("utf-8");
        assert(decodedMime.includes("MIME Generation Test"), "Decoded MIME contains subject");
        assert(decodedMime.includes("recipient@example.com"), "Decoded MIME contains recipient");
        console.log("✓ Built RFC 2822 MIME message cleanly via Nodemailer streamTransport (base64url)");

        // 3b. Test Token Exchange & In-Memory Caching
        let tokenFetchCalls = 0;
        let gmailApiFetchCalls = 0;
        let lastApiPayload = null;

        global.fetch = async (url, options) => {
            if (url.includes("oauth2.googleapis.com/token")) {
                tokenFetchCalls++;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        access_token: "mock-access-token-xyz",
                        expires_in: 3600,
                        token_type: "Bearer"
                    })
                };
            }

            if (url.includes("gmail.googleapis.com/gmail/v1/users/me/messages/send")) {
                gmailApiFetchCalls++;
                lastApiPayload = JSON.parse(options.body);
                assert.strictEqual(options.headers["Authorization"], "Bearer mock-access-token-xyz");
                assert.strictEqual(options.headers["Content-Type"], "application/json");
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        id: "mock_gmail_msg_id_99999",
                        threadId: "mock_thread_id_88888"
                    })
                };
            }

            throw new Error(`Unexpected fetch URL: ${url}`);
        };

        // Dispatch 1: Should fetch token and send email
        const apiResult1 = await sendEmail({
            to: "user1@example.com",
            subject: "Verification 1",
            html: "<b>Verify 1</b>",
            text: "Verify 1"
        });

        assert.strictEqual(apiResult1.success, true);
        assert.strictEqual(apiResult1.method, "gmail_api_https");
        assert.strictEqual(apiResult1.messageId, "mock_gmail_msg_id_99999");
        assert.strictEqual(tokenFetchCalls, 1, "Token endpoint called on first dispatch");
        assert.strictEqual(gmailApiFetchCalls, 1, "Gmail API called on first dispatch");
        assert(typeof lastApiPayload.raw === "string", "Payload sent to Gmail API has raw property");
        console.log("✓ First dispatch fetches OAuth token and sends via Gmail REST API (HTTPS port 443)");

        // Dispatch 2: Should REUSE cached access token without calling token endpoint again
        const apiResult2 = await sendEmail({
            to: "user2@example.com",
            subject: "Verification 2",
            html: "<b>Verify 2</b>",
            text: "Verify 2"
        });

        assert.strictEqual(apiResult2.success, true);
        assert.strictEqual(tokenFetchCalls, 1, "Token endpoint was NOT called again due to in-memory caching");
        assert.strictEqual(gmailApiFetchCalls, 2, "Gmail API called for second message");
        console.log("✓ In-memory access token cache reused successfully without duplicate HTTP calls");

        // 3c. Test Failed Authentication Handling (invalid_grant)
        resetTokenCache();
        global.fetch = async (url) => {
            if (url.includes("oauth2.googleapis.com/token")) {
                return {
                    ok: false,
                    status: 400,
                    json: async () => ({
                        error: "invalid_grant",
                        error_description: "Token has been expired or revoked."
                    })
                };
            }
            throw new Error(`Unexpected URL: ${url}`);
        };

        try {
            await sendEmail({
                to: "fail@example.com",
                subject: "Should Fail",
                text: "Should Fail"
            });
            assert.fail("Should have thrown invalid_grant error");
        } catch (err) {
            assert(err.message.includes("invalid_grant"), "Error message contains invalid_grant");
            assert(err.message.includes("expired, revoked, or invalid"), "Error message contains diagnostic guidance");
            console.log("✓ Correctly catches invalid_grant and fails loudly with diagnostic without silent fallback to SMTP");
        }

        // 3d. Test Gmail API Error Response (e.g. 403 quota exceeded)
        setCachedAccessToken("mock-valid-token", 3600000);
        global.fetch = async (url) => {
            if (url.includes("gmail.googleapis.com")) {
                return {
                    ok: false,
                    status: 403,
                    json: async () => ({
                        error: {
                            code: 403,
                            message: "User rate limit exceeded",
                            status: "RESOURCE_EXHAUSTED"
                        }
                    })
                };
            }
            throw new Error(`Unexpected URL: ${url}`);
        };

        try {
            await sendEmail({
                to: "quota@example.com",
                subject: "Quota Test",
                text: "Quota Test"
            });
            assert.fail("Should have thrown Gmail API error");
        } catch (err) {
            assert(err.message.includes("User rate limit exceeded"), "Captures Google API error message");
            console.log("✓ Correctly surfaces Gmail REST API error responses (403/400) directly");
        }

        // -------------------------------------------------------------
        // SECTION 4: Integration with Signup & Resend Verification
        // -------------------------------------------------------------
        console.log("\n--- 4. Integration with Auth Controller & Verification Flows ---");
        // Mock successful Gmail API dispatch for auth tests
        setCachedAccessToken("mock-token", 3600000);
        global.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ id: "auth_verification_id_555" })
        });

        // 4a. Resend Verification Endpoint tests
        let statusSent, jsonSent;
        const mockRes = {
            status: (s) => { statusSent = s; return mockRes; },
            json: (j) => { jsonSent = j; return mockRes; }
        };

        const origFindOne = userModel.findOne;

        // Anti-enumeration test
        userModel.findOne = async () => null;
        await authController.resendVerification({ body: { email: "ghost@example.com" }, headers: {} }, mockRes);
        assert.strictEqual(statusSent, 200);
        assert(jsonSent.message.includes("If an unverified account with this email exists"));
        console.log("✓ Resend verification: Anti-enumeration protection confirmed");

        // Rate limiting test
        await authController.resendVerification({ body: { email: "ghost@example.com" }, headers: {} }, mockRes);
        assert.strictEqual(statusSent, 429);
        assert(jsonSent.retryAfter > 0);
        console.log("✓ Resend verification: 60-second cooldown rate limit enforced");

        // Unverified user registration dispatch
        userModel.findOne = async () => ({
            email: "unverified@example.com",
            username: "UnverifiedUser",
            verified: false
        });
        process.env.JWT_SECRET = "suite_jwt_secret_test";
        await authController.resendVerification({ body: { email: "unverified@example.com" }, headers: {} }, mockRes);
        assert.strictEqual(statusSent, 200);
        assert(jsonSent.message.includes("A new verification email has been sent"));
        console.log("✓ Resend verification: Successfully dispatched verification link via Gmail API");

        // 4b. Verify Email Endpoint (Token validation)
        const validToken = jwt.sign({ email: "newbie@example.com" }, process.env.JWT_SECRET, { expiresIn: "1h" });
        let savedUser = null;
        userModel.findOne = async () => ({
            email: "newbie@example.com",
            verified: false,
            save: async function () { savedUser = this; }
        });
        await authController.verifyEmail({ query: { token: validToken }, accepts: () => false }, mockRes);
        assert.strictEqual(statusSent, 200);
        assert.strictEqual(savedUser.verified, true);
        console.log("✓ Verify email: Validates JWT token and marks account verified: true");

        // 4c. Login Restriction
        userModel.findOne = () => ({
            select: async () => ({
                email: "unverified@example.com",
                verified: false,
                comparePassword: async () => true
            })
        });
        await authController.login({ body: { email: "unverified@example.com", password: "pwd" } }, mockRes);
        assert.strictEqual(statusSent, 403);
        assert.strictEqual(jsonSent.unverified, true);
        console.log("✓ Login: Blocks unverified accounts with HTTP 403 Forbidden");

        userModel.findOne = origFindOne;

        // -------------------------------------------------------------
        // SECTION 5: Integration with Email Agent
        // -------------------------------------------------------------
        console.log("\n--- 5. Integration with Email Agent ---");
        const agentResult = await executeConfirmedTool("sendEmail", {
            to: "client@company.com",
            subject: "Project Deployment",
            body: "The deployment on Render is complete."
        });

        assert.strictEqual(agentResult.success, true);
        assert(agentResult.message.includes("client@company.com"));
        console.log("✓ Email Agent: executeConfirmedTool dispatches successfully through Gmail REST API");

        console.log("\n===============================================================");
        console.log("   ALL 15 DUAL-TRANSPORT TESTS PASSED SUCCESSFULLY (100%)       ");
        console.log("===============================================================");
    } finally {
        global.fetch = originalFetch;
        process.env = origEnv;
    }
}

runTransportSuite().catch((err) => {
    console.error("Test Suite Failed:", err);
    process.exit(1);
});
