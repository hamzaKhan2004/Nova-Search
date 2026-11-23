import nodemailer from "nodemailer";

/**
 * Nova Search - Email Service
 * High-reliability transactional email dispatch supporting:
 *   1. Gmail REST API over HTTPS Port 443 (MAIL_TRANSPORT=gmail-api - Recommended for Render)
 *   2. Nodemailer SMTP (MAIL_TRANSPORT=smtp - Recommended for local development with GOOGLE_APP_PASSWORD)
 * 
 * Shared across:
 *   - User Registration Email Verification (auth.controller.js)
 *   - Resend Verification Link (auth.controller.js)
 *   - Interactive Email Agent (tool.service.js -> server.socket.js)
 */

// ==========================================
// 1. Transport Resolution
// ==========================================

export function getMailTransportType() {
    const explicit = (process.env.MAIL_TRANSPORT || "").toLowerCase().trim();
    if (explicit === "gmail-api") {
        return "gmail-api";
    }
    if (explicit === "smtp") {
        return "smtp";
    }
    // Intelligent fallback if MAIL_TRANSPORT is omitted:
    // If running on Render or if OAuth credentials exist without an App Password, default to gmail-api
    if (
        process.env.RENDER ||
        (process.env.GOOGLE_CLIENT_ID &&
            process.env.GOOGLE_CLIENT_SECRET &&
            process.env.GOOGLE_REFRESH_TOKEN &&
            !process.env.GOOGLE_APP_PASSWORD)
    ) {
        return "gmail-api";
    }
    return "smtp";
}

// ==========================================
// 2. Gmail REST API over HTTPS (Port 443)
// ==========================================

let cachedAccessToken = null;
let accessTokenExpiresAt = 0; // timestamp in ms

/**
 * Reset token cache (useful for testing or key rotation)
 */
export function resetTokenCache() {
    cachedAccessToken = null;
    accessTokenExpiresAt = 0;
}

/**
 * Set token cache explicitly (useful for unit tests)
 */
export function setCachedAccessToken(token, expiresInMs = 3600000) {
    cachedAccessToken = token;
    accessTokenExpiresAt = Date.now() + expiresInMs;
}

/**
 * Acquire fresh Google OAuth2 access token with in-memory caching
 */
export async function getGoogleAccessToken() {
    // Return cached token if valid (with 5-minute safety buffer)
    if (cachedAccessToken && Date.now() < accessTokenExpiresAt) {
        return cachedAccessToken;
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error(
            "Gmail REST API requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in environment variables."
        );
    }

    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token"
    });

    let res;
    try {
        res = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString()
        });
    } catch (networkErr) {
        throw new Error(`Google OAuth2 token request failed: ${networkErr.message}`);
    }

    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }

    if (!res.ok || data?.error) {
        const errorType = data?.error || `HTTP ${res.status}`;
        const errorDesc = data?.error_description || res.statusText || "Unknown OAuth error";

        if (errorType === "invalid_grant" || errorDesc.includes("invalid_grant")) {
            console.error(
                "[MAIL] Google OAuth2 authentication failed with 'invalid_grant'.\n" +
                "Diagnostic details:\n" +
                "  1. Refresh Token Expiry: If your Google Cloud OAuth Consent Screen is in 'Testing' mode, refresh tokens expire automatically after 7 days.\n" +
                "  2. Credentials Mismatch: The refresh token may have been generated with different Client ID / Secret.\n" +
                "Fix: In Google Cloud Console, set Publishing status to 'In production', then regenerate your refresh token in Google OAuth Playground."
            );
            throw new Error(
                "Gmail API authentication failed (invalid_grant): Google OAuth2 refresh token is expired, revoked, or invalid. Please publish your Google Cloud OAuth app to 'In production' and regenerate GOOGLE_REFRESH_TOKEN."
            );
        }

        throw new Error(`Google OAuth2 token request failed (${errorType}): ${errorDesc}`);
    }

    if (!data?.access_token) {
        throw new Error("Google OAuth2 response did not contain an access_token");
    }

    const expiresInSec = data.expires_in || 3600;
    const safetyBufferSec = Math.min(300, Math.floor(expiresInSec / 2));
    cachedAccessToken = data.access_token;
    accessTokenExpiresAt = Date.now() + (expiresInSec - safetyBufferSec) * 1000;

    return cachedAccessToken;
}

