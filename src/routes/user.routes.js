import { Router } from 'express';
import { updateProfile, registerPushToken } from '../controllers/user.controller.js';
import { authenticateUser } from '../middlewares/auth.js';

const router = Router();
router.patch('/profile', authenticateUser, updateProfile);
router.post('/push-token', authenticateUser, registerPushToken);

export default router;