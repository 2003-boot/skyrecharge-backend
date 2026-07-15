import { Router } from 'express';
import {
  getStats,
  getTimeseries,
  getBalances,
  getRecentOrders,
  getUsersCount,
  sendMessage,
  getMessagesHistory,
  sendPushNotification,
  createTransfer,
  getTransfersHistory,
  transferWebhook,
  exportOrdersCSV,
  getMaintenanceMode,
  setMaintenanceMode,
  getBlockedOperators,
  setOperatorBlocked,
} from '../controllers/admin.controller.js';
import {
  getAllFlyers,
  createFlyer,
  updateFlyer,
  deleteFlyer,
} from '../controllers/flyer.controller.js';
import { authenticateAdmin } from '../middlewares/auth.js';

const router = Router();

// Public — appelé par Babimo, doit rester AVANT authenticateAdmin ci-dessous
router.post('/transfers/webhook', transferWebhook);

router.use(authenticateAdmin);

// Dashboard
router.get('/stats', getStats);
router.get('/stats/timeseries', getTimeseries);
router.get('/balances', getBalances);
router.get('/orders/recent', getRecentOrders);
router.get('/users/count', getUsersCount);
router.get('/export/orders.csv', exportOrdersCSV);

// Messages HSMS
router.post('/messages', sendMessage);
router.get('/messages/history', getMessagesHistory);

// Notifications push
router.post('/push', sendPushNotification);

// Transferts fournisseurs (cashin Babimo)
router.post('/transfers', createTransfer);
router.get('/transfers/history', getTransfersHistory);

// Flyers (bandeau accueil mobile)
router.get('/flyers', getAllFlyers);
router.post('/flyers', createFlyer);
router.patch('/flyers/:id', updateFlyer);
router.delete('/flyers/:id', deleteFlyer);

// Mode maintenance
router.get('/maintenance', getMaintenanceMode);
router.post('/maintenance', setMaintenanceMode);

// Blocage opérateurs
router.get('/blocked-operators', getBlockedOperators);
router.post('/blocked-operators', setOperatorBlocked);

export default router;