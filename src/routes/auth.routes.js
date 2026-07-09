import { Router } from 'express';
import {
  register,
  verifyOTP,
  login,
  refreshToken,
  logout,
} from '../controllers/auth.controller.js';
import { authLimiter } from '../middlewares/rateLimiter.js';

const router = Router();

// Client
router.post('/register', authLimiter, register);
router.post('/verify-otp', authLimiter, verifyOTP);
router.post('/login', authLimiter, login);
router.post('/refresh', refreshToken);
router.post('/logout', logout);


export default router;