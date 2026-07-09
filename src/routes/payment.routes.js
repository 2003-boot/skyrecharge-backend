import express from 'express';
import {
  initiateBabimoPayment,
  babimoWebhook,
  checkStatus,
  paymentSuccess,
  paymentFailed,
} from '../controllers/payment.controller.js';
import { authenticateUser } from '../middlewares/auth.js';

const router = express.Router();

// Routes protégées
router.post('/initiate', authenticateUser, initiateBabimoPayment);
router.get('/check/:payToken', authenticateUser, checkStatus);

// Routes publiques (webhook + redirections Wave)
router.post('/webhook', babimoWebhook);
router.get('/success', paymentSuccess);
router.get('/failed', paymentFailed);

export default router;