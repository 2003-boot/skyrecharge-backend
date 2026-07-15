import db from '../config/database.js';
import { successResponse, errorResponse } from '../utils/response.js';

// Endpoint public (pas de données sensibles) — permet à l'app mobile
// d'afficher un aperçu de frais toujours synchronisé avec le taux réel
// appliqué côté serveur, plutôt qu'une valeur dupliquée en dur qui
// désynchronise silencieusement si le taux change un jour (cas vécu :
// FIXED_FEE=50 resté figé côté app après le passage à 10% côté backend).
// Sert aussi de point de contrôle pour le mode maintenance, vérifié au
// lancement de l'app avant même l'écran de login.
export const getPublicConfig = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT key, value FROM config WHERE key IN ('app_fee_percent', 'maintenance_mode', 'blocked_operators')`
    );
    const values = {};
    result.rows.forEach(row => { values[row.key] = row.value; });

    const appFeePercent = parseFloat(values.app_fee_percent);
    let blockedOperators = [];
    try {
      blockedOperators = values.blocked_operators ? JSON.parse(values.blocked_operators) : [];
    } catch {
      blockedOperators = [];
    }

    return successResponse(res, {
      app_fee_percent: Number.isFinite(appFeePercent) ? appFeePercent : 10,
      maintenance_mode: values.maintenance_mode === 'true',
      blocked_operators: blockedOperators,
    }, 'Configuration publique récupérée');
  } catch (error) {
    console.error('Erreur getPublicConfig:', error);
    // Toujours renvoyer une valeur exploitable — l'app mobile ne doit
    // jamais planter son calcul d'aperçu à cause de cet endpoint. Pour la
    // maintenance en particulier : en cas d'erreur, on suppose qu'elle est
    // DÉSACTIVÉE plutôt que d'y bloquer tout le monde par accident. Même
    // logique pour les opérateurs : aucun bloqué par défaut en cas d'échec,
    // plutôt que de bloquer tout le monde arbitrairement.
    return successResponse(res, {
      app_fee_percent: 10,
      maintenance_mode: false,
      blocked_operators: [],
    }, 'Configuration par défaut (secours)');
  }
};