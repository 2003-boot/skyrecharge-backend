-- Migration : ajoute le statut 'cancelled' à la contrainte CHECK de orders.status
-- À exécuter une seule fois sur la base de prod (VPS), avec :
--   psql -U <user> -d <db> -f migration_add_cancelled_status.sql
--
-- 'orders_status_check' est le nom que Postgres génère par défaut pour une
-- contrainte CHECK inline non nommée (convention : {table}_{colonne}_check).
-- On vérifie d'abord que c'est bien ce nom-là avant de la supprimer, pour
-- ne rien casser si jamais elle a été renommée entre-temps.

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'orders'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%status%pending_payment%';

  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'Contrainte CHECK sur orders.status introuvable -- migration annulée, vérifier manuellement.';
  END IF;

  EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', constraint_name);

  ALTER TABLE orders ADD CONSTRAINT orders_status_check
    CHECK (status IN (
      'pending_payment',
      'queued',
      'in_progress',
      'completed',
      'failed',
      'refunded',
      'cancelled'
    ));

  RAISE NOTICE 'Migration OK : statut cancelled ajouté à orders.status.';
END $$;
