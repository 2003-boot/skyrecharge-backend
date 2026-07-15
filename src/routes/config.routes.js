import { Router } from 'express';
import { getPublicConfig } from '../controllers/config.controller.js';

const router = Router();

// Public — pas de authenticate*, ce endpoint ne renvoie rien de sensible.
router.get('/public', getPublicConfig);

export default router;