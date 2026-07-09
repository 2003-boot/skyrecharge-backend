import { Router } from 'express';
import {
  getDashboard,
  getAgents,
  getAgentDetail,
  createAgent,
  updateAgentBalance,
  updateAgentStatus,
  updateAgentScore,
  getOrders,
  retryOrder,
  refundOrder,
  getConfig,
  updateConfig,
  getAdminOffers,
  createOffer,
  updateOffer,
  getStats,
} from '../controllers/admin.controller.js';
import { authenticateAdmin } from '../middlewares/auth.js';

const router = Router();

router.use(authenticateAdmin);

// Dashboard & Stats
router.get('/dashboard', getDashboard);
router.get('/stats', getStats);

// Agents
router.get('/agents', getAgents);
router.get('/agents/:id', getAgentDetail);
router.post('/agents', createAgent);
router.patch('/agents/:id/balance', updateAgentBalance);
router.patch('/agents/:id/status', updateAgentStatus);
router.patch('/agents/:id/score', updateAgentScore);

// Commandes
router.get('/orders', getOrders);
router.patch('/orders/:id/retry', retryOrder);
router.patch('/orders/:id/refund', refundOrder);

// Configuration
router.get('/config', getConfig);
router.patch('/config', updateConfig);

// Offres opérateurs
router.get('/offers', getAdminOffers);
router.post('/offers', createOffer);
router.patch('/offers/:id', updateOffer);

export default router;