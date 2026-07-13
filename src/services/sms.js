import axios from 'axios';
import config from '../config/index.js';

const HSMS_BASE_URL = 'https://hsms.ci/api';

// Le token HSMS est "persistant" selon leur doc (réutilisable pour toutes
// les requêtes) — on le récupère une fois puis on le garde en mémoire,
// avec un renouvellement automatique en cas de 401 (token expiré/invalide).
let cachedToken = null;

const fetchToken = async () => {
  const response = await axios.post(`${HSMS_BASE_URL}/v2/sms/token/`, {
    email: config.hsms.email,
    password: config.hsms.password,
  });

  if (!response.data?.success || !response.data?.token) {
    throw new Error(`Échec obtention token HSMS: ${JSON.stringify(response.data)}`);
  }

  cachedToken = response.data.token;
  return cachedToken;
};

const getToken = async () => {
  if (cachedToken) return cachedToken;
  return await fetchToken();
};

const isConfigured = () =>
  !!(config.hsms.email && config.hsms.password && config.hsms.clientId && config.hsms.clientSecret);

// Envoie un SMS réel via HSMS (plateforme ivoirienne). Si les credentials
// ne sont pas configurés (HSMS_EMAIL/PASSWORD/CLIENT_ID/CLIENT_SECRET
// manquants), on retombe sur une simulation qui log le message — utile en
// dev, ou tant que le compte HSMS n'est pas encore prêt. Ce fallback ne
// dépend pas de NODE_ENV.
export const sendSMS = async (phone, message) => {
  if (!isConfigured()) {
    console.log(`📱 [SIMULÉ — HSMS non configuré] SMS vers ${phone}: ${message}`);
    return { success: true, simulated: true };
  }

  // HSMS attend le numéro avec l'indicatif pays mais SANS le "+"
  // (ex: "2250700000001"), alors que l'app stocke "+2250700000001".
  const telephone = phone.replace(/^\+/, '');

  const sendRequest = async (token) => {
    return axios.post(
      `${HSMS_BASE_URL}/v2/sms/send`,
      {
        clientid: config.hsms.clientId,
        clientsecret: config.hsms.clientSecret,
        message,
        telephone
        
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  };

  try {
    let token = await getToken();
    let response;

    try {
      response = await sendRequest(token);
    } catch (err) {
      // Token expiré/invalide → on en récupère un nouveau et on retente une fois
      if (err.response?.status === 401) {
        console.log('🔄 Token HSMS expiré, renouvellement...');
        token = await fetchToken();
        response = await sendRequest(token);
      } else {
        throw err;
      }
    }

    if (!response.data?.success) {
      console.error(`❌ Échec envoi SMS HSMS à ${phone}:`, JSON.stringify(response.data));
      return { success: false, error: response.data?.message || 'Échec envoi SMS', raw: response.data };
    }

    console.log(`✅ SMS envoyé à ${phone} (HSMS)`);
    return { success: true, simulated: false, raw: response.data };

  } catch (error) {
    const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    console.error(`❌ Erreur envoi SMS HSMS vers ${phone}:`, details);
    // On ne bloque pas l'inscription si le SMS échoue techniquement —
    // mais on logge fort pour ne pas rater le problème en prod.
    return { success: false, error: details };
  }
};

export const sendOTPSMS = async (phone, otp) => {
  const message = `Votre code de vérification SkyRecharge est : ${otp}. Valable 10 minutes. Ne le partagez pas.`;
  return await sendSMS(phone, message);
};