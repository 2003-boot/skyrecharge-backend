import { Router } from 'express';
import { getActiveFlyers } from '../controllers/flyer.controller.js';

const router = Router();

// Public -- pas de authenticate*, carrousel accueil mobile.
router.get('/', getActiveFlyers);

export default router;