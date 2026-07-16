import { Router } from 'express';
import {
  register,
  verifyOTP,
  login,
  adminLogin,
  refreshToken,
  logout,
  sendRecoveryOTP,
} from '../controllers/auth.controller.js';
import { authLimiter } from '../middlewares/rateLimiter.js';

const router = Router();

// Client
router.post('/register', authLimiter, register);
router.post('/verify-otp', authLimiter, verifyOTP);
router.post('/login', authLimiter, login);
router.post('/recover-otp', authLimiter, sendRecoveryOTP);
router.post('/refresh', refreshToken);
router.post('/logout', logout);

// Admin
router.post('/admin/login', authLimiter, adminLogin);

export default router;