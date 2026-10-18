-- Datos de ejemplo de kyc_db (kyc-service). Escenario de demo compartido por todos
-- los microservicios (mismos UUID): Ana Pérez y Carlos Gómez, clientes de prueba,
-- y una cuenta de comercio. Datos inventados: no son personas ni documentos reales.
-- Cargar después del esquema:  psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
-- (si la base ya tiene estas filas, ON CONFLICT DO NOTHING las deja como están)

BEGIN;
-- Documento, fechas y teléfono van en claro: al arrancar, kyc-service corre
-- scripts/encrypt-kyc-fields.js, que los cifra con KYC_ENCRYPTION_KEY y llena los
-- índices ciegos (numero_documento_hash, telefono_hash).
INSERT INTO public.kyc_records (id, id_user, nombres, apellidos, tipo_documento, numero_documento, fecha_nacimiento, fecha_expedicion, email, telefono, status, created_at) VALUES
  ('3c000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Ana', 'Pérez', 'CC', '1000000001', '1995-03-10', '2013-04-01', 'ana.perez@banklite.test', '+573000000001', 'verified', '2026-10-01 08:55:00-05'),
  ('3c000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'Carlos', 'Gómez', 'CC', '1000000002', '1990-07-22', '2008-08-01', 'carlos.gomez@banklite.test', '+573000000002', 'verified', '2026-10-01 09:00:00-05')
ON CONFLICT DO NOTHING;

COMMIT;