/**
 * Build RFC 2822 MIME raw message using Nodemailer's built-in streamTransport
 * Avoids fragile internal imports that change across Nodemailer major versions.
 */
export async function buildMimeMessage(mailOptions) {
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const { message } = await builder.sendMail(mailOptions);
    return message.toString("base64url");
}

/**
 * Send email via Gmail REST API over HTTPS (Port 443 - Never blocked on Render Free)
 */
export async function sendViaGmailApi({ to, subject, html, text }) {
    const senderUser = process.env.GOOGLE_USER;
    if (!senderUser) {
        throw new Error("Sender email address (GOOGLE_USER) is required in environment variables.");
    }

    const accessToken = await getGoogleAccessToken();
    const fromAddress = process.env.MAIL_FROM || `Nova Search <${senderUser}>`;
    const toRecipients = Array.isArray(to) ? to.join(", ") : to.trim();

    const mailOptions = {
        from: fromAddress,
        to: toRecipients,
        subject: subject.trim(),
        html,
        text
    };

    const raw = await buildMimeMessage(mailOptions);

    let res;
    try {
        res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ raw })
        });
    } catch (networkErr) {
        throw new Error(`Gmail REST API network request failed: ${networkErr.message}`);
    }

    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }

    if (!res.ok || data?.error) {
        const errorDetail =
            data?.error?.message ||
            data?.message ||
            `Gmail API error (status ${res.status})`;
        console.error("[MAIL] Gmail REST API error:", errorDetail);
        throw new Error(`Email delivery failed via Gmail REST API: ${errorDetail}`);
    }

    if (!data?.id) {
        throw new Error("Gmail REST API response did not contain a message ID");
    }

    console.log(`[MAIL] Email sent successfully via Gmail REST API (HTTPS Port 443, Message ID: ${data.id})`);
    return {
        success: true,
        method: "gmail_api_https",
        messageId: data.id
    };
}

// ==========================================
// 3. Nodemailer SMTP (Port 465)
// ==========================================

function createSmtpConfig() {
    const user = process.env.GOOGLE_USER;
    const appPassword = process.env.GOOGLE_APP_PASSWORD || process.env.GMAIL_APP_PASSWORD;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!user) {
        return null;
    }

    // 1. Prefer App Password for local development
    if (appPassword) {
        return {
            service: "gmail",
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 15000,
            auth: {
                user,
                pass: appPassword.replace(/\s+/g, "")
            }
        };
    }

    // 2. Fallback to OAuth2 over SMTP
    if (clientId && clientSecret && refreshToken) {
        return {
            service: "gmail",
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 15000,
            auth: {
                type: "OAuth2",
                user,
                clientId,
                clientSecret,
                refreshToken
            }
        };
    }

    return null;
}

let cachedTransporter = null;
let lastConfigSignature = "";

export function resetTransporter() {
    cachedTransporter = null;
    lastConfigSignature = "";
}

export function setTransporter(transporter) {
    cachedTransporter = transporter;
    lastConfigSignature = "custom";
}

export function getTransporter() {
    if (cachedTransporter && lastConfigSignature === "custom") {
        return cachedTransporter;
    }

    const config = createSmtpConfig();
    if (!config) {
        return null;
    }

    const signature = JSON.stringify(config);

    if (!cachedTransporter || lastConfigSignature !== signature) {
        cachedTransporter = nodemailer.createTransport(config);
        lastConfigSignature = signature;
    }

    return cachedTransporter;
}

/**
 * Send email via Nodemailer SMTP (Port 465)
 */
