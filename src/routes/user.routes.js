import { Router } from 'express';
import { updateProfile, registerPushToken, verifyPin } from '../controllers/user.controller.js';
import { authenticateUser } from '../middlewares/auth.js';
import { authLimiter } from '../middlewares/rateLimiter.js';

const router = Router();
router.patch('/profile', authenticateUser, authLimiter, updateProfile);
router.post('/push-token', authenticateUser, registerPushToken);
// authLimiter réutilisé ici : un PIN à 4 chiffres n'a que 10 000
// combinaisons possibles -- sans limite de tentatives, quelqu'un avec un
// token volé pourrait le retrouver en un temps raisonnable par simple
// brute-force. Même plafond que /auth/login (10 tentatives/15min), qui
// protège déjà l'autre endroit où un PIN est vérifié.
router.post('/verify-pin', authenticateUser, authLimiter, verifyPin);

export default router;