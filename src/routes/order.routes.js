import { Router } from 'express';
import {
  createOrder,
  initiatePayment,
  waveCallback,
  getOrder,
  getOrderHistory,
  getOffers,
  cancelUnpaidOrder,
} from '../controllers/order.controller.js';
import { authenticateUser } from '../middlewares/auth.js';

const router = Router();

router.get('/offers', authenticateUser, getOffers);
router.post('/', authenticateUser, createOrder);
router.get('/history', authenticateUser, getOrderHistory);
router.get('/:id', authenticateUser, getOrder);
router.post('/:id/pay', authenticateUser, initiatePayment);
router.post('/:id/cancel-timeout', authenticateUser, cancelUnpaidOrder);
router.post('/:id/wave-callback', waveCallback);

export default router;