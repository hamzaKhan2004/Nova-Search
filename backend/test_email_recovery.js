import assert from "assert";
import nodemailer from "nodemailer";
import { sendEmail, getTransporter, resetTransporter, setTransporter } from "./src/services/mail.service.js";
import { executeConfirmedTool } from "./src/services/ai/tool.service.js";
import authRouter from "./src/routes/auth.routes.js";
import * as authController from "./src/controllers/auth.controller.js";
import userModel from "./src/models/user.model.js";
import jwt from "jsonwebtoken";

async function runRecoveryTests() {
  console.log("=== TEST 1: Nodemailer Service Configuration & Validation ===");
  
  // 1a. Missing 'to'
  try {
    await sendEmail({});
    assert.fail("Should fail on missing to");
  } catch (err) {
    assert(err.message.includes("Recipient email address (to) is required"));
    console.log("✓ Validation: Rejects missing recipient email");
  }

  // 1b. Missing 'subject'
  try {
    await sendEmail({ to: "test@example.com" });
    assert.fail("Should fail on missing subject");
  } catch (err) {
    assert(err.message.includes("Email subject line is required"));
    console.log("✓ Validation: Rejects missing subject");
  }

  // 1c. Missing content
  try {
    await sendEmail({ to: "test@example.com", subject: "Hello" });
    assert.fail("Should fail on missing content");
  } catch (err) {
    assert(err.message.includes("Email body content (html or text) is required"));
    console.log("✓ Validation: Rejects missing content");
  }

  // 1d. Unconfigured environment
  const origUser = process.env.GOOGLE_USER;
  const origClientId = process.env.GOOGLE_CLIENT_ID;
  const origSecret = process.env.GOOGLE_CLIENT_SECRET;
  const origRefresh = process.env.GOOGLE_REFRESH_TOKEN;
  const origPass = process.env.GOOGLE_APP_PASSWORD;

  delete process.env.GOOGLE_USER;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
  delete process.env.GOOGLE_APP_PASSWORD;

  try {
    await sendEmail({ to: "test@example.com", subject: "Hi", text: "Hello" });
    assert.fail("Should fail when unconfigured");
  } catch (err) {
    assert(err.message.includes("Email service is not configured"));
    console.log("✓ Validation: Rejects send attempt when unconfigured");
  }

  // 1e. OAuth2 Configuration check
  process.env.GOOGLE_USER = "sender@gmail.com";
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_REFRESH_TOKEN = "test-refresh-token";

  const oauthTransporter = getTransporter();
  assert(oauthTransporter, "Transporter created with OAuth2 credentials");
  console.log("✓ Config: Initializes OAuth2 transporter correctly");

  // 1f. App Password Configuration check
  process.env.GOOGLE_APP_PASSWORD = "abcd efgh ijkl mnop";
  const appPassTransporter = getTransporter();
  assert(appPassTransporter, "Transporter created with App Password credentials");
  console.log("✓ Config: Initializes Gmail App Password transporter correctly");

  // 1g. Mocked successful sendMail
  let sentMailOptions = null;
  setTransporter({
    sendMail: async (opts) => {
      sentMailOptions = opts;
      return { messageId: "<mock-msg-12345@gmail.com>" };
    },
    verify: async () => true
  });

  const sendResult = await sendEmail({
    to: "recipient@gmail.com",
    subject: "Welcome to Nova",
    html: "<p>Welcome</p>",
    text: "Welcome"
  });

  assert.strictEqual(sendResult.success, true);
  assert(sendResult.method === "nodemailer_smtp" || sendResult.method === "nodemailer_gmail");
  assert.strictEqual(sendResult.messageId, "<mock-msg-12345@gmail.com>");
  assert.strictEqual(sentMailOptions.to, "recipient@gmail.com");
  assert.strictEqual(sentMailOptions.subject, "Welcome to Nova");
  console.log("✓ Dispatch: Dispatches email through Nodemailer with correct options");

  // 1h. Mock invalid_grant error diagnostic
  setTransporter({
    sendMail: async () => {
      const err = new Error("invalid_grant: Bad Request");
      err.code = "EAUTH";
      throw err;
    },
    verify: async () => { throw new Error("invalid_grant: Bad Request"); }
  });

  try {
    await sendEmail({ to: "recipient@gmail.com", subject: "Test", text: "Test" });
    assert.fail("Should fail on invalid_grant");
  } catch (err) {
    assert(err.message.includes("Gmail authentication failed (invalid_grant)"));
    assert(err.message.includes("Testing"));
    console.log("✓ Error Handling: Catches invalid_grant and provides clear 7-day token diagnostic");
  }

  console.log("\n=== TEST 2: Signup & Verification Flows ===");
  // Mock working sendMail for auth tests
  setTransporter({
    sendMail: async () => ({ messageId: "<auth-test-id>" }),
    verify: async () => true
  });

  // 2a. Route registration
  const routes = [];
  authRouter.stack.forEach(layer => {
    if (layer.route) routes.push({ path: layer.route.path, methods: Object.keys(layer.route.methods) });
  });
  assert(routes.find(r => r.path === "/register"), "register route exists");
  assert(routes.find(r => r.path === "/login"), "login route exists");
  assert(routes.find(r => r.path === "/verify-email"), "verify-email route exists");
  assert(routes.find(r => r.path === "/resend-verification"), "resend-verification route exists");
  console.log("✓ Routes: All auth routes registered (register, login, verify-email, resend-verification)");

  // 2b. Resend Verification Endpoint tests
  let statusSent, jsonSent;
  const mockRes = {
    status: (s) => { statusSent = s; return mockRes; },
    json: (j) => { jsonSent = j; return mockRes; }
  };

  const origFindOne = userModel.findOne;
  
  // Anti-enumeration test
  userModel.findOne = async () => null;
  await authController.resendVerification({ body: { email: "nobody@example.com" }, headers: {} }, mockRes);
  assert.strictEqual(statusSent, 200);
  assert(jsonSent.message.includes("If an unverified account with this email exists"));
  console.log("✓ Resend: Anti-enumeration protection confirmed");

  // Rate limiting test
  await authController.resendVerification({ body: { email: "nobody@example.com" }, headers: {} }, mockRes);
  assert.strictEqual(statusSent, 429);
  assert(jsonSent.retryAfter > 0);
  console.log("✓ Resend: 60-second cooldown rate limit enforced");

  // Unverified user test
  userModel.findOne = async () => ({
    email: "unverified-user@example.com",
    username: "UnverifiedUser",
    verified: false
  });
  process.env.JWT_SECRET = "test_jwt_secret_12345";
  await authController.resendVerification({ body: { email: "unverified-user@example.com" }, headers: {} }, mockRes);
  assert.strictEqual(statusSent, 200);
  assert(jsonSent.message.includes("A new verification email has been sent"));
  console.log("✓ Resend: Successfully dispatches verification email to unverified user");

  // Already verified user test
  userModel.findOne = async () => ({
    email: "verified-user@example.com",
    username: "VerifiedUser",
    verified: true
  });
  await authController.resendVerification({ body: { email: "verified-user@example.com" }, headers: {} }, mockRes);
  assert.strictEqual(statusSent, 200);
  assert.strictEqual(jsonSent.alreadyVerified, true);
  console.log("✓ Resend: Informs already verified user");

  // 2c. Verify Email endpoint tests
  // Invalid token
  await authController.verifyEmail({ query: { token: "invalid_token" }, accepts: () => false }, mockRes);
  assert.strictEqual(statusSent, 400);
  assert.strictEqual(jsonSent.success, false);
  console.log("✓ VerifyEmail: Rejects invalid JWT token");

  // Expired token
  const expiredToken = jwt.sign({ email: "user@example.com" }, process.env.JWT_SECRET, { expiresIn: "0s" });
  await authController.verifyEmail({ query: { token: expiredToken }, accepts: () => false }, mockRes);
  assert.strictEqual(statusSent, 400);
  assert.strictEqual(jsonSent.expired, true);
  console.log("✓ VerifyEmail: Correctly identifies expired verification token");

  // Valid token & user save
  let savedUser = null;
  const validToken = jwt.sign({ email: "newbie@example.com" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  userModel.findOne = async () => ({
    email: "newbie@example.com",
    verified: false,
    save: async function() { savedUser = this; }
  });
  await authController.verifyEmail({ query: { token: validToken }, accepts: () => false }, mockRes);
  assert.strictEqual(statusSent, 200);
  assert.strictEqual(savedUser.verified, true);
  console.log("✓ VerifyEmail: Successfully validates token and marks user.verified = true");

  // 2d. Login restrictions for unverified user
  userModel.findOne = () => ({
    select: async () => ({
      email: "unverified@example.com",
      verified: false,
      comparePassword: async () => true
    })
  });
  await authController.login({ body: { email: "unverified@example.com", password: "password123" } }, mockRes);
  assert.strictEqual(statusSent, 403);
  assert.strictEqual(jsonSent.unverified, true);
  assert.strictEqual(jsonSent.err, "Email not verified");
  console.log("✓ Login: Enforces 403 Forbidden with unverified: true for unverified accounts");

  console.log("\n=== TEST 3: Email Agent Tool Execution ===");
  const agentResult = await executeConfirmedTool("sendEmail", {
    to: "colleague@example.com",
    subject: "Meeting Notes",
    body: "Here are the minutes of the meeting."
  });
  assert.strictEqual(agentResult.success, true);
  assert(agentResult.message.includes("colleague@example.com"));
  console.log("✓ Email Agent: executeConfirmedTool dispatches successfully through Nodemailer");

  // Cleanup
  userModel.findOne = origFindOne;
  resetTransporter();
  if (origUser) process.env.GOOGLE_USER = origUser;
  if (origClientId) process.env.GOOGLE_CLIENT_ID = origClientId;
  if (origSecret) process.env.GOOGLE_CLIENT_SECRET = origSecret;
  if (origRefresh) process.env.GOOGLE_REFRESH_TOKEN = origRefresh;
  if (origPass) process.env.GOOGLE_APP_PASSWORD = origPass;

  console.log("\n======================================================");
  console.log("ALL RECOVERY VERIFICATION SUITE TESTS PASSED (100%)!");
  console.log("======================================================");
}

runRecoveryTests().catch(e => {
  console.error("Test suite failed:", e);
  process.exit(1);
});
