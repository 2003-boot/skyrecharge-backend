import { Router } from 'express';
import authRoutes from './auth.routes.js';
import orderRoutes from './order.routes.js';
import userRoutes from './user.routes.js';
import paymentRoutes from './payment.routes.js';

const router = Router();

// Health check
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'SkyRecharge API opérationnelle',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

//Routes
router.use('/auth', authRoutes);
router.use('/orders', orderRoutes);
router.use('/users', userRoutes);
router.use('/payments', paymentRoutes);

export default router;