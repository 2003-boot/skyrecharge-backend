import { Router } from 'express';
import { updateProfile, registerPushToken, verifyPin } from '../controllers/user.controller.js';
import { authenticateUser } from '../middlewares/auth.js';

const router = Router();
router.patch('/profile', authenticateUser, updateProfile);
router.post('/push-token', authenticateUser, registerPushToken);
router.post('/verify-pin', authenticateUser, verifyPin);

export default router;