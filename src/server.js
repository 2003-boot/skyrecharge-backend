import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createServer } from 'http';
import { Server } from 'socket.io';

import config from './config/index.js';
import routes from './routes/index.js';
import { errorHandler, notFound } from './middlewares/errorHandler.js';
import { apiLimiter } from './middlewares/rateLimiter.js';
import { processQueuedOrders } from './services/queue.service.js';

const app = express();
const httpServer = createServer(app);

// Socket.io (dashboard admin temps réel)
export const io = new Server(httpServer, {
  cors: {
    origin: process.env.ADMIN_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  console.log(`🔌 Client connecté: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`🔌 Client déconnecté: ${socket.id}`);
  });
});

// Middlewares globaux
app.use(helmet());
app.use(cors({
  origin: '*', 
  credentials: false,
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api', apiLimiter);

// Routes
app.use('/api', routes);

// Gestion des erreurs
app.use(notFound);
app.use(errorHandler);

// Démarrage
httpServer.listen(config.port, () => {
  console.log('================================');
  console.log(`🚀 SkyRecharge API démarrée`);
  console.log(`📡 Port: ${config.port}`);
  console.log(`🌍 Env: ${config.nodeEnv}`);
  console.log('================================');
});

// Traiter les commandes en attente au démarrage
setTimeout(processQueuedOrders, 2000);

export default app;