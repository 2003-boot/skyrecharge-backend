import { errorResponse } from '../utils/response.js';

export const errorHandler = (err, req, res, next) => {
  console.error('❌ Erreur:', err.message);
  console.error(err.stack);

  if (err.name === 'ValidationError') {
    return errorResponse(res, err.message, 400);
  }
  if (err.code === '23505') {
    return errorResponse(res, 'Cette valeur existe déjà', 409);
  }
  if (err.code === '23503') {
    return errorResponse(res, 'Référence invalide', 400);
  }

  return errorResponse(res, 'Erreur interne du serveur', 500);
};

export const notFound = (req, res) => {
  return errorResponse(res, `Route ${req.originalUrl} introuvable`, 404);
};