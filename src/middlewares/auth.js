import { verifyAccessToken } from '../utils/jwt.js';
import { errorResponse } from '../utils/response.js';
import db from '../config/database.js';

export const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse(res, 'Token manquant', 401);
    }
    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);
    const result = await db.query(
      'SELECT id, first_name, phone, is_active FROM users WHERE id = $1',
      [decoded.id]
    );
    if (!result.rows[0] || !result.rows[0].is_active) {
      return errorResponse(res, 'Utilisateur introuvable ou inactif', 401);
    }
    req.user = result.rows[0];
    // Propagé depuis le token, pas depuis la base -- voir le commentaire
    // sur viaOtp dans verifyOTP (auth.controller.js) pour le pourquoi.
    req.user.viaOtp = decoded.viaOtp === true;
    next();
  } catch (error) {
    return errorResponse(res, 'Token invalide ou expiré', 401);
  }
};

export const authenticateAgent = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse(res, 'Token manquant', 401);
    }
    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);
    if (decoded.role !== 'agent') {
      return errorResponse(res, 'Accès refusé', 403);
    }
    const result = await db.query(
      'SELECT id, name, phone, balance, score, status FROM agents WHERE id = $1',
      [decoded.id]
    );
    const agent = result.rows[0];
    if (!agent) return errorResponse(res, 'Agent introuvable', 401);
    if (agent.status === 'blocked') return errorResponse(res, 'Compte bloqué définitivement', 403);
    if (agent.status === 'suspended') return errorResponse(res, 'Compte suspendu', 403);
    req.agent = agent;
    next();
  } catch (error) {
    return errorResponse(res, 'Token invalide ou expiré', 401);
  }
};

export const authenticateAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse(res, 'Token manquant', 401);
    }
    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);
    if (decoded.role !== 'admin') {
      return errorResponse(res, 'Accès refusé', 403);
    }
    const result = await db.query(
      'SELECT id, name, email, is_active FROM admins WHERE id = $1',
      [decoded.id]
    );
    if (!result.rows[0] || !result.rows[0].is_active) {
      return errorResponse(res, 'Admin introuvable ou inactif', 401);
    }
    req.admin = result.rows[0];
    next();
  } catch (error) {
    return errorResponse(res, 'Token invalide ou expiré', 401);
  }
};