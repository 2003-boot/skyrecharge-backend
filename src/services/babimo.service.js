import axios from 'axios';
const BABIMO_BASE_URL = process.env.BABIMO_BASE_URL;
const BABIMO_EMAIL = process.env.BABIMO_EMAIL;
const BABIMO_PASSWORD = process.env.BABIMO_PASSWORD;
const REFERENCE_CL = process.env.BABIMO_REFERENCE_CL;

let cachedToken = null;
let tokenExpiry = null;

// Obtenir le token Babimo
const getToken = async () => {
  // Réutiliser le token si pas expiré
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const response = await axios.post(`${BABIMO_BASE_URL}/v1/oauth/login`, {
    email: BABIMO_EMAIL,
    password: BABIMO_PASSWORD,
  });

  cachedToken = response.data.authorisation.token;
  // Token valide 1 heure (3600s) - on le renouvelle après 50 minutes
  tokenExpiry = Date.now() + 50 * 60 * 1000;

  console.log('✅ Token Babimo obtenu');
  return cachedToken;
};

// Initier un paiement
export const initiatePayment = async ({
  orderId,
  amount,
  telephone,
  paymentMethod,
  successUrl,
  failedUrl,
  notifyUrl,
}) => {
  const token = await getToken();

  try {
    const payload = {
      currency: 'XOF',
      payment_method: paymentMethod,
      merchant_transaction_id: orderId,
      amount,
      telephone,
      success_url: successUrl,
      failed_url: failedUrl,
      notify_url: notifyUrl,
      refercence_cl: REFERENCE_CL,
    };

    console.log('📤 Payload Babimo:', JSON.stringify(payload, null, 2));
    console.log('🌐 URL:', `${BABIMO_BASE_URL}/v1/paiement`);

    const response = await axios.post(
      `${BABIMO_BASE_URL}/v1/paiement`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('💳 Réponse Babimo:', JSON.stringify(response.data, null, 2));
    return response.data.data;

  } catch (error) {
    console.error('❌ Erreur Babimo status:', error.response?.status);
    console.error('❌ Erreur Babimo data:', JSON.stringify(error.response?.data, null, 2));
    throw error;
  }
};

// Vérifier le statut d'un paiement
export const checkPaymentStatus = async (payToken) => {
  const token = await getToken();
  const response = await axios.get(
    `${BABIMO_BASE_URL}/v1/check-status/${payToken}`,
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  return response.data;
};

// Mapping moyen de paiement → méthode Babimo
export const PAYMENT_METHODS = {
  wave: 'WAVE_CI',
  orange_money: 'OM_CI',
  mtn_money: 'MTN_CI',
  moov_money: 'MOOV_CI',
};

// Vérifier si le paiement nécessite une redirection (Wave)
export const requiresRedirect = (paymentMethod) => {
  return paymentMethod === 'WAVE_CI';
};