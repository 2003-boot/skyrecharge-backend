import { Router } from 'express';
import { updateProfile } from '../controllers/user.controller.js';
import { authenticateUser } from '../middlewares/auth.js';

const router = Router();
router.patch('/profile', authenticateUser, updateProfile);

export default router;