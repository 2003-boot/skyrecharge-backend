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
import { startBalanceMonitor, startDoubleLossMonitor } from './services/balance-monitor.service.js';
import { startStuckOrdersMonitor } from './services/stuck-orders-monitor.service.js';

const app = express();
const httpServer = createServer(app);

// Le backend tourne désormais derrière Nginx (reverse proxy) sur le VPS —
// il faut lui dire de faire confiance à l'en-tête X-Forwarded-For que
// Nginx transmet, sinon express-rate-limit ne peut pas identifier
// correctement l'IP réelle des clients (et lève une erreur de validation).
// "1" = on fait confiance au premier proxy en amont (notre Nginx local),
// pas à une chaîne de proxies arbitraire.
app.set('trust proxy', 1);

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

// Surveillance du solde des modems (alertes SMS fournisseurs)
startBalanceMonitor();
startDoubleLossMonitor();
startStuckOrdersMonitor();

export default app;