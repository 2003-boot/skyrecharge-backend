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
    CHECK (refund_status IS NULL OR refund_status IN ('pending', 'completed', 'failed', 'manual_required')),
  refund_initiated_at TIMESTAMP,
  customer_message TEXT,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
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
    CHECK (recipient_type IN ('user', 'admin')),
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
CREATE INDEX IF NOT EXISTS idx_otp_codes_phone ON otp_codes(phone);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id, recipient_type);

-- =============================================
-- DONNÉES INITIALES
-- =============================================

-- Configuration par défaut
INSERT INTO config (key, value, description) VALUES
  ('credit_fixed_fee', '50', 'Frais fixes en FCFA pour le crédit de communication'),
  ('pass_fee_percent', '10', 'Pourcentage de frais sur les pass'),
  ('min_credit_amount', '200', 'Montant minimum de crédit en FCFA')
ON CONFLICT (key) DO NOTHING;