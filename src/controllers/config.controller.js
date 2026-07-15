import db from '../config/database.js';
import { successResponse, errorResponse } from '../utils/response.js';

// Endpoint public (pas de données sensibles) — permet à l'app mobile
// d'afficher un aperçu de frais toujours synchronisé avec le taux réel
// appliqué côté serveur, plutôt qu'une valeur dupliquée en dur qui
// désynchronise silencieusement si le taux change un jour (cas vécu :
// FIXED_FEE=50 resté figé côté app après le passage à 10% côté backend).
export const getPublicConfig = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT value FROM config WHERE key = 'app_fee_percent'`
    );
    const appFeePercent = parseFloat(result.rows[0]?.value);

    return successResponse(res, {
      app_fee_percent: Number.isFinite(appFeePercent) ? appFeePercent : 10,
    }, 'Configuration publique récupérée');
  } catch (error) {
    console.error('Erreur getPublicConfig:', error);
    // Toujours renvoyer une valeur exploitable — l'app mobile ne doit
    // jamais planter son calcul d'aperçu à cause de cet endpoint.
    return successResponse(res, { app_fee_percent: 10 }, 'Configuration par défaut (secours)');
  }
};