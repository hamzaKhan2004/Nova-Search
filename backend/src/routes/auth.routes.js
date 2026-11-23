import { Router } from "express";
import { getMe, login, logout, register, verifyEmail, resendVerification } from "../controllers/auth.controller.js";
import { loginValidator, registerValidationRules, resendVerificationValidator } from "../validator/auth.validation.js";
import { authUser } from "../middlewares/auth.middlewares.js";

const authRouter = Router();

authRouter.post(
    "/register",
    registerValidationRules,
    register
);

authRouter.post("/login", loginValidator, login);
authRouter.post("/logout", logout);
authRouter.get("/get-me", authUser, getMe);
authRouter.get("/verify-email", verifyEmail);
authRouter.post("/resend-verification", resendVerificationValidator, resendVerification);

export default authRouter;