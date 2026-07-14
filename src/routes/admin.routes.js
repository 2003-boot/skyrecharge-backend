import { Router } from 'express';
import {
  getStats,
  getBalances,
  getRecentOrders,
  getUsersCount,
  sendMessage,
  getMessagesHistory,
  createTransfer,
  getTransfersHistory,
  transferWebhook,
} from '../controllers/admin.controller.js';
import { authenticateAdmin } from '../middlewares/auth.js';

const router = Router();

// Public — appelé par Babimo, doit rester AVANT authenticateAdmin ci-dessous
router.post('/transfers/webhook', transferWebhook);

router.use(authenticateAdmin);

// Dashboard
router.get('/stats', getStats);
router.get('/balances', getBalances);
router.get('/orders/recent', getRecentOrders);
router.get('/users/count', getUsersCount);

// Messages HSMS
router.post('/messages', sendMessage);
router.get('/messages/history', getMessagesHistory);

// Transferts fournisseurs (cashin Babimo)
router.post('/transfers', createTransfer);
router.get('/transfers/history', getTransfersHistory);

export default router;