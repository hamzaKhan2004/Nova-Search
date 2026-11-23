import nodemailer from "nodemailer";

/**
 * Nova Search - Email Service
 * High-reliability transactional email dispatch using Nodemailer with Gmail.
 * Supports:
 *   1. Google OAuth2 (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)
 *   2. Gmail App Password (GOOGLE_APP_PASSWORD / GMAIL_APP_PASSWORD)
 * 
 * Shared across:
 *   - User Registration Email Verification (auth.controller.js)
 *   - Resend Verification Link (auth.controller.js)
 *   - Interactive Email Agent (tool.service.js -> server.socket.js)
 */

function createTransporterConfig() {
    const user = process.env.GOOGLE_USER;
    const appPassword = process.env.GOOGLE_APP_PASSWORD || process.env.GMAIL_APP_PASSWORD;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!user) {
        return null;
    }

    // 1. Support Gmail App Password (reliable fallback that avoids 7-day OAuth token expirations)
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

    // 2. Google OAuth2 configuration
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

/**
 * Reset cached transporter (useful for testing or config reloads)
 */
export function resetTransporter() {
    cachedTransporter = null;
    lastConfigSignature = "";
}

/**
 * Set custom transporter (useful for testing)
 */
export function setTransporter(transporter) {
    cachedTransporter = transporter;
    lastConfigSignature = "custom";
}

/**
 * Get or initialize Nodemailer transporter
 */
export function getTransporter() {
    if (cachedTransporter && lastConfigSignature === "custom") {
        return cachedTransporter;
    }

    const config = createTransporterConfig();
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
 * Non-blocking transporter verification check
 */
export async function verifyEmailTransporter() {
    const transporter = getTransporter();
    if (!transporter) {
        console.warn("[MAIL] Email service notice: Nodemailer transporter not configured (missing GOOGLE_USER or auth credentials).");
        return { success: false, error: "Unconfigured" };
    }

    try {
        await transporter.verify();
        console.log("[MAIL] Email transporter is ready to send emails (Gmail/Nodemailer)");
        return { success: true };
    } catch (err) {
        const errMsg = err.message || "";
        if (errMsg.includes("invalid_grant") || err.code === "EAUTH") {
            console.error(
                "[MAIL] Gmail OAuth2 authentication failed with 'invalid_grant'.\n" +
                "Diagnostic details:\n" +
                "  1. Refresh Token Expiry: If your Google Cloud OAuth Consent Screen is in 'Testing' mode, refresh tokens expire automatically after 7 days.\n" +
                "  2. Credentials Mismatch: The refresh token may have been generated with different Client ID / Secret.\n" +
                "Fix: Regenerate the refresh token in Google OAuth Playground with your custom client credentials, publish your app to 'In production' in Google Cloud Console, or configure GOOGLE_APP_PASSWORD."
            );
        } else {
            console.warn("[MAIL] Email transporter verification notice:", errMsg);
        }
        return { success: false, error: errMsg };
    }
}

// Non-blocking verification on module load if credentials exist
if (process.env.GOOGLE_USER) {
    verifyEmailTransporter().catch(() => {});
}

/**
 * Shared email dispatch function
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

    const transporter = getTransporter();
    if (!transporter) {
        throw new Error(
            "Email service is not configured: Please configure GOOGLE_USER and either Google OAuth2 credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN) or GOOGLE_APP_PASSWORD in your environment variables."
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
        console.log(`[MAIL] Email sent successfully via Nodemailer (Message ID: ${info.messageId})`);
        return {
            success: true,
            method: "nodemailer_gmail",
            messageId: info.messageId
        };
    } catch (err) {
        console.error("[MAIL] Nodemailer dispatch failed:", err.message);
        const errMsg = err.message || "";
        if (errMsg.includes("invalid_grant") || err.code === "EAUTH") {
            throw new Error(
                "Gmail authentication failed (invalid_grant): Your Google OAuth2 refresh token is expired or revoked. Google Cloud apps in 'Testing' mode expire tokens after 7 days. Please regenerate the refresh token in Google OAuth Playground or configure GOOGLE_APP_PASSWORD."
            );
        }
        throw new Error(`Email delivery failed via Nodemailer: ${err.message}`);
    }
}