export async function sendViaSmtp({ to, subject, html, text }) {
    const transporter = getTransporter();
    if (!transporter) {
        throw new Error(
            "Email service is not configured: Please configure GOOGLE_USER and either GOOGLE_APP_PASSWORD or Google OAuth2 credentials in your environment variables."
        );
    }

    const senderUser = process.env.GOOGLE_USER;
    const fromAddress = process.env.MAIL_FROM || `Nova Search <${senderUser}>`;
    const toRecipients = Array.isArray(to) ? to.join(", ") : to.trim();

    const mailOptions = {
        from: fromAddress,
        to: toRecipients,
        subject: subject.trim(),
        html,
        text
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`[MAIL] Email sent successfully via Nodemailer SMTP (Message ID: ${info.messageId})`);
        return {
            success: true,
            method: "nodemailer_smtp",
            messageId: info.messageId
        };
    } catch (err) {
        console.error("[MAIL] Nodemailer SMTP dispatch failed:", err.message);
        const errMsg = err.message || "";
        if (errMsg.includes("invalid_grant") || err.code === "EAUTH") {
            throw new Error(
                "Gmail authentication failed (invalid_grant): Your Google OAuth2 refresh token is expired or revoked. Google Cloud apps in 'Testing' mode expire tokens after 7 days. Please regenerate the refresh token in Google OAuth Playground or configure GOOGLE_APP_PASSWORD."
            );
        }
        throw new Error(`Email delivery failed via Nodemailer SMTP: ${err.message}`);
    }
}

// ==========================================
// 4. Verification Check
// ==========================================

export async function verifyEmailTransporter() {
    const transportType = getMailTransportType();
    if (transportType === "gmail-api") {
        if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
            console.warn("[MAIL] Gmail REST API notice: Missing OAuth2 credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN).");
            return { success: false, error: "Unconfigured" };
        }
        try {
            await getGoogleAccessToken();
            console.log("[MAIL] Email service is ready using Gmail REST API (HTTPS Port 443)");
            return { success: true };
        } catch (err) {
            console.warn("[MAIL] Gmail REST API token notice:", err.message);
            return { success: false, error: err.message };
        }
    }

    const transporter = getTransporter();
    if (!transporter) {
        console.warn("[MAIL] SMTP transporter notice: Not configured (missing GOOGLE_USER or auth credentials).");
        return { success: false, error: "Unconfigured" };
    }

    try {
        await transporter.verify();
        console.log("[MAIL] Email transporter is ready to send emails (SMTP Port 465)");
        return { success: true };
    } catch (err) {
        console.warn("[MAIL] SMTP transporter verification notice:", err.message);
        return { success: false, error: err.message };
    }
}

// Non-blocking verification on module load if credentials exist
if (process.env.GOOGLE_USER) {
    verifyEmailTransporter().catch(() => {});
}

// ==========================================
// 5. Main Public Entry Point
// ==========================================

/**
 * Shared email dispatch function
 * Used by:
 *   - auth.controller.js (register verification & resend-verification)
 *   - tool.service.js (Email Agent executeConfirmedTool)
 * 
 * @param {Object} options
 * @param {string|string[]} options.to - Recipient email address(es)
 * @param {string} options.subject - Email subject line
 * @param {string} [options.html] - HTML formatted email body
 * @param {string} [options.text] - Plain text email body
 * @returns {Promise<{success: boolean, method: string, messageId: string}>}
 */
export async function sendEmail({ to, subject, html, text }) {
    if (!to || (typeof to === "string" && !to.trim())) {
        throw new Error("Recipient email address (to) is required");
    }
    if (!subject || (typeof subject === "string" && !subject.trim())) {
        throw new Error("Email subject line is required");
    }
    if (!html && !text) {
        throw new Error("Email body content (html or text) is required");
    }

    const transportType = getMailTransportType();

    // 1. Gmail REST API over HTTPS (Port 443)
    if (transportType === "gmail-api") {
        return await sendViaGmailApi({ to, subject, html, text });
    }

    // 2. Nodemailer SMTP (Port 465)
    return await sendViaSmtp({ to, subject, html, text });
}
