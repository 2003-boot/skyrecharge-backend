-- =============================================
-- SKYRECHARGE - SCHEMA BASE DE DONNÉES
-- =============================================

-- Extension UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- TABLE: users (clients)
-- =============================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) UNIQUE NOT NULL,
  wave_number VARCHAR(20),
  fcm_token TEXT,
  pin_hash VARCHAR(255),
  notifications_enabled BOOLEAN DEFAULT TRUE,
  pin_enabled BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- TABLE: admins
-- =============================================
CREATE TABLE IF NOT EXISTS admins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- TABLE: agents
-- =============================================
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  fcm_token TEXT,
  balance INTEGER DEFAULT 0,
  score INTEGER DEFAULT 100,
  total_missions INTEGER DEFAULT 0,
  successful_missions INTEGER DEFAULT 0,
  failed_missions INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'blocked')),
  is_online BOOLEAN DEFAULT FALSE,
  commission_rate DECIMAL(5,2) DEFAULT 40.00,
  created_by UUID REFERENCES admins(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- TABLE: operator_offers (offres pass par opérateur)
-- =============================================
CREATE TABLE IF NOT EXISTS operator_offers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator VARCHAR(20) NOT NULL
    CHECK (operator IN ('MTN', 'Orange', 'Moov')),
  offer_type VARCHAR(20) NOT NULL
    CHECK (offer_type IN ('pass_minutes', 'pass_internet', 'pass_appel')),
  category VARCHAR(50),
  subcategory VARCHAR(50),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  validity VARCHAR(50),
  ussd_code TEXT,
  ussd_steps JSONB,
  is_active BOOLEAN DEFAULT TRUE,
  is_popular BOOLEAN DEFAULT FALSE,
  is_new BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- TABLE: orders (commandes clients)
-- =============================================
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  order_type VARCHAR(20) NOT NULL
    CHECK (order_type IN ('credit', 'pass_minutes', 'pass_appel', 'pass_internet')),
  beneficiary_phone VARCHAR(20) NOT NULL,
  beneficiary_name VARCHAR(100),
  is_self BOOLEAN DEFAULT TRUE,
  operator VARCHAR(20)
    CHECK (operator IN ('MTN', 'Orange', 'Moov')),
  offer_id UUID REFERENCES operator_offers(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  fees INTEGER NOT NULL,
  total_amount INTEGER NOT NULL,
  status VARCHAR(30) DEFAULT 'pending_payment'
    CHECK (status IN (
      'pending_payment',
      'queued',
      'assigned',
      'in_progress',
      'completed',
      'failed',
      'refunded'
    )),
  wave_transaction_id VARCHAR(255),
  wave_checkout_url TEXT,
  payment_method VARCHAR(30),
  payment_phone VARCHAR(20),
  merchant_transaction_id VARCHAR(255) UNIQUE,
  pay_token VARCHAR(255) UNIQUE,
  failure_reason TEXT,
  refund_pay_token VARCHAR(255) UNIQUE,
  refund_status VARCHAR(20)
    CHECK (refund_status IS NULL OR refund_status IN ('pending', 'completed', 'failed')),
  refund_initiated_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- TABLE: agent_missions
-- =============================================
CREATE TABLE IF NOT EXISTS agent_missions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'assigned',
      'accepted',
      'in_progress',
      'completed',
      'failed',
      'timeout',
      'refused'
    )),
  assigned_at TIMESTAMP DEFAULT NOW(),
  accepted_at TIMESTAMP,
  completed_at TIMESTAMP,
  deadline_at TIMESTAMP,
  processing_time_seconds INTEGER,
  attempt_number INTEGER DEFAULT 1,
  failure_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- TABLE: agent_score_history
-- =============================================
CREATE TABLE IF NOT EXISTS agent_score_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  mission_id UUID REFERENCES agent_missions(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  points INTEGER NOT NULL,
  score_before INTEGER NOT NULL,
  score_after INTEGER NOT NULL,
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- TABLE: agent_earnings
-- =============================================
CREATE TABLE IF NOT EXISTS agent_earnings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  mission_id UUID REFERENCES agent_missions(id) ON DELETE SET NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  bonus INTEGER DEFAULT 0,
  commission_rate DECIMAL(5,2) NOT NULL,
  period_week INTEGER,
  period_month INTEGER,
  period_year INTEGER,
  paid BOOLEAN DEFAULT FALSE,
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- TABLE: otp_codes
-- =============================================
CREATE TABLE IF NOT EXISTS otp_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone VARCHAR(20) NOT NULL,
  code VARCHAR(10) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  is_used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- TABLE: notifications
-- =============================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient_type VARCHAR(10) NOT NULL
    CHECK (recipient_type IN ('user', 'agent', 'admin')),
  recipient_id UUID NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  data JSONB,
  is_read BOOLEAN DEFAULT FALSE,
  sent_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- TABLE: config (paramètres globaux)
-- =============================================
CREATE TABLE IF NOT EXISTS config (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- INDEX pour les performances
-- =============================================
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_missions_order_id ON agent_missions(order_id);
CREATE INDEX IF NOT EXISTS idx_agent_missions_agent_id ON agent_missions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_missions_status ON agent_missions(status);
CREATE INDEX IF NOT EXISTS idx_agent_score_history_agent_id ON agent_score_history(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_earnings_agent_id ON agent_earnings(agent_id);
CREATE INDEX IF NOT EXISTS idx_otp_codes_phone ON otp_codes(phone);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id, recipient_type);

-- =============================================
-- DONNÉES INITIALES
-- =============================================

-- Configuration par défaut
INSERT INTO config (key, value, description) VALUES
  ('credit_fixed_fee', '50', 'Frais fixes en FCFA pour le crédit de communication'),
  ('pass_fee_percent', '10', 'Pourcentage de frais sur les pass'),
  ('agent_commission_rate', '40', 'Pourcentage de commission des agents (phase 1)'),
  ('min_credit_amount', '200', 'Montant minimum de crédit en FCFA'),
  ('mission_accept_timeout', '120', 'Délai en secondes pour accepter une mission'),
  ('mission_process_timeout', '180', 'Délai max en secondes pour traiter une mission'),
  ('score_threshold_suspend', '0', 'Score en dessous duquel l agent est suspendu'),
  ('score_fast_1min', '10', 'Points gagnés pour traitement en moins d 1 min'),
  ('score_fast_2min', '5', 'Points gagnés pour traitement entre 1 et 2 min'),
  ('score_fast_3min', '2', 'Points gagnés pour traitement entre 2 et 3 min'),
  ('score_penalty_error', '-20', 'Points perdus pour une erreur'),
  ('score_penalty_refuse', '-5', 'Points perdus pour un refus de mission'),
  ('score_penalty_timeout', '-5', 'Points perdus pour un timeout')
ON CONFLICT (key) DO NOTHING;